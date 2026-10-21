defmodule ProtoServer.Place do
  @moduledoc """
  Placement orchestration for images, files, URL imports and avatars.

  Fetches run in `ProtoServer.Queue` jobs (one at a time per peer) and are
  tracked by `ProtoServer.Content`. Large files are placed immediately and
  fetched in the background (`stage_file/2`); downloaders can join the same
  staging job with `request_file/2`.
  """

  use GenServer

  require Logger

  alias ProtoServer.{Content, Ipfs, Media, Queue, Room, UrlFetch}

  @eager_file_max_bytes 16 * 1024 * 1024
  @progress_interval_ms 10_000
  @sniff_bytes 16

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec place_image(binary(), map()) :: :ok
  def place_image(peer, place), do: GenServer.cast(__MODULE__, {:place_image, peer, place})

  @spec place_file(binary(), map()) :: :ok
  def place_file(peer, place), do: GenServer.cast(__MODULE__, {:place_file, peer, place})

  @spec place_url(binary(), map()) :: :ok
  def place_url(peer, place), do: GenServer.cast(__MODULE__, {:place_url, peer, place})

  @spec set_avatar(binary(), binary() | nil) :: :ok
  def set_avatar(peer, cid), do: GenServer.cast(__MODULE__, {:set_avatar, peer, cid})

  @spec request_file(binary(), binary()) :: :ok
  def request_file(peer, object_id),
    do: GenServer.cast(__MODULE__, {:request_file, peer, object_id})

  @spec cancel_peer(binary()) :: :ok
  def cancel_peer(peer), do: GenServer.cast(__MODULE__, {:cancel_peer, peer})

  @spec release_avatars(binary()) :: :ok
  def release_avatars(peer), do: GenServer.cast(__MODULE__, {:release_avatars, peer})

  @doc """
  Start (or join) the background fetch for a large file.

  Called from queue workers after the object has been placed, and from
  `request_file/2`. Joining an existing CID only adds the requester to the
  waiters list.
  """
  @spec stage_file(binary() | nil, map()) :: :ok
  def stage_file(requester, object) do
    GenServer.call(__MODULE__, {:stage_file, requester, object})
  end

  @impl true
  def init(_opts) do
    {:ok, %{staging: %{}, avatars: %{}}}
  end

  @impl true
  def handle_cast({:place_image, peer, place}, state) do
    do_place_image(peer, place)
    {:noreply, state}
  end

  def handle_cast({:place_file, peer, place}, state) do
    do_place_file(peer, place)
    {:noreply, state}
  end

  def handle_cast({:place_url, peer, place}, state) do
    do_place_url(peer, place)
    {:noreply, state}
  end

  def handle_cast({:set_avatar, peer, cid}, state) do
    schedule(
      peer,
      fn -> run_set_avatar(peer, cid) end,
      %{
        on_full: fn ->
          Room.send_error(peer, "順番待ちが多すぎます。しばらくしてからやり直してください")
        end
      }
    )

    {:noreply, state}
  end

  def handle_cast({:request_file, peer, object_id}, state) do
    case Room.get_object(object_id) do
      {:ok, %{"kind" => "file"} = object} ->
        {:noreply, do_stage_file(peer, object, state)}

      _ ->
        {:noreply, state}
    end
  end

  def handle_cast({:cancel_peer, peer}, state) do
    staging =
      Enum.reduce(state.staging, %{}, fn {cid, entry}, acc ->
        Map.put(acc, cid, %{entry | waiters: MapSet.delete(entry.waiters, peer)})
      end)

    # Cancelling the queue can invoke `on_cancel`, which calls back into this
    # process, so do it from a separate process to avoid a deadlock.
    _ = start_task(fn -> Queue.cancel_pending(peer) end)

    {:noreply, %{state | staging: staging}}
  end

  def handle_cast({:release_avatars, peer}, state) do
    case Map.pop(state.avatars, peer) do
      {nil, avatars} ->
        {:noreply, %{state | avatars: avatars}}

      {cid, avatars} ->
        Content.release(cid)
        {:noreply, %{state | avatars: avatars}}
    end
  end

  def handle_cast({:staging_progress, cid, loaded, total, queued}, state) do
    send_staging_progress(state, cid, loaded, total, queued)
    {:noreply, state}
  end

  def handle_cast(_message, state), do: {:noreply, state}

  @impl true
  def handle_call({:stage_file, requester, object}, _from, state) do
    {:reply, :ok, do_stage_file(requester, object, state)}
  end

  def handle_call({:staging_info, cid}, _from, state) do
    case Map.fetch(state.staging, cid) do
      {:ok, entry} -> {:reply, {:ok, entry}, state}
      :error -> {:reply, :error, state}
    end
  end

  def handle_call({:take_staging, cid}, _from, state) do
    case Map.pop(state.staging, cid) do
      {nil, staging} -> {:reply, :error, %{state | staging: staging}}
      {entry, staging} -> {:reply, {:ok, entry}, %{state | staging: staging}}
    end
  end

  def handle_call({:get_avatar, peer}, _from, state) do
    {:reply, Map.get(state.avatars, peer), state}
  end

  def handle_call({:put_avatar, peer, cid}, _from, state) do
    {:reply, :ok, %{state | avatars: Map.put(state.avatars, peer, cid)}}
  end

  def handle_call({:delete_avatar, peer}, _from, state) do
    {:reply, :ok, %{state | avatars: Map.delete(state.avatars, peer)}}
  end

  def handle_call(_request, _from, state), do: {:reply, :ok, state}

  defp do_place_image(peer, place) do
    cid = Map.get(place, "cid")

    callbacks = %{
      queued: fn -> Room.send_place_progress(peer, cid, 0, nil, true) end,
      on_full: fn ->
        Room.send_error(
          peer,
          "順番待ちの画像が多すぎます。いくつか終わってから再来してください"
        )
      end
    }

    schedule(peer, fn -> run_place_image(peer, place, cid) end, callbacks)
  end

  defp run_place_image(peer, place, cid) do
    case ensure_content(cid, :image, peer) do
      {:ok, info} ->
        case Room.add_image(place) do
          {:ok, _object} ->
            Logger.info("[place_image] #{cid} (#{Media.format_bytes(info.size)}) by #{peer}")

            :ok

          :full ->
            Content.release(cid)
            Room.send_error(peer, "これ以上オブジェクトを置けません")
        end

      {:error, message} ->
        Room.send_error(peer, message)
    end
  end

  defp do_place_file(peer, place) do
    cid = Map.get(place, "cid")

    callbacks = %{
      queued: fn -> Room.send_place_progress(peer, cid, 0, nil, true) end,
      on_full: fn ->
        Room.send_error(
          peer,
          "順番待ちのファイルが多すぎます。いくつか終わってからやり直してください"
        )
      end
    }

    schedule(peer, fn -> run_place_file(peer, place, cid) end, callbacks)
  end

  defp run_place_file(peer, place, cid) do
    name = Map.get(place, "name", "file")

    with {:ok, probe} <- probe(cid, :file) do
      category = Media.classify_file(name, probe.head)

      if probe.size > @eager_file_max_bytes and Content.known(cid) == :error do
        object =
          place
          |> Map.merge(%{
            "size" => probe.size,
            "category" => category,
            "stored" => false,
            "owner" => peer
          })

        case Room.add_file(object) do
          {:ok, placed} ->
            Logger.info(
              "[place_file] #{cid} (#{Media.format_bytes(probe.size)}, placed; " <>
                "fetching in the background) by #{peer}"
            )

            stage_file(nil, placed)

          :full ->
            Room.send_error(peer, "これ以上オブジェクトを置けません")
        end
      else
        case ensure_content(cid, :file, peer) do
          {:ok, info} ->
            object =
              Map.merge(place, %{
                "size" => info.size,
                "category" => Media.classify_file(name, info.head),
                "stored" => true
              })

            case Room.add_file(object) do
              {:ok, _placed} ->
                Logger.info("[place_file] #{cid} (#{Media.format_bytes(info.size)}) by #{peer}")

                :ok

              :full ->
                Content.release(cid)
                Room.send_error(peer, "これ以上オブジェクトを置けません")
            end

          {:error, message} ->
            Room.send_error(peer, message)
        end
      end
    else
      {:error, message} -> Room.send_error(peer, message)
    end
  end

  defp do_place_url(peer, place) do
    url = Map.get(place, "url")

    callbacks = %{
      queued: fn -> :ok end,
      on_full: fn ->
        Room.send_error(peer, "順番待ちが多すぎます。しばらくしてからやり直してください")
      end
    }

    schedule(peer, fn -> run_place_url(peer, place, url) end, callbacks)
  end

  defp run_place_url(peer, place, url) do
    case UrlFetch.fetch(url) do
      {:ok, fetched} ->
        kind = Map.get(fetched, "kind")

        if kind == "link" do
          object = %{
            "url" => Map.get(fetched, "url"),
            "position" => Map.get(place, "position"),
            "yaw" => Map.get(place, "yaw")
          }

          case Room.add_link(object) do
            {:ok, _placed} ->
              Logger.info("[url] #{Map.get(fetched, "url")} -> link")
              :ok

            :full ->
              Room.send_error(peer, "これ以上オブジェクトを置けません")
          end
        else
          add_fetched_media(peer, place, fetched, kind)
        end

      {:error, message} ->
        Room.send_error(peer, message)
    end
  end

  defp add_fetched_media(peer, place, fetched, kind) do
    bytes = Map.get(fetched, "bytes", <<>>)

    case Ipfs.add_bytes(bytes) do
      {:ok, cid, _size} ->
        content_kind = if kind == "image", do: :image, else: :file

        case ensure_content(cid, content_kind, peer) do
          {:ok, info} ->
            add_fetched_object(peer, place, fetched, kind, cid, info)

          {:error, message} ->
            safe_unpin(cid)
            Room.send_error(peer, message)
        end

      {:error, reason} ->
        Logger.warning(
          "[url] add_bytes failed for #{Map.get(fetched, "url")}: #{inspect(reason)}"
        )

        Room.send_error(peer, "URL の内容を取得できませんでした")
    end
  end

  defp add_fetched_object(peer, place, fetched, "image", cid, _info) do
    object = %{
      "cid" => cid,
      "name" => Map.get(fetched, "name"),
      "position" => Map.get(place, "position"),
      "yaw" => Map.get(place, "yaw"),
      "width" => Map.get(fetched, "width", 1),
      "height" => Map.get(fetched, "height", 1)
    }

    case Room.add_image(object) do
      {:ok, _placed} ->
        Logger.info(
          "[url] #{Map.get(fetched, "url")} -> image #{cid} " <>
            "(#{Map.get(fetched, "width")}x#{Map.get(fetched, "height")})"
        )

        :ok

      :full ->
        Content.release(cid)
        Room.send_error(peer, "これ以上オブジェクトを置けません")
    end
  end

  defp add_fetched_object(peer, place, fetched, kind, cid, info) do
    object = %{
      "cid" => cid,
      "name" => Map.get(fetched, "name"),
      "position" => Map.get(place, "position"),
      "yaw" => Map.get(place, "yaw"),
      "size" => info.size,
      "category" => kind,
      "stored" => true
    }

    case Room.add_file(object) do
      {:ok, _placed} ->
        Logger.info(
          "[url] #{Map.get(fetched, "url")} -> #{kind} #{cid} " <>
            "(#{Media.format_bytes(info.size)})"
        )

        :ok

      :full ->
        Content.release(cid)
        Room.send_error(peer, "これ以上オブジェクトを置けません")
    end
  end

  defp probe(cid, kind) do
    case Content.known(cid) do
      {:ok, info} ->
        case Content.check(kind, info.size, info.head) do
          :ok -> {:ok, info}
          {:error, message} -> {:error, message}
        end

      :error ->
        with {:ok, size} <- stat_size(cid, kind),
             {:ok, head, _total} <- Ipfs.head(cid, @sniff_bytes),
             :ok <- Content.check(kind, size, head) do
          {:ok, %{size: size, head: head}}
        else
          {:error, message} when is_binary(message) -> {:error, message}
          _ -> {:error, fetch_error(kind)}
        end
    end
  end

  defp stat_size(cid, kind) do
    case Ipfs.stat(cid) do
      {:ok, size} -> {:ok, size}
      {:error, _reason} -> {:error, fetch_error(kind)}
    end
  end

  defp ensure_content(cid, kind, peer) do
    case Content.known(cid) do
      {:ok, info} ->
        Content.acquire(cid, kind, info.size, info.head, nil)

      :error ->
        fetch_and_acquire(cid, kind, peer)
    end
  end

  defp fetch_and_acquire(cid, kind, peer) do
    declared =
      case Ipfs.stat(cid) do
        {:ok, size} -> {:ok, size}
        {:error, _reason} -> :unknown
      end

    case declared do
      {:ok, size} ->
        case Content.reserve(size) do
          {:ok, ref} -> fetch_with_reservation(cid, kind, peer, ref, size)
          {:error, message} -> {:error, message}
        end

      :unknown ->
        fetch_with_reservation(cid, kind, peer, nil, nil)
    end
  end

  defp fetch_with_reservation(cid, kind, peer, ref, declared) do
    heartbeat = start_heartbeat(kind, peer, cid, declared)
    pin_result = Ipfs.pin(cid)
    stop_heartbeat(heartbeat)

    case pin_result do
      :ok ->
        case measure(cid, kind) do
          {:ok, size, head} ->
            case Content.acquire(cid, kind, size, head, ref) do
              {:ok, info} ->
                {:ok, info}

              {:error, message} ->
                Content.unreserve(ref)
                {:error, message}
            end

          {:error, message} ->
            Content.unreserve(ref)
            {:error, message}
        end

      {:error, reason} ->
        Logger.warning("[content] pin failed for #{cid}: #{inspect(reason)}")
        Content.unreserve(ref)
        {:error, fetch_error(kind)}
    end
  end

  defp measure(cid, kind) do
    case Ipfs.stat(cid) do
      {:ok, size} ->
        case Ipfs.head(cid, @sniff_bytes) do
          {:ok, head, _total} -> {:ok, size, head}
          {:error, _reason} -> {:error, fetch_error(kind)}
        end

      {:error, _reason} ->
        case Ipfs.head(cid, @sniff_bytes) do
          {:ok, head, total} -> {:ok, total, head}
          {:error, _reason} -> {:error, fetch_error(kind)}
        end
    end
  end

  defp do_stage_file(requester, object, state) do
    cid = Map.get(object, "cid")

    cond do
      Map.get(object, "stored") == true ->
        state

      Map.get(object, "offline") == true or is_nil(Map.get(object, "owner")) ->
        if requester do
          Room.send_prepare_failed(
            requester,
            cid,
            "アップロードした人が退室しているため、取得できません"
          )
        end

        state

      Map.has_key?(state.staging, cid) ->
        entry = Map.fetch!(state.staging, cid)

        waiters =
          if requester, do: MapSet.put(entry.waiters, requester), else: entry.waiters

        put_in(state.staging[cid], %{entry | waiters: waiters})

      true ->
        start_staging(requester, object, cid, state)
    end
  end

  defp start_staging(requester, object, cid, state) do
    owner = Map.get(object, "owner")
    name = Map.get(object, "name", "file")
    waiters = if requester, do: MapSet.new([requester]), else: MapSet.new()

    entry = %{owner: owner, waiters: waiters, name: name}
    state = put_in(state.staging[cid], entry)

    callbacks = %{
      queued: fn ->
        GenServer.cast(__MODULE__, {:staging_progress, cid, 0, nil, true})
      end,
      on_cancel: fn ->
        fail_staging(cid, "アップロードした人が退室したため、取得できません")
      end
    }

    case Queue.enqueue(owner, fn -> run_staging(cid, owner) end, callbacks) do
      :full ->
        fail_staging_in_state(
          state,
          cid,
          "順番待ちが多すぎます。しばらくしてからやり直してください"
        )

      :ok ->
        state
    end
  end

  defp run_staging(cid, owner) do
    case ensure_content(cid, :file, owner) do
      {:ok, info} ->
        updated = Room.mark_stored(cid, info.size)

        if updated == [] do
          Content.release(cid)
        else
          if length(updated) > 1 do
            Enum.each(1..(length(updated) - 1), fn _ -> Content.retain(cid) end)
          end
        end

        Logger.info(
          "[stage_file] #{cid} (#{Media.format_bytes(info.size)}) now stored; " <>
            "#{length(updated)} object(s)"
        )

      {:error, message} ->
        fail_staging(cid, message)
    end

    clear_staging(cid)
  end

  defp send_staging_progress(state, cid, loaded, total, queued) do
    case Map.fetch(state.staging, cid) do
      {:ok, %{owner: owner, waiters: waiters}} ->
        Room.send_place_progress(owner, cid, loaded, total, queued)

        Enum.each(waiters, fn waiter ->
          if waiter != owner do
            Room.send_prepare_progress(waiter, cid, loaded, total, queued)
          end
        end)

      :error ->
        :ok
    end
  end

  defp fail_staging(cid, message) do
    case GenServer.call(__MODULE__, {:take_staging, cid}) do
      {:ok, %{owner: owner, waiters: waiters, name: name}} ->
        Enum.each(waiters, fn waiter ->
          Room.send_prepare_failed(waiter, cid, message)
        end)

        if Room.remove_unstored(cid) > 0 do
          Room.send_error(owner, "#{name}: #{message}")
        end

        :ok

      :error ->
        :ok
    end
  end

  # Same as `fail_staging/2` but used from inside the GenServer process, where
  # calling back into `__MODULE__` would deadlock.
  defp fail_staging_in_state(state, cid, message) do
    case Map.pop(state.staging, cid) do
      {nil, staging} ->
        %{state | staging: staging}

      {%{owner: owner, waiters: waiters, name: name}, staging} ->
        Enum.each(waiters, fn waiter ->
          Room.send_prepare_failed(waiter, cid, message)
        end)

        if Room.remove_unstored(cid) > 0 do
          Room.send_error(owner, "#{name}: #{message}")
        end

        %{state | staging: staging}
    end
  end

  defp clear_staging(cid) do
    _ = GenServer.call(__MODULE__, {:take_staging, cid})
    :ok
  end

  defp run_set_avatar(peer, cid) do
    current = GenServer.call(__MODULE__, {:get_avatar, peer})

    cond do
      is_nil(cid) ->
        if current do
          Content.release(current)
          GenServer.call(__MODULE__, {:delete_avatar, peer})
        end

        Room.set_avatar(peer, nil)

      cid == current ->
        :ok

      true ->
        case ensure_content(cid, :avatar, peer) do
          {:ok, info} ->
            if current, do: Content.release(current)
            GenServer.call(__MODULE__, {:put_avatar, peer, cid})
            Room.set_avatar(peer, cid)

            Logger.info("[avatar] #{cid} pinned for #{peer} (#{Media.format_bytes(info.size)})")

            :ok

          {:error, message} ->
            Room.send_error(peer, "アバターを取得できませんでした: #{message}")
        end
    end
  end

  defp start_heartbeat(kind, peer, cid, total) when kind in [:image, :file] do
    case start_task(fn -> heartbeat_loop(peer, cid, total) end) do
      {:ok, pid} -> pid
      :error -> nil
    end
  end

  defp start_heartbeat(_kind, _peer, _cid, _total), do: nil

  defp heartbeat_loop(peer, cid, total) do
    receive do
      :stop ->
        :ok
    after
      @progress_interval_ms ->
        safe_room(fn -> Room.send_place_progress(peer, cid, 0, total, false) end)
        heartbeat_loop(peer, cid, total)
    end
  end

  defp stop_heartbeat(nil), do: :ok

  defp stop_heartbeat(pid) do
    send(pid, :stop)
    :ok
  end

  defp schedule(peer, fun, callbacks) do
    case Queue.enqueue(peer, fun, callbacks) do
      :full -> fire(Map.get(callbacks, :on_full))
      :ok -> :ok
    end
  end

  defp fire(fun) when is_function(fun, 0), do: fun.()
  defp fire(_fun), do: :ok

  defp fetch_error(:image), do: "画像を取得できませんでした"
  defp fetch_error(:file), do: "ファイルを取得できませんでした"
  defp fetch_error(:avatar), do: "IPFS から取得できませんでした"

  defp safe_unpin(cid) do
    if Process.whereis(Ipfs) != nil do
      _ = Ipfs.unpin(cid)
    end

    :ok
  end

  defp safe_room(fun) do
    try do
      fun.()
    rescue
      _ -> :ok
    catch
      _, _ -> :ok
    end
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
end
