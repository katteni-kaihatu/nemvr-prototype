defmodule ProtoServer.Turn do
  @moduledoc """
  TURN REST credentials for the `iceServers` field of the `welcome` message.
  """

  @default_port 3478
  @default_ttl_seconds 6 * 60 * 60
  @google_stun "stun:stun.l.google.com:19302"

  @type config :: %{
          host: binary(),
          port: integer(),
          secret: binary(),
          ttl_seconds: integer()
        }

  @spec config() :: config() | nil
  def config do
    with host when is_binary(host) <- ProtoServer.Config.get(:turn_host),
         secret when is_binary(secret) <- ProtoServer.Config.get(:turn_secret) do
      host = String.trim(host)
      secret = String.trim(secret)

      if host == "" or secret == "" do
        nil
      else
        %{
          host: host,
          port: integer_or(ProtoServer.Config.get(:turn_port), @default_port),
          secret: secret,
          ttl_seconds: integer_or(ProtoServer.Config.get(:turn_ttl_seconds), @default_ttl_seconds)
        }
      end
    else
      _ -> nil
    end
  end

  @spec ice_servers(binary()) :: [map()] | nil
  def ice_servers(user_id), do: ice_servers(user_id, System.system_time(:millisecond))

  @spec ice_servers(binary(), integer()) :: [map()] | nil
  def ice_servers(user_id, now_ms) do
    case config() do
      nil ->
        nil

      config ->
        expiry = div(now_ms, 1000) + config.ttl_seconds
        username = "#{expiry}:#{user_id}"
        credential = Base.encode64(:crypto.mac(:hmac, :sha, config.secret, username))
        origin = "#{config.host}:#{config.port}"

        [
          %{"urls" => ["stun:" <> origin, @google_stun]},
          %{
            "urls" => [
              "turn:" <> origin <> "?transport=udp",
              "turn:" <> origin <> "?transport=tcp"
            ],
            "username" => username,
            "credential" => credential
          }
        ]
    end
  end

  defp integer_or(value, _default) when is_integer(value), do: value
  defp integer_or(_value, default), do: default
end
