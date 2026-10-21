defmodule ProtoServer.Config do
  @moduledoc """
  Runtime configuration for the OTP server.

  Values are populated by `config/runtime.exs` from environment variables and
  read through `Application.get_env/3` on every call. Keeping reads dynamic makes
  the values easy to override in tests and in a release without recompilation.
  """

  @defaults %{
    host: "0.0.0.0",
    port: 8080,
    ipfs_port: 8081,
    ipfs_public_port: 8081,
    ipfs_api_url: "http://127.0.0.1:5001",
    ipfs_gateway_url: "http://127.0.0.1:8082",
    ipfs_peer_id: nil,
    content_max_total_mb: 20_480,
    turn_host: nil,
    turn_port: 3478,
    turn_secret: nil,
    turn_ttl_seconds: 21_600,
    max_concurrent_verify: 4,
    max_pending_per_peer: 16
  }

  @type key ::
          :host
          | :port
          | :ipfs_port
          | :ipfs_public_port
          | :ipfs_api_url
          | :ipfs_gateway_url
          | :ipfs_peer_id
          | :content_max_total_mb
          | :turn_host
          | :turn_port
          | :turn_secret
          | :turn_ttl_seconds
          | :max_concurrent_verify
          | :max_pending_per_peer

  @spec get(atom()) :: term()
  def get(key), do: Application.get_env(:proto_server, key, default(key))

  @spec port() :: non_neg_integer()
  def port, do: get(:port)

  @spec host() :: binary()
  def host, do: get(:host)

  @doc """
  IPFS connection information advertised to clients in the `welcome` message.

  `peerId` prefers the configured `IPFS_PEER_ID`, then a value cached by
  `ProtoServer.Ipfs` (via `put_ipfs_peer_id/1`), and finally `"unavailable"`.
  The server can still start for WebSocket-only use when Kubo is absent.
  """
  @spec ipfs_info() :: %{binary() => binary() | non_neg_integer()}
  def ipfs_info do
    %{
      "peerId" => get(:ipfs_peer_id) || cached_ipfs_peer_id() || "unavailable",
      "wsPort" => get(:ipfs_public_port)
    }
  end

  @doc "Cache the peer ID discovered from Kubo (`/api/v0/id`)."
  @spec put_ipfs_peer_id(binary()) :: :ok
  def put_ipfs_peer_id(peer_id) when is_binary(peer_id) do
    :persistent_term.put({__MODULE__, :ipfs_peer_id}, peer_id)
    :ok
  end

  @spec default(atom()) :: term()
  def default(key), do: Map.get(@defaults, key)

  defp cached_ipfs_peer_id do
    :persistent_term.get({__MODULE__, :ipfs_peer_id}, nil)
  end
end
