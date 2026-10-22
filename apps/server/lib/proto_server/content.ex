defmodule ProtoServer.Content do
  @moduledoc """
  Reference-counted content accounting for pinned Kubo blocks.

  The process only keeps bookkeeping: size, the first bytes of each CID and the
  number of world objects referring to it. Fetching and pinning happen in
  `ProtoServer.Place` before `acquire/5` is called, so this process never blocks
  on network I/O.
  """

  use GenServer

  require Logger

  alias ProtoServer.{Config, Ipfs, Media}

  @image_max_bytes 24 * 1024 * 1024
  @file_max_bytes 2 * 1024 * 1024 * 1024
  @avatar_max_bytes 64 * 1024 * 1024
  @gc_delay_ms 1_000
  @settle_timeout_ms 5_000

  @type kind :: :image | :file | :avatar
  @type info :: %{size: integer(), head: binary()}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec limits(kind()) :: %{max_bytes: integer(), too_large_message: binary()}
  def limits(:image) do
    %{
      max_bytes: @image_max_bytes,
      too_large_message: "画像が大きすぎます (上限 #{Media.format_bytes(@image_max_bytes)})"
    }
  end

  def limits(:file) do
    %{
      max_bytes: @file_max_bytes,
      too_large_message: "ファイルが大きすぎます (上限 #{Media.format_bytes(@file_max_bytes)})"
    }
  end

  def limits(:avatar) do
    %{
      max_bytes: @avatar_max_bytes,
      too_large_message: "アバターが大きすぎます (上限 #{Media.format_bytes(@avatar_max_bytes)})"
    }
  end

  @spec check(kind(), integer(), binary()) :: :ok | {:error, binary()}
  def check(kind, size, head) do
    limits = limits(kind)

    cond do
      not is_integer(size) or size < 0 ->
        {:error, limits.too_large_message}

      size > limits.max_bytes ->
        {:error, limits.too_large_message}

      kind == :image and Media.sniff_image_type(head) == nil ->
        {:error, "対応していない画像形式です (PNG / JPEG / GIF / WebP)"}

      true ->
        :ok
    end
  end

  @spec known(binary()) :: {:ok, info()} | :error
  def known(cid), do: GenServer.call(__MODULE__, {:known, cid})

  @spec reserve(non_neg_integer()) :: {:ok, reference()} | {:error, binary()}
  def reserve(size), do: GenServer.call(__MODULE__, {:reserve, size})

  @spec unreserve(reference() | nil) :: :ok
  def unreserve(ref), do: GenServer.call(__MODULE__, {:unreserve, ref})

  @spec acquire(binary(), kind(), integer(), binary(), reference() | nil) ::
          {:ok, info()} | {:error, binary()}
  def acquire(cid, kind, size, head, ref) do
    case check(kind, size, head) do
      :ok ->
        GenServer.call(__MODULE__, {:acquire, cid, kind, size, head, ref})

      {:error, message} ->
        unreserve(ref)
        {:error, message}
    end
  end

  @spec retain(binary()) :: :ok
  def retain(cid), do: GenServer.call(__MODULE__, {:retain, cid})

  @spec release(binary()) :: :ok
  def release(cid), do: GenServer.call(__MODULE__, {:release, cid})

  @spec total_bytes() :: integer()
  def total_bytes, do: GenServer.call(__MODULE__, :total_bytes)

  @spec count() :: integer()
  def count, do: GenServer.call(__MODULE__, :count)

  @spec settle() :: :ok
  def settle, do: GenServer.call(__MODULE__, :settle, 60_000)

  @impl true
  def init(_opts) do
    max_total =
      case Config.get(:content_max_total_mb) do
        value when is_integer(value) and value >= 0 -> value * 1024 * 1024
        _ -> 0
      end

    {:ok,
     %{
       entries: %{},
       total: 0,
       reserved: %{},
       gc_timer: nil,
       gc_pending: false,
       unpin_tasks: %{},
       max_total: max_total
     }}
  end

  @impl true
  def handle_call({:known, cid}, _from, state) do
    case Map.fetch(state.entries, cid) do
      {:ok, %{size: size, head: head}} -> {:reply, {:ok, %{size: size, head: head}}, state}
      :error -> {:reply, :error, state}
    end
  end

  def handle_call({:reserve, size}, _from, state) when is_integer(size) and size >= 0 do
    reserved_total = state.reserved |> Map.values() |> Enum.sum()

    if state.total + reserved_total + size <= state.max_total do
      ref = make_ref()
      {:reply, {:ok, ref}, %{state | reserved: Map.put(state.reserved, ref, size)}}
    else
      {:reply, {:error, capacity_message(state.max_total)}, state}
    end
  end

  def handle_call({:reserve, _size}, _from, state) do
    {:reply, {:error, capacity_message(state.max_total)}, state}
  end

  def handle_call({:unreserve, ref}, _from, state) do
    {:reply, :ok, %{state | reserved: Map.delete(state.reserved, ref)}}
  end

  def handle_call({:acquire, cid, _kind, size, head, ref}, _from, state) do
    state = unreserve_ref(state, ref)

    case Map.fetch(state.entries, cid) do
      {:ok, entry} ->
        entry = %{entry | refs: entry.refs + 1}
        entries = Map.put(state.entries, cid, entry)

        {:reply, {:ok, %{size: entry.size, head: entry.head}}, %{state | entries: entries}}

      :error ->
        if state.total + size <= state.max_total do
          entry = %{size: size, head: head, refs: 1}
          entries = Map.put(state.entries, cid, entry)

          {:reply, {:ok, %{size: size, head: head}},
           %{state | entries: entries, total: state.total + size}}
        else
          {:reply, {:error, capacity_message(state.max_total)}, state}
        end
    end
  end

  def handle_call({:retain, cid}, _from, state) do
    entries =
      case Map.fetch(state.entries, cid) do
        {:ok, entry} -> Map.put(state.entries, cid, %{entry | refs: entry.refs + 1})
        :error -> state.entries
      end

    {:reply, :ok, %{state | entries: entries}}
  end

  def handle_call({:release, cid}, _from, state) do
    case Map.fetch(state.entries, cid) do
      :error ->
        {:reply, :ok, state}

      {:ok, %{refs: refs} = entry} when refs > 1 ->
        entries = Map.put(state.entries, cid, %{entry | refs: refs - 1})
        {:reply, :ok, %{state | entries: entries}}

      {:ok, entry} ->
        state = %{
          state
          | entries: Map.delete(state.entries, cid),
            total: max(state.total - entry.size, 0)
        }

        state = start_unpin(cid, state)
        state = schedule_gc(state)

        Logger.info(
          "[content] released #{cid} (#{Media.format_bytes(entry.size)}); " <>
            "holding #{Media.format_bytes(state.total)} in #{map_size(state.entries)} item(s)"
        )

        {:reply, :ok, state}
    end
  end

  def handle_call(:total_bytes, _from, state), do: {:reply, state.total, state}

  def handle_call(:count, _from, state), do: {:reply, map_size(state.entries), state}

  def handle_call(:settle, _from, state) do
    state = cancel_gc_timer(state)
    state = wait_for_unpins(state, now_ms() + @settle_timeout_ms)
    run_gc()
    {:reply, :ok, %{state | gc_pending: false}}
  end

  @impl true
  def handle_info(:gc, state) do
    state = %{state | gc_timer: nil}

    if map_size(state.unpin_tasks) == 0 do
      start_gc()
      {:noreply, %{state | gc_pending: false}}
    else
      {:noreply, %{state | gc_pending: true}}
    end
  end

  def handle_info({:DOWN, _monitor, :process, pid, _reason}, state) do
    unpin_tasks = Map.delete(state.unpin_tasks, pid)
    state = %{state | unpin_tasks: unpin_tasks}

    if map_size(unpin_tasks) == 0 and state.gc_pending do
      start_gc()
      {:noreply, %{state | gc_pending: false}}
    else
      {:noreply, state}
    end
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp capacity_message(max_total) do
    "サーバーの保存容量の上限に達しました (#{Media.format_bytes(max_total)})。不要なものを削除してください"
  end

  defp unreserve_ref(state, nil), do: state

  defp unreserve_ref(state, ref) do
    %{state | reserved: Map.delete(state.reserved, ref)}
  end

  defp start_unpin(cid, state) do
    fun = fn ->
      if Process.whereis(Ipfs) != nil do
        try do
          case Ipfs.unpin(cid) do
            :ok ->
              :ok

            {:error, reason} ->
              Logger.warning("[content] unpin failed for #{cid}: #{inspect(reason)}")
          end
        rescue
          error -> Logger.warning("[content] unpin failed for #{cid}: #{inspect(error)}")
        catch
          kind, reason ->
            Logger.warning("[content] unpin failed for #{cid}: #{inspect({kind, reason})}")
        end
      end
    end

    case start_task(fun) do
      {:ok, pid} ->
        monitor = Process.monitor(pid)
        %{state | unpin_tasks: Map.put(state.unpin_tasks, pid, monitor)}

      :error ->
        state
    end
  end

  defp schedule_gc(state) do
    state = cancel_gc_timer(state)
    timer = Process.send_after(self(), :gc, @gc_delay_ms)
    %{state | gc_timer: timer}
  end

  defp cancel_gc_timer(%{gc_timer: nil} = state), do: state

  defp cancel_gc_timer(state) do
    Process.cancel_timer(state.gc_timer)
    %{state | gc_timer: nil}
  end

  defp start_gc do
    fun = fn -> run_gc() end

    case start_task(fun) do
      {:ok, _pid} -> :ok
      :error -> :ok
    end
  end

  defp run_gc do
    if Process.whereis(Ipfs) != nil do
      try do
        case Ipfs.gc() do
          :ok -> :ok
          {:error, reason} -> Logger.warning("[content] gc failed: #{inspect(reason)}")
        end
      rescue
        error -> Logger.warning("[content] gc failed: #{inspect(error)}")
      catch
        kind, reason -> Logger.warning("[content] gc failed: #{inspect({kind, reason})}")
      end
    end

    :ok
  end

  defp start_task(fun) do
    case Process.whereis(ProtoServer.TaskSupervisor) do
      nil ->
        case Task.start(fun) do
          {:ok, pid} -> {:ok, pid}
          _ -> :error
        end

      _pid ->
        try do
          case Task.Supervisor.start_child(ProtoServer.TaskSupervisor, fun) do
            {:ok, pid} -> {:ok, pid}
            _ -> :error
          end
        rescue
          _ -> :error
        catch
          _, _ -> :error
        end
    end
  end

  defp wait_for_unpins(state, deadline) do
    if map_size(state.unpin_tasks) == 0 do
      state
    else
      alive =
        state.unpin_tasks
        |> Map.keys()
        |> Enum.reject(&(not Process.alive?(&1)))

      unpin_tasks = Map.take(state.unpin_tasks, alive)
      state = %{state | unpin_tasks: unpin_tasks}

      cond do
        map_size(unpin_tasks) == 0 ->
          state

        now_ms() >= deadline ->
          state

        true ->
          Process.sleep(20)
          wait_for_unpins(state, deadline)
      end
    end
  end

  defp now_ms, do: System.monotonic_time(:millisecond)
end
