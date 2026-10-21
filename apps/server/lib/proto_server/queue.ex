defmodule ProtoServer.Queue do
  @moduledoc """
  Per-peer serialization of content fetches with a global concurrency limit.

  Jobs for the same peer run one at a time (bitswap serves one transfer per
  connection in order, so parallel transfers would starve), while different
  peers can run concurrently up to `:max_concurrent_verify`. Queued jobs keep
  notifying their client with a heartbeat so that the uploader keeps serving
  blocks.
  """

  use GenServer

  require Logger

  @default_max_concurrent 4
  @default_max_pending 16
  @default_heartbeat_ms 10_000

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec enqueue(binary(), (-> term()), map()) :: :ok | :full
  def enqueue(peer, fun, callbacks) when is_function(fun, 0) do
    GenServer.call(__MODULE__, {:enqueue, peer, fun, callbacks})
  end

  @spec cancel_pending(binary()) :: :ok
  def cancel_pending(peer), do: GenServer.call(__MODULE__, {:cancel_pending, peer})

  @impl true
  def init(_opts) do
    {:ok,
     %{
       active: %{},
       pending: %{},
       order: :queue.new(),
       active_count: 0,
       max_concurrent: positive_config(:max_concurrent_verify, @default_max_concurrent),
       max_pending: non_negative_config(:max_pending_per_peer, @default_max_pending)
     }}
  end

  @impl true
  def handle_call({:enqueue, peer, fun, callbacks}, _from, state) do
    pending_for_peer =
      Enum.count(state.pending, fn {_ref, job} -> job.peer == peer end)

    if pending_for_peer >= state.max_pending do
      {:reply, :full, state}
    else
      job = %{
        peer: peer,
        fun: fun,
        callbacks: callbacks || %{},
        ref: make_ref(),
        heartbeat: nil
      }

      state =
        if not Map.has_key?(state.active, peer) and
             state.active_count < state.max_concurrent do
          start_job(state, job)
        else
          queue_job(state, job)
        end

      {:reply, :ok, state}
    end
  end

  def handle_call({:cancel_pending, peer}, _from, state) do
    {cancelled, kept} =
      state.order
      |> :queue.to_list()
      |> Enum.split_with(fn ref ->
        case Map.fetch(state.pending, ref) do
          {:ok, job} -> job.peer == peer
          :error -> false
        end
      end)

    pending =
      Enum.reduce(cancelled, state.pending, fn ref, pending ->
        case Map.pop(pending, ref) do
          {nil, pending} ->
            pending

          {job, pending} ->
            cancel_heartbeat(job)
            run_callback(job.callbacks, :on_cancel)
            pending
        end
      end)

    {:reply, :ok,
     %{
       state
       | pending: pending,
         order: :queue.from_list(kept)
     }}
  end

  @impl true
  def handle_info({:queue_done, ref, result}, state) do
    case find_active_by_ref(state.active, ref) do
      {:ok, peer, entry} ->
        Process.demonitor(entry.monitor, [:flush])
        {:noreply, finish_job(state, peer, entry.job, result)}

      :error ->
        {:noreply, state}
    end
  end

  def handle_info({:DOWN, _monitor, :process, pid, reason}, state) do
    case find_active_by_pid(state.active, pid) do
      {:ok, peer, entry} ->
        Logger.warning("[queue] worker for #{inspect(peer)} crashed: #{inspect(reason)}")

        {:noreply, finish_job(state, peer, entry.job, {:error, :worker_crashed})}

      :error ->
        {:noreply, state}
    end
  end

  def handle_info({:queue_heartbeat, ref}, state) do
    case Map.fetch(state.pending, ref) do
      {:ok, job} ->
        run_callback(job.callbacks, :queued)
        timer = Process.send_after(self(), {:queue_heartbeat, ref}, heartbeat_ms())
        pending = Map.put(state.pending, ref, %{job | heartbeat: timer})
        {:noreply, %{state | pending: pending}}

      :error ->
        {:noreply, state}
    end
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp start_job(state, job) do
    run_callback(job.callbacks, :on_start)
    parent = self()
    fun = job.fun
    ref = job.ref

    {pid, monitor} =
      spawn_monitor(fn ->
        result =
          try do
            fun.()
          rescue
            error ->
              Logger.warning(
                "[queue] job for #{inspect(job.peer)} failed: #{Exception.message(error)}"
              )

              {:error, :worker_crashed}
          catch
            kind, reason ->
              Logger.warning(
                "[queue] job for #{inspect(job.peer)} failed: #{inspect({kind, reason})}"
              )

              {:error, :worker_crashed}
          end

        send(parent, {:queue_done, ref, result})
      end)

    active_entry = %{ref: job.ref, pid: pid, monitor: monitor, job: job}

    %{
      state
      | active: Map.put(state.active, job.peer, active_entry),
        active_count: state.active_count + 1
    }
  end

  defp queue_job(state, job) do
    run_callback(job.callbacks, :queued)
    timer = Process.send_after(self(), {:queue_heartbeat, job.ref}, heartbeat_ms())
    job = %{job | heartbeat: timer}

    %{
      state
      | pending: Map.put(state.pending, job.ref, job),
        order: :queue.in(job.ref, state.order)
    }
  end

  defp finish_job(state, peer, job, result) do
    cancel_heartbeat(job)
    run_callback(job.callbacks, :done, result)

    state = %{
      state
      | active: Map.delete(state.active, peer),
        active_count: max(state.active_count - 1, 0)
    }

    start_next(state, peer)
  end

  defp start_next(state, finished_peer) do
    same_peer =
      find_ref(state, fn job -> job.peer == finished_peer end)

    case same_peer do
      {:ok, ref} ->
        start_queued(state, ref)

      :error ->
        case find_ref(state, fn job -> not Map.has_key?(state.active, job.peer) end) do
          {:ok, ref} -> start_queued(state, ref)
          :error -> state
        end
    end
  end

  defp find_ref(state, predicate) do
    state.order
    |> :queue.to_list()
    |> Enum.find_value(fn ref ->
      case Map.fetch(state.pending, ref) do
        {:ok, job} -> if predicate.(job), do: ref, else: nil
        :error -> nil
      end
    end)
    |> case do
      nil -> :error
      ref -> {:ok, ref}
    end
  end

  defp start_queued(state, ref) do
    case Map.pop(state.pending, ref) do
      {nil, _pending} ->
        state

      {job, pending} ->
        cancel_heartbeat(job)
        order = state.order |> :queue.to_list() |> List.delete(ref) |> :queue.from_list()
        state = %{state | pending: pending, order: order}
        start_job(state, %{job | heartbeat: nil})
    end
  end

  defp cancel_heartbeat(%{heartbeat: nil}), do: :ok

  defp cancel_heartbeat(%{heartbeat: timer}) do
    Process.cancel_timer(timer)
    :ok
  end

  defp find_active_by_ref(active, ref) do
    Enum.find_value(active, :error, fn {peer, entry} ->
      if entry.ref == ref, do: {:ok, peer, entry}, else: nil
    end)
  end

  defp find_active_by_pid(active, pid) do
    Enum.find_value(active, :error, fn {peer, entry} ->
      if entry.pid == pid, do: {:ok, peer, entry}, else: nil
    end)
  end

  defp run_callback(callbacks, key, argument \\ :none) do
    callback = Map.get(callbacks, key)

    cond do
      key == :done and is_function(callback, 1) ->
        safe_call(fn -> callback.(argument) end)

      key != :done and is_function(callback, 0) ->
        safe_call(callback)

      true ->
        :ok
    end
  end

  defp safe_call(fun) do
    try do
      fun.()
    rescue
      error ->
        Logger.warning("[queue] callback failed: #{Exception.message(error)}")
        :ok
    catch
      kind, reason ->
        Logger.warning("[queue] callback failed: #{inspect({kind, reason})}")
        :ok
    end
  end

  defp heartbeat_ms do
    case Application.get_env(:proto_server, :queue_heartbeat_ms, @default_heartbeat_ms) do
      value when is_integer(value) and value > 0 -> value
      _ -> @default_heartbeat_ms
    end
  end

  defp positive_config(key, default) do
    case ProtoServer.Config.get(key) do
      value when is_integer(value) and value > 0 -> value
      _ -> default
    end
  end

  defp non_negative_config(key, default) do
    case ProtoServer.Config.get(key) do
      value when is_integer(value) and value >= 0 -> value
      _ -> default
    end
  end
end
