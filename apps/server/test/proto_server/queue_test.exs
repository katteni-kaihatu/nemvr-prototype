defmodule ProtoServer.QueueTest do
  use ExUnit.Case, async: false

  alias ProtoServer.Queue

  setup do
    keys = [:max_concurrent_verify, :max_pending_per_peer, :queue_heartbeat_ms]
    previous = Enum.map(keys, fn key -> {key, Application.get_env(:proto_server, key)} end)

    on_exit(fn ->
      Enum.each(previous, fn
        {key, nil} -> Application.delete_env(:proto_server, key)
        {key, value} -> Application.put_env(:proto_server, key, value)
      end)
    end)

    :ok
  end

  test "starts at most max_concurrent jobs globally" do
    start_queue(concurrent: 1)
    parent = self()

    first = fn ->
      send(parent, {:started, :first, self()})

      receive do
        :finish -> :ok
      after
        5_000 -> :ok
      end
    end

    second = fn -> send(parent, {:started, :second, self()}) end

    assert :ok == Queue.enqueue("peer-a", first, %{})
    assert_receive {:started, :first, first_pid}, 500

    assert :ok == Queue.enqueue("peer-b", second, %{})
    refute_receive {:started, :second, _}, 100

    send(first_pid, :finish)
    assert_receive {:started, :second, _}, 500
  end

  test "serializes jobs for the same peer" do
    start_queue(concurrent: 4)
    parent = self()

    first = fn ->
      send(parent, {:started, :first, self()})

      receive do
        :finish -> :ok
      after
        5_000 -> :ok
      end
    end

    second = fn -> send(parent, {:started, :second, self()}) end

    assert :ok == Queue.enqueue("peer-a", first, %{})
    assert :ok == Queue.enqueue("peer-a", second, %{})
    assert_receive {:started, :first, first_pid}, 500
    refute_receive {:started, :second, _}, 100

    send(first_pid, :finish)
    assert_receive {:started, :second, _}, 500
  end

  test "starts the oldest queued job whose peer is not active" do
    start_queue(concurrent: 1)
    parent = self()

    blocker = fn ->
      send(parent, {:started, :a, self()})

      receive do
        :finish -> :ok
      after
        5_000 -> :ok
      end
    end

    job = fn label ->
      fn ->
        send(parent, {:started, label, self()})

        receive do
          :finish -> :ok
        after
          5_000 -> :ok
        end
      end
    end

    assert :ok == Queue.enqueue("peer-a", blocker, %{})
    assert_receive {:started, :a, a_pid}, 500

    assert :ok == Queue.enqueue("peer-b", job.(:b), %{})
    assert :ok == Queue.enqueue("peer-c", job.(:c), %{})

    send(a_pid, :finish)
    assert_receive {:started, :b, b_pid}, 500
    refute_receive {:started, :c, _}, 100

    send(b_pid, :finish)
    assert_receive {:started, :c, _c_pid}, 500
  end

  test "returns :full at max_pending_per_peer" do
    start_queue(concurrent: 1, pending: 1)
    parent = self()

    blocker = fn ->
      send(parent, {:started, :active, self()})

      receive do
        :finish -> :ok
      after
        5_000 -> :ok
      end
    end

    queued = fn -> send(parent, {:started, :queued}) end

    assert :ok == Queue.enqueue("peer-a", blocker, %{})
    assert_receive {:started, :active, active_pid}, 500

    assert :ok == Queue.enqueue("peer-a", queued, %{})
    assert :full == Queue.enqueue("peer-a", fn -> :ok end, %{})

    send(active_pid, :finish)
    assert_receive {:started, :queued}, 500
  end

  test "cancel_pending removes queued jobs and calls on_cancel" do
    start_queue(concurrent: 1)
    parent = self()

    blocker = fn ->
      send(parent, {:started, :active, self()})

      receive do
        :finish -> :ok
      after
        5_000 -> :ok
      end
    end

    queued = fn -> send(parent, {:started, :cancelled}) end

    callbacks = %{on_cancel: fn -> send(parent, :on_cancel) end}

    assert :ok == Queue.enqueue("peer-a", blocker, %{})
    assert_receive {:started, :active, active_pid}, 500

    assert :ok == Queue.enqueue("peer-a", queued, callbacks)
    assert :ok == Queue.cancel_pending("peer-a")

    assert_receive :on_cancel, 500
    refute_receive {:started, :cancelled}, 100

    # The running job is not cancelled.
    send(active_pid, :finish)
    assert Process.alive?(Process.whereis(Queue))
  end

  test "heartbeats queued jobs while they wait" do
    start_queue(concurrent: 1, heartbeat: 20)
    parent = self()

    blocker = fn ->
      send(parent, {:started, :active, self()})

      receive do
        :finish -> :ok
      after
        5_000 -> :ok
      end
    end

    callbacks = %{queued: fn -> send(parent, :queued) end}

    assert :ok == Queue.enqueue("peer-a", blocker, %{})
    assert_receive {:started, :active, active_pid}, 500

    assert :ok == Queue.enqueue("peer-a", fn -> :ok end, callbacks)
    assert_receive :queued, 100
    assert_receive :queued, 200
    assert_receive :queued, 200

    assert :ok == Queue.cancel_pending("peer-a")
    send(active_pid, :finish)
  end

  test "reports worker crashes as {:error, :worker_crashed}" do
    start_queue(concurrent: 1)
    parent = self()

    callbacks = %{done: fn result -> send(parent, {:done, result}) end}

    assert :ok == Queue.enqueue("peer-a", fn -> raise "boom" end, callbacks)
    assert_receive {:done, {:error, :worker_crashed}}, 500
  end

  defp start_queue(opts) do
    Application.put_env(
      :proto_server,
      :max_concurrent_verify,
      Keyword.get(opts, :concurrent, 4)
    )

    Application.put_env(
      :proto_server,
      :max_pending_per_peer,
      Keyword.get(opts, :pending, 16)
    )

    Application.put_env(
      :proto_server,
      :queue_heartbeat_ms,
      Keyword.get(opts, :heartbeat, 20)
    )

    start_supervised!(ProtoServer.Queue)
  end
end
