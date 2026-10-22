defmodule ProtoServer.Space.Notify do
  @moduledoc false

  alias ProtoServer.Protocol
  alias ProtoServer.Space.Store

  @session "main"

  @spec ack(binary(), binary(), binary() | nil) :: :ok
  def ack(peer_id, command_id, entity_id) when is_binary(command_id) do
    send_to_peer(peer_id, %{
      "type" => "space_ack",
      "commandId" => command_id,
      "version" => 0,
      "entityId" => entity_id
    })
  end

  def ack(_peer_id, _command_id, _entity_id), do: :ok

  @spec error(binary(), binary(), binary(), binary() | nil) :: :ok
  def error(peer_id, code, message, command_id \\ nil) do
    send_to_peer(peer_id, %{
      "type" => "space_error",
      "code" => code,
      "message" => message
    } |> maybe_put("commandId", command_id))
  end

  @spec file_progress(binary(), binary() | nil, binary() | nil, integer(), integer() | nil, boolean(), binary()) :: :ok
  def file_progress(peer_id, entity_id, cid, loaded, total, queued, role) do
    send_to_peer(peer_id, %{
      "type" => "file_progress",
      "entityId" => entity_id,
      "cid" => cid,
      "loaded" => loaded,
      "total" => total,
      "queued" => queued == true,
      "role" => role
    })
  end

  @spec file_failed(binary(), binary() | nil, binary() | nil, binary()) :: :ok
  def file_failed(peer_id, entity_id, cid, message) do
    send_to_peer(peer_id, %{
      "type" => "file_failed",
      "entityId" => entity_id,
      "cid" => cid,
      "message" => message
    })
  end

  @spec send_to_peer(binary(), map()) :: :ok
  def send_to_peer(peer_id, message) when is_binary(peer_id) and is_map(message) do
    case Store.peer_pid(@session, peer_id) do
      nil -> :ok
      pid -> send(pid, {:proto_send, Protocol.encode(message)})
    end
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  def send_to_peer(_peer_id, _message), do: :ok

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
