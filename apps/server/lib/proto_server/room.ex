defmodule ProtoServer.Room do
  @moduledoc """
  Authoritative in-memory room state for the legacy world protocol.

  Peers are addressed by their WebSocket process pid. Every outbound message is
  encoded once with `ProtoServer.Protocol.encode/1` and delivered as
  `{:proto_send, json}`. All objects and peer state use string keys because they
  cross the WebSocket boundary.
  """

  use GenServer

  alias ProtoServer.{Config, Protocol, Turn, Uuid}

  @colors ~w(#e6194b #3cb44b #ffe119 #4363d8 #f58231 #911eb4 #46f0f0 #f032e6 #bcf60c #fabebe)
  @initial_pose %{"position" => [0, 0, 0], "head" => [0, 0, 0, 1]}
  @tick_rate 20
  @tick_interval_ms 50
  @max_objects 100
  @file_icon_width 0.9
  @duplicate_normal_offset 0.05

  @initial_boxes [
    %{"position" => [0, 0, 0], "yaw" => 0, "size" => 1, "color" => "#d9534f"},
    %{"position" => [6, 0, -4], "yaw" => 0, "size" => 2, "color" => "#5bc0de"},
    %{"position" => [-7, 0, -6], "yaw" => 0, "size" => 1.5, "color" => "#5cb85c"},
    %{"position" => [10, 0, 8], "yaw" => 0, "size" => 1, "color" => "#f0ad4e"},
    %{"position" => [-10, 0, 7], "yaw" => 0, "size" => 3, "color" => "#9b59b6"}
  ]

  @type peer_id :: binary()
  @type object :: map()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @spec join(pid(), term()) :: {:ok, peer_id()}
  def join(pid, raw_name), do: GenServer.call(__MODULE__, {:join, pid, raw_name})

  @spec set_pose(peer_id(), map()) :: :ok
  def set_pose(peer_id, pose), do: GenServer.call(__MODULE__, {:set_pose, peer_id, pose})

  @spec set_avatar(peer_id(), binary() | nil) :: :ok
  def set_avatar(peer_id, cid), do: GenServer.call(__MODULE__, {:set_avatar, peer_id, cid})

  @spec announce_ipfs(peer_id(), binary()) :: :ok
  def announce_ipfs(peer_id, ipfs_peer_id),
    do: GenServer.call(__MODULE__, {:announce_ipfs, peer_id, ipfs_peer_id})

  @spec set_video_state(peer_id(), binary(), boolean(), number()) :: :ok
  def set_video_state(peer_id, id, playing, time),
    do: GenServer.call(__MODULE__, {:set_video_state, peer_id, id, playing, time})

  @spec add_image(map()) :: {:ok, object()} | :full
  def add_image(place), do: GenServer.call(__MODULE__, {:add, "image", place})

  @spec add_file(map()) :: {:ok, object()} | :full
  def add_file(place), do: GenServer.call(__MODULE__, {:add, "file", place})

  @spec add_link(map()) :: {:ok, object()} | :full
  def add_link(place), do: GenServer.call(__MODULE__, {:add, "link", place})

  @spec add_box(map()) :: {:ok, object()} | :full
  def add_box(place), do: GenServer.call(__MODULE__, {:add, "box", place})

  @spec grab_object(peer_id(), binary()) :: :ok
  def grab_object(peer_id, id), do: GenServer.call(__MODULE__, {:grab_object, peer_id, id})

  @spec move_object(peer_id(), binary(), [number()], number(), number() | nil, number() | nil) ::
          :ok
  def move_object(peer_id, id, position, yaw, pitch, scale),
    do: GenServer.call(__MODULE__, {:move_object, peer_id, id, position, yaw, pitch, scale})

  @spec release_object(peer_id(), binary()) :: :ok
  def release_object(peer_id, id), do: GenServer.call(__MODULE__, {:release_object, peer_id, id})

  @spec delete_object(peer_id(), binary()) ::
          {:ok, object()} | {:error, :not_found | :held | :forbidden}
  def delete_object(peer_id, id), do: GenServer.call(__MODULE__, {:delete_object, peer_id, id})

  @spec duplicate_object(peer_id(), binary()) ::
          {:ok, object()} | {:error, :not_found | :full | :forbidden}
  def duplicate_object(peer_id, id),
    do: GenServer.call(__MODULE__, {:duplicate_object, peer_id, id})

  @spec mark_stored(binary(), integer()) :: [object()]
  def mark_stored(cid, size), do: GenServer.call(__MODULE__, {:mark_stored, cid, size})

  @spec remove_unstored(binary()) :: non_neg_integer()
  def remove_unstored(cid), do: GenServer.call(__MODULE__, {:remove_unstored, cid})

  @spec find_stored_file(binary()) :: {:ok, object()} | :error
  def find_stored_file(cid), do: GenServer.call(__MODULE__, {:find_file, :stored, cid})

  @spec find_unstored_file(binary()) :: {:ok, object()} | :error
  def find_unstored_file(cid), do: GenServer.call(__MODULE__, {:find_file, :unstored, cid})

  @spec get_object(binary()) :: {:ok, object()} | :error
  def get_object(id), do: GenServer.call(__MODULE__, {:get_object, id})

  @spec send_place_progress(peer_id(), binary(), integer(), integer() | nil, boolean()) :: :ok
  def send_place_progress(peer_id, cid, loaded, total, queued),
    do: GenServer.call(__MODULE__, {:progress, :place, peer_id, cid, loaded, total, queued})

  @spec send_prepare_progress(peer_id(), binary(), integer(), integer() | nil, boolean()) :: :ok
  def send_prepare_progress(peer_id, cid, loaded, total, queued),
    do: GenServer.call(__MODULE__, {:progress, :prepare, peer_id, cid, loaded, total, queued})

  @spec send_prepare_failed(peer_id(), binary(), binary()) :: :ok
  def send_prepare_failed(peer_id, cid, message),
    do: GenServer.call(__MODULE__, {:send_prepare_failed, peer_id, cid, message})

  @spec send_error(peer_id(), binary()) :: :ok
  def send_error(peer_id, message),
    do: GenServer.call(__MODULE__, {:send_error, peer_id, message})

  @spec leave(peer_id()) :: :ok
  def leave(peer_id), do: GenServer.call(__MODULE__, {:leave, peer_id})

  @spec ipfs_peer_id(peer_id()) :: binary() | nil
  def ipfs_peer_id(peer_id), do: GenServer.call(__MODULE__, {:ipfs_peer_id, peer_id})

  @spec size() :: non_neg_integer()
  def size, do: GenServer.call(__MODULE__, :size)

  @doc """
  Build the five demo boxes seeded at startup (and by tests).
  """
  @spec seed_demo_boxes() :: [object()]
  def seed_demo_boxes do
    Enum.map(@initial_boxes, fn box ->
      box
      |> Map.put("id", Uuid.v4())
      |> Map.put("kind", "box")
    end)
  end

  @impl true
  def init(opts) do
    state = %{
      peers: %{},
      objects: %{},
      videos: %{},
      join_count: 0,
      timer: nil,
      ipfs_info: Keyword.get(opts, :ipfs_info),
      ice_servers_fun:
        Keyword.get(opts, :ice_servers_fun, fn user_id -> Turn.ice_servers(user_id) end)
    }

    state =
      if Keyword.get(opts, :seed, true) do
        objects = Map.new(seed_demo_boxes(), fn object -> {object["id"], object} end)
        %{state | objects: objects}
      else
        state
      end

    {:ok, state}
  end

  @impl true
  def handle_call({:join, pid, raw_name}, _from, state) do
    id = Uuid.v4()
    color = Enum.at(@colors, rem(state.join_count, length(@colors)))

    info = %{
      "id" => id,
      "name" => Protocol.sanitize_name(raw_name, binary_part(id, 0, 4)),
      "color" => color
    }

    peer_state = Map.put(info, "pose", @initial_pose)

    welcome = %{
      "type" => "welcome",
      "self" => info,
      "peers" => Enum.map(state.peers, fn {_peer_id, peer} -> peer.state end),
      "objects" => Map.values(state.objects),
      "videos" => state.videos,
      "ipfs" => state.ipfs_info || Config.ipfs_info(),
      "tickRate" => @tick_rate
    }

    welcome =
      case state.ice_servers_fun.(id) do
        servers when is_list(servers) -> Map.put(welcome, "iceServers", servers)
        _ -> welcome
      end

    send_json(pid, welcome)

    broadcast_to_peers(state.peers, %{"type" => "peer_joined", "peer" => peer_state})

    state = %{
      state
      | peers: Map.put(state.peers, id, %{pid: pid, state: peer_state}),
        join_count: state.join_count + 1
    }

    {:reply, {:ok, id}, start_timer(state)}
  end

  def handle_call({:set_pose, peer_id, pose}, _from, state) do
    state = update_peer(state, peer_id, &Map.put(&1, "pose", pose))
    {:reply, :ok, state}
  end

  def handle_call({:set_avatar, peer_id, cid}, _from, state) do
    case Map.fetch(state.peers, peer_id) do
      {:ok, peer} ->
        peer_state =
          if is_nil(cid) do
            Map.delete(peer.state, "avatarCid")
          else
            Map.put(peer.state, "avatarCid", cid)
          end

        state = %{state | peers: Map.put(state.peers, peer_id, %{peer | state: peer_state})}

        broadcast_except(
          state.peers,
          %{"type" => "peer_avatar", "id" => peer_id, "cid" => cid},
          peer_id
        )

        {:reply, :ok, state}

      :error ->
        {:reply, :ok, state}
    end
  end

  def handle_call({:announce_ipfs, peer_id, ipfs_peer_id}, _from, state) do
    case Map.fetch(state.peers, peer_id) do
      {:ok, peer} ->
        peer_state = Map.put(peer.state, "ipfsPeerId", ipfs_peer_id)
        state = %{state | peers: Map.put(state.peers, peer_id, %{peer | state: peer_state})}

        broadcast_except(
          state.peers,
          %{"type" => "peer_ipfs", "id" => peer_id, "ipfsPeerId" => ipfs_peer_id},
          peer_id
        )

        {:reply, :ok, state}

      :error ->
        {:reply, :ok, state}
    end
  end

  def handle_call({:set_video_state, _peer_id, id, playing, time}, _from, state) do
    case Map.fetch(state.objects, id) do
      {:ok, %{"kind" => "file", "stored" => true, "category" => "video"} = _object} ->
        clamped = time |> Kernel.max(0) |> Kernel.min(24 * 60 * 60)

        video_state = %{
          "playing" => playing,
          "time" => clamped,
          "at" => System.system_time(:millisecond)
        }

        videos = Map.put(state.videos, id, video_state)
        state = %{state | videos: videos}
        broadcast_all(state, Map.merge(%{"type" => "video_state", "id" => id}, video_state))
        {:reply, :ok, state}

      _ ->
        {:reply, :ok, state}
    end
  end

  def handle_call({:add, kind, place}, _from, state) do
    if map_size(state.objects) >= @max_objects do
      {:reply, :full, state}
    else
      object =
        place
        |> Map.put("id", Uuid.v4())
        |> Map.put("kind", kind)

      state = %{state | objects: Map.put(state.objects, object["id"], object)}
      broadcast_all(state, %{"type" => "object_added", "object" => object})
      {:reply, {:ok, object}, state}
    end
  end

  def handle_call({:grab_object, peer_id, id}, _from, state) do
    with {:ok, _peer} <- Map.fetch(state.peers, peer_id),
         {:ok, object} <- Map.fetch(state.objects, id) do
      held_by = Map.get(object, "heldBy")

      if held_by != nil and held_by != peer_id do
        send_json_to_peer(state, peer_id, %{"type" => "error", "message" => "他の人がつかんでいます"})

        send_json_to_peer(state, peer_id, %{
          "type" => "object_updated",
          "object" => object
        })

        {:reply, :ok, state}
      else
        state = release_held_by(state, peer_id, id)
        object = Map.put(Map.fetch!(state.objects, id), "heldBy", peer_id)
        state = %{state | objects: Map.put(state.objects, id, object)}
        broadcast_all(state, %{"type" => "object_updated", "object" => object})
        {:reply, :ok, state}
      end
    else
      _ -> {:reply, :ok, state}
    end
  end

  def handle_call({:move_object, peer_id, id, position, yaw, pitch, scale}, _from, state) do
    case Map.fetch(state.objects, id) do
      {:ok, %{"heldBy" => ^peer_id} = object} ->
        object =
          object
          |> Map.put("position", position)
          |> Map.put("yaw", yaw)
          |> put_or_delete("pitch", pitch)
          |> put_or_delete("scale", scale)

        state = %{state | objects: Map.put(state.objects, id, object)}
        broadcast_except(state.peers, %{"type" => "object_updated", "object" => object}, peer_id)
        {:reply, :ok, state}

      _ ->
        {:reply, :ok, state}
    end
  end

  def handle_call({:release_object, peer_id, id}, _from, state) do
    case Map.fetch(state.objects, id) do
      {:ok, %{"heldBy" => ^peer_id} = object} ->
        object = Map.delete(object, "heldBy")
        state = %{state | objects: Map.put(state.objects, id, object)}
        broadcast_all(state, %{"type" => "object_updated", "object" => object})
        {:reply, :ok, state}

      _ ->
        {:reply, :ok, state}
    end
  end

  def handle_call({:delete_object, peer_id, id}, _from, state) do
    case Map.fetch(state.objects, id) do
      :error ->
        {:reply, {:error, :not_found}, state}

      {:ok, object} ->
        held_by = Map.get(object, "heldBy")

        if held_by != nil and held_by != peer_id do
          send_json_to_peer(state, peer_id, %{"type" => "error", "message" => "他の人がつかんでいます"})
          {:reply, {:error, :held}, state}
        else
          state = %{
            state
            | objects: Map.delete(state.objects, id),
              videos: Map.delete(state.videos, id)
          }

          broadcast_all(state, %{"type" => "object_removed", "id" => id})
          {:reply, {:ok, object}, state}
        end
    end
  end

  def handle_call({:duplicate_object, peer_id, id}, _from, state) do
    case Map.fetch(state.objects, id) do
      :error ->
        {:reply, {:error, :not_found}, state}

      {:ok, object} ->
        if map_size(state.objects) >= @max_objects do
          send_json_to_peer(state, peer_id, %{
            "type" => "error",
            "message" => "これ以上オブジェクトを置けません"
          })

          {:reply, {:error, :full}, state}
        else
          [x, y, z] = Map.fetch!(object, "position")
          yaw = Map.fetch!(object, "yaw")
          scale = Map.get(object, "scale") || 1

          side =
            case object["kind"] do
              "box" -> Map.fetch!(object, "size") * scale + 0.2
              "file" -> (@file_icon_width + 0.15) * scale
              "image" -> 0.6 * scale
              "link" -> 0.6 * scale
            end

          position = [
            x + :math.cos(yaw) * side + :math.sin(yaw) * @duplicate_normal_offset,
            y,
            z - :math.sin(yaw) * side + :math.cos(yaw) * @duplicate_normal_offset
          ]

          copy =
            object
            |> Map.put("id", Uuid.v4())
            |> Map.put("position", position)
            |> Map.delete("heldBy")

          state = %{state | objects: Map.put(state.objects, copy["id"], copy)}
          broadcast_all(state, %{"type" => "object_added", "object" => copy})
          {:reply, {:ok, copy}, state}
        end
    end
  end

  def handle_call({:mark_stored, cid, size}, _from, state) do
    {objects, updated} =
      Enum.reduce(state.objects, {state.objects, []}, fn {id, object}, {objects, updated} ->
        if stored_candidate?(object, cid) do
          updated_object =
            object
            |> Map.put("stored", true)
            |> Map.put("size", size)
            |> Map.delete("owner")
            |> Map.delete("offline")

          broadcast_all(state, %{"type" => "object_updated", "object" => updated_object})
          {Map.put(objects, id, updated_object), [updated_object | updated]}
        else
          {objects, updated}
        end
      end)

    {:reply, Enum.reverse(updated), %{state | objects: objects}}
  end

  def handle_call({:remove_unstored, cid}, _from, state) do
    {objects, videos, removed} =
      Enum.reduce(state.objects, {state.objects, state.videos, 0}, fn
        {id, object}, {objects, videos, removed} ->
          if unstored_removable?(object, cid) do
            broadcast_all(state, %{"type" => "object_removed", "id" => id})
            {Map.delete(objects, id), Map.delete(videos, id), removed + 1}
          else
            {objects, videos, removed}
          end
      end)

    {:reply, removed, %{state | objects: objects, videos: videos}}
  end

  def handle_call({:find_file, storedness, cid}, _from, state) do
    result =
      Enum.find_value(state.objects, :error, fn {_id, object} ->
        if file_match?(object, cid, storedness), do: {:ok, object}, else: nil
      end)

    {:reply, result, state}
  end

  def handle_call({:get_object, id}, _from, state) do
    case Map.fetch(state.objects, id) do
      {:ok, object} -> {:reply, {:ok, object}, state}
      :error -> {:reply, :error, state}
    end
  end

  def handle_call({:progress, kind, peer_id, cid, loaded, total, queued}, _from, state) do
    type = if kind == :place, do: "place_progress", else: "prepare_progress"

    message =
      %{"type" => type, "cid" => cid, "loaded" => loaded}
      |> maybe_put("total", total, not is_nil(total))
      |> maybe_put("queued", queued, queued == true)

    send_json_to_peer(state, peer_id, message)
    {:reply, :ok, state}
  end

  def handle_call({:send_prepare_failed, peer_id, cid, message}, _from, state) do
    send_json_to_peer(state, peer_id, %{
      "type" => "prepare_failed",
      "cid" => cid,
      "message" => message
    })

    {:reply, :ok, state}
  end

  def handle_call({:send_error, peer_id, message}, _from, state) do
    send_json_to_peer(state, peer_id, %{"type" => "error", "message" => message})
    {:reply, :ok, state}
  end

  def handle_call({:leave, peer_id}, _from, state) do
    if Map.has_key?(state.peers, peer_id) do
      state = %{state | peers: Map.delete(state.peers, peer_id)}
      broadcast_all(state, %{"type" => "peer_left", "id" => peer_id})
      state = release_held_by(state, peer_id, nil)
      state = mark_offline(state, peer_id)

      state =
        if map_size(state.peers) == 0 do
          stop_timer(state)
        else
          state
        end

      {:reply, :ok, state}
    else
      {:reply, :ok, state}
    end
  end

  def handle_call({:ipfs_peer_id, peer_id}, _from, state) do
    result =
      case Map.fetch(state.peers, peer_id) do
        {:ok, peer} -> Map.get(peer.state, "ipfsPeerId")
        :error -> nil
      end

    {:reply, result, state}
  end

  def handle_call(:size, _from, state), do: {:reply, map_size(state.peers), state}

  @impl true
  def handle_info(:tick, state) do
    if map_size(state.peers) == 0 do
      {:noreply, %{state | timer: nil}}
    else
      poses =
        Map.new(state.peers, fn {id, peer} ->
          {id, peer.state["pose"]}
        end)

      broadcast_all(state, %{
        "type" => "snapshot",
        "time" => System.system_time(:millisecond),
        "poses" => poses
      })

      timer = Process.send_after(self(), :tick, @tick_interval_ms)
      {:noreply, %{state | timer: timer}}
    end
  end

  def handle_info(_info, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    :ok
  end

  defp update_peer(state, peer_id, fun) do
    case Map.fetch(state.peers, peer_id) do
      {:ok, peer} ->
        %{state | peers: Map.put(state.peers, peer_id, %{peer | state: fun.(peer.state)})}

      :error ->
        state
    end
  end

  defp start_timer(%{timer: nil} = state) do
    %{state | timer: Process.send_after(self(), :tick, @tick_interval_ms)}
  end

  defp start_timer(state), do: state

  defp stop_timer(state) do
    if state.timer, do: Process.cancel_timer(state.timer)
    %{state | timer: nil}
  end

  defp release_held_by(state, peer_id, keep_id) do
    Enum.reduce(state.objects, state, fn {id, object}, acc ->
      if Map.get(object, "heldBy") == peer_id and id != keep_id do
        updated = Map.delete(object, "heldBy")
        broadcast_all(acc, %{"type" => "object_updated", "object" => updated})
        %{acc | objects: Map.put(acc.objects, id, updated)}
      else
        acc
      end
    end)
  end

  defp mark_offline(state, owner_id) do
    Enum.reduce(state.objects, state, fn {id, object}, acc ->
      if Map.get(object, "kind") == "file" and Map.get(object, "stored") != true and
           Map.get(object, "owner") == owner_id and Map.get(object, "offline") != true do
        updated = Map.put(object, "offline", true)
        broadcast_all(acc, %{"type" => "object_updated", "object" => updated})
        %{acc | objects: Map.put(acc.objects, id, updated)}
      else
        acc
      end
    end)
  end

  defp stored_candidate?(object, cid) do
    Map.get(object, "kind") == "file" and Map.get(object, "cid") == cid and
      Map.get(object, "stored") != true
  end

  defp unstored_removable?(object, cid) do
    Map.get(object, "kind") == "file" and Map.get(object, "cid") == cid and
      Map.get(object, "stored") != true and Map.get(object, "offline") != true
  end

  defp file_match?(object, cid, storedness) do
    stored = Map.get(object, "stored") == true

    Map.get(object, "kind") == "file" and Map.get(object, "cid") == cid and
      case storedness do
        :stored -> stored
        :unstored -> not stored
      end
  end

  defp put_or_delete(map, key, nil), do: Map.delete(map, key)

  defp put_or_delete(map, key, value), do: Map.put(map, key, value)

  defp maybe_put(map, _key, _value, false), do: map
  defp maybe_put(map, key, value, true), do: Map.put(map, key, value)

  defp send_json(pid, message), do: send(pid, {:proto_send, Protocol.encode(message)})

  defp send_json_to_peer(state, peer_id, message) do
    case Map.fetch(state.peers, peer_id) do
      {:ok, peer} -> send_json(peer.pid, message)
      :error -> :ok
    end
  end

  defp broadcast_all(state, message) do
    broadcast_to_peers(state.peers, message)
  end

  defp broadcast_except(peers, message, except_id) do
    json = Protocol.encode(message)

    Enum.each(peers, fn
      {^except_id, _peer} -> :ok
      {_id, peer} -> send(peer.pid, {:proto_send, json})
    end)
  end

  defp broadcast_to_peers(peers, message) do
    json = Protocol.encode(message)

    Enum.each(peers, fn {_id, peer} ->
      send(peer.pid, {:proto_send, json})
    end)
  end
end
