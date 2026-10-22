defmodule ProtoServer.WsHandler do
  @moduledoc """
  Cowboy WebSocket handler for the space v2 protocol.

  A successful `space_join` creates a peer entity and starts one
  `ProtoServer.Space.Reader` and one `ProtoServer.Space.Writer` process linked
  to the WebSocket process. Both processes deliver pre-encoded JSON as
  `{:proto_send, json}`.
  """

  @behaviour :cowboy_websocket

  require Logger

  alias ProtoServer.{Config, Place, Protocol}
  alias ProtoServer.Space.{Reader, Schema, Scope, Store, Writer}

  @ping_interval_ms 30_000
  @idle_timeout_ms 60_000
  @max_frame_size 4096
  @template_id "vr-sns-3d"
  @session_id "main"

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

    {:ok,
     %{
       peer_id: nil,
       reader: nil,
       writer: nil,
       timer: timer,
       last_seen: now_ms(),
       joined: false
     }}
  end

  @impl :cowboy_websocket
  def websocket_handle({:text, data}, state) do
    state = touch(state)

    case Protocol.parse(data) do
      {:ok, message} ->
        {:ok, dispatch_safely(message, state)}

      {:legacy, type} ->
        send_error(state, nil, "protocol_mismatch", "旧プロトコル (#{type}) は廃止されました")
        {:ok, state}

      :error ->
        send_error(state, nil, "invalid_message", "メッセージを解釈できません")
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
        safe(fn -> Place.cancel_peer(peer_id) end)
        safe(fn -> Place.release_avatars(peer_id) end)
        safe(fn -> Store.leave_peer(@session_id, peer_id) end)
        stop_process(state.reader)
        stop_process(state.writer)

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

  defp dispatch(%{"type" => "space_join"} = message, %{joined: false} = state) do
    template_id = Map.get(message, "templateId")
    schema_version = Map.get(message, "schemaVersion")
    requested_session = Map.get(message, "sessionId", @session_id)

    cond do
      template_id != @template_id ->
        send_error(state, nil, "schema_mismatch", "テンプレートが一致しません")
        state

      schema_version != Schema.schema_version() ->
        send_error(state, nil, "schema_mismatch", "スキーマのバージョンが一致しません")
        state

      requested_session != @session_id ->
        send_error(state, nil, "session_not_found", "セッションが見つかりません")
        state

      true ->
        join_peer(message, state)
    end
  end

  defp dispatch(%{"type" => "space_join"}, state) do
    send_error(state, nil, "already_joined", "すでに入室しています")
    state
  end

  defp dispatch(_message, %{joined: false} = state) do
    send_error(state, nil, "join_required", "先に space_join を送ってください")
    state
  end

  defp dispatch(%{"type" => type} = message, state)
       when type in ["space_query", "space_subscribe", "space_unsubscribe"] do
    Reader.client(state.reader, message)
    state
  end

  defp dispatch(%{"type" => type} = message, state)
       when type in ["space_mutate", "space_import_url", "space_set_avatar", "file_request"] do
    Writer.client(state.writer, message)
    state
  end

  defp dispatch(%{"type" => type}, state) do
    send_error(state, nil, "invalid_message", "未対応のメッセージです: #{type}")
    state
  end

  defp join_peer(message, state) do
    name = Map.get(message, "name")

    case Store.create_peer(@session_id, self(), name) do
      {:ok, peer_id, self_info, ice_servers} ->
        Logger.info("[join] #{peer_id}")

        scope = Scope.default_member(@session_id, peer_id)

        welcome = %{
          "self" => self_info,
          "templateId" => @template_id,
          "ipfs" => Config.ipfs_info(),
          "iceServers" => ice_servers
        }

        case Writer.start_link(
               ws_pid: self(),
               session_id: @session_id,
               peer_id: peer_id,
               scope: scope
             ) do
          {:ok, writer} ->
            case Reader.start_link(
                   ws_pid: self(),
                   session_id: @session_id,
                   scope: scope,
                   welcome: welcome
                 ) do
              {:ok, reader} ->
                %{
                  state
                  | peer_id: peer_id,
                    reader: reader,
                    writer: writer,
                    joined: true
                }

              {:error, reason} ->
                Logger.warning("[join] reader failed: #{inspect(reason)}")
                stop_process(writer)
                safe(fn -> Store.leave_peer(@session_id, peer_id) end)
                send_error(state, nil, "server_error", "入室処理に失敗しました")
                state
            end

          {:error, reason} ->
            Logger.warning("[join] writer failed: #{inspect(reason)}")
            safe(fn -> Store.leave_peer(@session_id, peer_id) end)
            send_error(state, nil, "server_error", "入室処理に失敗しました")
            state
        end

      {:error, reason} ->
        Logger.warning("[join] create_peer failed: #{inspect(reason)}")
        send_error(state, nil, "server_error", "入室処理に失敗しました")
        state
    end
  end

  defp send_error(state, command_id, code, message) do
    payload = %{"type" => "space_error", "code" => code, "message" => message}
    payload = if is_binary(command_id), do: Map.put(payload, "commandId", command_id), else: payload
    send(self(), {:proto_send, Protocol.encode(payload)})
    state
  end

  defp stop_process(nil), do: :ok

  defp stop_process(pid) when is_pid(pid) do
    safe(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid, :normal, 5_000)
    end)
  end

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
