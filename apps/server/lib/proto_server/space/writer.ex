defmodule ProtoServer.Space.Writer do
  @moduledoc false

  use GenServer

  require Logger

  alias ProtoServer.{Content, Place, Protocol}
  alias ProtoServer.Space.Store

  @max_remembered 64

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  @spec client(pid(), map()) :: :ok
  def client(writer, message), do: GenServer.cast(writer, {:client, message})

  @impl true
  def init(opts) do
    peer_id = Keyword.fetch!(opts, :peer_id)
    session_id = Keyword.fetch!(opts, :session_id)
    scope = Keyword.fetch!(opts, :scope)
    Store.register_writer(session_id, peer_id, self())

    {:ok,
     %{
       ws_pid: Keyword.fetch!(opts, :ws_pid),
       peer_id: peer_id,
       session_id: session_id,
       scope: scope,
       results: %{},
       result_order: []
     }}
  end

  @impl true
  def handle_cast({:client, %{"type" => "space_mutate"} = message}, state) do
    mutation = Map.get(message, "mutation", %{})
    {:noreply, handle_mutation(mutation, state)}
  end

  def handle_cast({:client, %{"type" => "space_import_url"} = message}, state) do
    command_id = Map.get(message, "commandId")
    entity_id = Map.get(message, "entityId")
    url = Map.get(message, "url")
    position = Map.get(message, "position")
    yaw = Map.get(message, "yaw")
    pitch = Map.get(message, "pitch")

    if is_binary(command_id) and is_binary(entity_id) and is_binary(url) and is_list(position) and
         is_number(yaw) do
      place = %{
        "url" => url,
        "position" => position,
        "yaw" => yaw,
        "objectId" => entity_id,
        "commandId" => command_id
      }

      place = if is_number(pitch), do: Map.put(place, "pitch", pitch), else: place
      safe(fn -> Place.place_url(state.peer_id, place) end)
      {:noreply, remember(state, command_id, {:deferred, entity_id})}
    else
      {:noreply, send_error(state, command_id, "invalid_message", "URL の取り込み要求が不正です")}
    end
  end

  def handle_cast({:client, %{"type" => "space_set_avatar"} = message}, state) do
    command_id = Map.get(message, "commandId")
    cid = Map.get(message, "cid")

    if is_binary(command_id) do
      safe(fn -> Place.set_avatar(state.peer_id, cid, command_id) end)
      {:noreply, remember(state, command_id, {:deferred, nil})}
    else
      {:noreply, send_error(state, nil, "invalid_message", "アバター要求が不正です")}
    end
  end

  def handle_cast({:client, %{"type" => "file_request"} = message}, state) do
    command_id = Map.get(message, "commandId")
    entity_id = Map.get(message, "entityId")

    if is_binary(command_id) and is_binary(entity_id) do
      safe(fn -> Place.request_file(state.peer_id, entity_id, command_id) end)
      {:noreply, remember(state, command_id, {:deferred, entity_id})}
    else
      {:noreply, send_error(state, command_id, "invalid_message", "ファイル要求が不正です")}
    end
  end

  def handle_cast({:client, _message}, state), do: {:noreply, state}

  @impl true
  def handle_info(_info, state), do: {:noreply, state}

  defp handle_mutation(mutation, state) do
    command_id = Map.get(mutation, "commandId")

    case Map.get(state.results, command_id) do
      nil ->
        execute_mutation(mutation, state)

      {:ok, version, entity_id} ->
        send_ack(state, command_id, version, entity_id)
        state

      {:error, code, message} ->
        send_error(state, command_id, code, message)

      {:deferred, _entity_id} ->
        state
    end
  end

  defp execute_mutation(%{"op" => "create"} = mutation, state) do
    command_id = Map.get(mutation, "commandId")
    entity_id = Map.get(mutation, "entityId")
    dimensions = Map.get(mutation, "dimensions", %{})
    kind = Map.get(dimensions, "entity.kind")

    cond do
      not is_binary(command_id) or not is_binary(entity_id) ->
        send_error(state, command_id, "invalid_message", "作成要求が不正です")

      kind == "box" ->
        case Store.mutate(state.session_id, state.peer_id, state.scope, mutation) do
          {:ok, version, _legacy} ->
            send_ack(state, command_id, version, entity_id)
            remember(state, command_id, {:ok, version, entity_id})

          {:error, code} ->
            send_error(state, command_id, code, error_message(code))
            remember(state, command_id, {:error, code, error_message(code)})
        end

      kind == "image" ->
        place = %{
          "cid" => Map.get(dimensions, "content.cid"),
          "name" => Map.get(dimensions, "content.name"),
          "position" => Map.get(dimensions, "space.position"),
          "yaw" => Map.get(dimensions, "space.yaw"),
          "pitch" => Map.get(dimensions, "space.pitch"),
          "width" => Map.get(dimensions, "content.width"),
          "height" => Map.get(dimensions, "content.height"),
          "objectId" => entity_id,
          "commandId" => command_id
        }

        safe(fn -> Place.place_image(state.peer_id, place) end)
        remember(state, command_id, {:deferred, entity_id})

      kind == "file" ->
        place = %{
          "cid" => Map.get(dimensions, "content.cid"),
          "name" => Map.get(dimensions, "content.name"),
          "position" => Map.get(dimensions, "space.position"),
          "yaw" => Map.get(dimensions, "space.yaw"),
          "pitch" => Map.get(dimensions, "space.pitch"),
          "objectId" => entity_id,
          "commandId" => command_id
        }

        safe(fn -> Place.place_file(state.peer_id, place) end)
        remember(state, command_id, {:deferred, entity_id})

      true ->
        message = "この種類のエンティティは直接作成できません"
        send_error(state, command_id, "invalid_dimension", message)
        remember(state, command_id, {:error, "invalid_dimension", message})
    end
  end

  defp execute_mutation(%{"op" => "delete"} = mutation, state) do
    command_id = Map.get(mutation, "commandId")

    case Store.mutate(state.session_id, state.peer_id, state.scope, mutation) do
      {:ok, version, legacy} ->
        if holds_content?(legacy), do: safe(fn -> Content.release(legacy["cid"]) end)
        send_ack(state, command_id, version, Map.get(legacy, "id"))
        remember(state, command_id, {:ok, version, Map.get(legacy, "id")})

      {:error, code} ->
        send_error(state, command_id, code, error_message(code))
        remember(state, command_id, {:error, code, error_message(code)})
    end
  end

  defp execute_mutation(%{"op" => "duplicate"} = mutation, state) do
    command_id = Map.get(mutation, "commandId")

    case Store.mutate(state.session_id, state.peer_id, state.scope, mutation) do
      {:ok, version, copy} ->
        if holds_content?(copy), do: safe(fn -> Content.retain(copy["cid"]) end)
        send_ack(state, command_id, version, Map.get(copy, "id"))
        remember(state, command_id, {:ok, version, Map.get(copy, "id")})

      {:error, code} ->
        send_error(state, command_id, code, error_message(code))
        remember(state, command_id, {:error, code, error_message(code)})
    end
  end

  defp execute_mutation(mutation, state) do
    command_id = Map.get(mutation, "commandId")

    if Map.get(mutation, "op") in ["patch", "claim", "release"] do
      case Store.mutate(state.session_id, state.peer_id, state.scope, mutation) do
        {:ok, version, legacy} ->
          send_ack(state, command_id, version, Map.get(legacy, "id"))
          remember(state, command_id, {:ok, version, Map.get(legacy, "id")})

        {:error, code} ->
          send_error(state, command_id, code, error_message(code))
          remember(state, command_id, {:error, code, error_message(code)})
      end
    else
      send_error(state, command_id, "invalid_message", "未対応の操作です")
    end
  end

  defp remember(state, command_id, result) when is_binary(command_id) do
    results = Map.put(state.results, command_id, result)
    order = [command_id | state.result_order]

    {results, order} =
      if length(order) > @max_remembered do
        {oldest, rest} = List.pop_at(order, -1)
        {Map.delete(results, oldest), rest}
      else
        {results, order}
      end

    %{state | results: results, result_order: order}
  end

  defp remember(state, _command_id, _result), do: state

  defp send_ack(state, command_id, version, entity_id) when is_binary(command_id) do
    send_json(state.ws_pid, %{
      "type" => "space_ack",
      "commandId" => command_id,
      "version" => version,
      "entityId" => entity_id
    })
  end

  defp send_ack(_state, _command_id, _version, _entity_id), do: :ok

  defp send_error(state, command_id, code, message) do
    send_json(
      state.ws_pid,
      %{
        "type" => "space_error",
        "code" => code,
        "message" => message
      }
      |> maybe_put("commandId", command_id)
    )

    state
  end

  defp error_message("not_found"), do: "オブジェクトが見つかりません"
  defp error_message("forbidden"), do: "この操作は許可されていません"
  defp error_message("held_by_other"), do: "他の人がつかんでいます"
  defp error_message("limit_exceeded"), do: "これ以上オブジェクトを置けません"
  defp error_message("already_exists"), do: "同じ ID のオブジェクトが既にあります"
  defp error_message("stale_entity"), do: "オブジェクトが更新されています"
  defp error_message("condition_failed"), do: "操作の条件が満たされていません"
  defp error_message("entity_too_large"), do: "オブジェクトのデータが大きすぎます"
  defp error_message("invalid_dimension"), do: "オブジェクトの次元が不正です"
  defp error_message(_code), do: "操作に失敗しました"

  defp holds_content?(%{"kind" => "image"}), do: true
  defp holds_content?(%{"kind" => "file", "stored" => true}), do: true
  defp holds_content?(_object), do: false

  defp send_json(pid, message), do: send(pid, {:proto_send, Protocol.encode(message)})

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp safe(fun) do
    fun.()
  rescue
    error ->
      Logger.warning("space writer action failed: #{Exception.message(error)}")
      :ok
  catch
    kind, reason ->
      Logger.warning("space writer action failed: #{inspect({kind, reason})}")
      :ok
  end
end
