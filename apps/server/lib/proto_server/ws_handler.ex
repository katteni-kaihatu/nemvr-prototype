defmodule ProtoServer.WsHandler do
  @moduledoc """
  Cowboy WebSocket handler for the legacy world protocol.

  The handler owns the peer id after a successful `join` and forwards every
  accepted message to `ProtoServer.Room` (or `ProtoServer.Place` for placement
  work). The room delivers pre-encoded JSON to this process as
  `{:proto_send, json}`, which is written back as a text frame.
  """

  @behaviour :cowboy_websocket

  require Logger

  alias ProtoServer.{Content, Place, Protocol, Room}

  @ping_interval_ms 30_000
  @idle_timeout_ms 60_000
  @max_frame_size 4096
  @unsupported_message "crdt-v1 はこのサーバーでは未対応です"

  @impl :cowboy_websocket
  def init(req, state) do
    if websocket_upgrade?(req) do
      {:cowboy_websocket, req, state, %{max_frame_size: @max_frame_size, idle_timeout: :infinity}}
    else
      req =
        :cowboy_req.reply(
          404,
          %{"content-type" => "text/plain; charset=utf-8"},
          "not found",
          req
        )

      {:ok, req, state}
    end
  end

  @impl :cowboy_websocket
  def websocket_init(_state) do
    timer = Process.send_after(self(), :ping_check, @ping_interval_ms)

    {:ok, %{peer_id: nil, timer: timer, last_seen: now_ms(), joined: false}}
  end

  @impl :cowboy_websocket
  def websocket_handle({:text, data}, state) do
    state = touch(state)

    case Protocol.parse(data) do
      {:ok, message} ->
        {:ok, dispatch_safely(message, state)}

      {:unsupported, _type} ->
        reply = Protocol.encode(%{"type" => "error", "message" => @unsupported_message})
        {[{:text, reply}], state}

      :error ->
        {:ok, state}
    end
  end

  def websocket_handle({:binary, _data}, state), do: {:ok, touch(state)}
  def websocket_handle({:ping, _data}, state), do: {:ok, touch(state)}
  def websocket_handle({:pong, _data}, state), do: {:ok, touch(state)}
  def websocket_handle(_frame, state), do: {:ok, state}

  @impl :cowboy_websocket
  def websocket_info(:ping_check, state) do
    now = now_ms()

    if now - state.last_seen >= @idle_timeout_ms do
      {[{:close, 1000, "idle"}], state}
    else
      timer = Process.send_after(self(), :ping_check, @ping_interval_ms)
      {[{:ping, <<>>}], %{state | timer: timer}}
    end
  end

  def websocket_info({:proto_send, json}, state) when is_binary(json) do
    {[{:text, json}], state}
  end

  def websocket_info(_info, state), do: {:ok, state}

  @impl :cowboy_websocket
  def terminate(_reason, _req, state) do
    case state do
      %{peer_id: peer_id} when is_binary(peer_id) ->
        safe(fn -> Room.leave(peer_id) end)
        safe(fn -> Place.cancel_peer(peer_id) end)
        safe(fn -> Place.release_avatars(peer_id) end)

      _ ->
        :ok
    end

    :ok
  end

  defp dispatch_safely(message, state) do
    try do
      dispatch(message, state)
    rescue
      error ->
        Logger.error("ws dispatch failed: " <> Exception.format(:error, error, __STACKTRACE__))

        state
    catch
      kind, reason ->
        Logger.error("ws dispatch failed: " <> Exception.format(kind, reason, __STACKTRACE__))

        state
    end
  end

  defp dispatch(%{"type" => "join"} = message, %{joined: false} = state) do
    {:ok, peer_id} = Room.join(self(), Map.get(message, "name"))
    Logger.info("[join] #{peer_id}")

    %{state | peer_id: peer_id, joined: true}
  end

  defp dispatch(%{"type" => "join"}, state), do: state

  defp dispatch(_message, %{joined: false} = state), do: state

  defp dispatch(%{"type" => "pose"} = message, state) do
    Room.set_pose(state.peer_id, message["pose"])
    state
  end

  defp dispatch(%{"type" => "ipfs_peer"} = message, state) do
    Room.announce_ipfs(state.peer_id, message["peerId"])
    state
  end

  defp dispatch(%{"type" => "set_avatar"} = message, state) do
    Place.set_avatar(state.peer_id, message["cid"])
    state
  end

  defp dispatch(%{"type" => "video_control"} = message, state) do
    Room.set_video_state(state.peer_id, message["id"], message["playing"], message["time"])
    state
  end

  defp dispatch(%{"type" => "grab_object"} = message, state) do
    Room.grab_object(state.peer_id, message["id"])
    state
  end

  defp dispatch(%{"type" => "move_object"} = message, state) do
    Room.move_object(
      state.peer_id,
      message["id"],
      message["position"],
      message["yaw"],
      Map.get(message, "pitch"),
      Map.get(message, "scale")
    )

    state
  end

  defp dispatch(%{"type" => "release_object"} = message, state) do
    Room.release_object(state.peer_id, message["id"])
    state
  end

  defp dispatch(%{"type" => "delete_object"} = message, state) do
    case Room.delete_object(state.peer_id, message["id"]) do
      {:ok, object} ->
        if holds_content?(object), do: Content.release(object["cid"])
        state

      _error ->
        state
    end
  end

  defp dispatch(%{"type" => "duplicate_object"} = message, state) do
    case Room.duplicate_object(state.peer_id, message["id"]) do
      {:ok, copy} ->
        if holds_content?(copy), do: Content.retain(copy["cid"])
        state

      _error ->
        state
    end
  end

  defp dispatch(%{"type" => "place_box"} = message, state) do
    case Room.add_box(Map.drop(message, ["type"])) do
      :full -> Room.send_error(state.peer_id, "これ以上オブジェクトを置けません")
      _ok -> :ok
    end

    state
  end

  defp dispatch(%{"type" => "place_image"} = message, state) do
    Place.place_image(state.peer_id, Map.drop(message, ["type"]))
    state
  end

  defp dispatch(%{"type" => "place_file"} = message, state) do
    Place.place_file(state.peer_id, Map.drop(message, ["type"]))
    state
  end

  defp dispatch(%{"type" => "place_url"} = message, state) do
    place = Map.take(message, ["url", "position", "yaw", "objectId"])
    Place.place_url(state.peer_id, place)
    state
  end

  defp dispatch(%{"type" => "request_file"} = message, state) do
    Place.request_file(state.peer_id, message["id"])
    state
  end

  defp dispatch(_message, state), do: state

  defp holds_content?(%{"kind" => "image"}), do: true

  defp holds_content?(%{"kind" => "file", "stored" => true}), do: true

  defp holds_content?(_object), do: false

  defp safe(fun) do
    try do
      fun.()
    rescue
      error ->
        Logger.warning("ws cleanup failed: " <> Exception.format(:error, error, __STACKTRACE__))
        :ok
    catch
      kind, reason ->
        Logger.warning("ws cleanup failed: " <> Exception.format(kind, reason, __STACKTRACE__))

        :ok
    end
  end

  defp websocket_upgrade?(req) do
    case :cowboy_req.header(<<"upgrade">>, req) do
      value when is_binary(value) ->
        value
        |> String.downcase()
        |> String.contains?("websocket")

      _ ->
        false
    end
  end

  defp touch(state) do
    if is_map(state), do: %{state | last_seen: now_ms()}, else: state
  end

  defp now_ms, do: System.monotonic_time(:millisecond)
end
