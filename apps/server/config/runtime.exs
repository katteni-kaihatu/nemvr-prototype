import Config

parse_int = fn name, default ->
  case System.get_env(name) do
    nil ->
      default

    "" ->
      default

    value ->
      case Integer.parse(value) do
        {int, ""} -> int
        _ -> default
      end
  end
end

non_empty = fn name ->
  case System.get_env(name) do
    nil ->
      nil

    value ->
      trimmed = String.trim(value)
      if trimmed == "", do: nil, else: trimmed
  end
end

ipfs_port = parse_int.("IPFS_PORT", 8081)

config :proto_server,
  host: non_empty.("HOST") || "0.0.0.0",
  port: if(config_env() == :test, do: 0, else: parse_int.("PORT", 8080)),
  ipfs_port: ipfs_port,
  ipfs_public_port: parse_int.("IPFS_PUBLIC_PORT", ipfs_port),
  ipfs_api_url: non_empty.("IPFS_API_URL") || "http://127.0.0.1:5001",
  ipfs_gateway_url: non_empty.("IPFS_GATEWAY_URL") || "http://127.0.0.1:8082",
  ipfs_peer_id: non_empty.("IPFS_PEER_ID"),
  content_max_total_mb: parse_int.("CONTENT_MAX_TOTAL_MB", 20_480),
  turn_host: non_empty.("TURN_HOST"),
  turn_port: parse_int.("TURN_PORT", 3478),
  turn_secret: non_empty.("TURN_SECRET"),
  turn_ttl_seconds: parse_int.("TURN_TTL_SECONDS", 21_600),
  max_concurrent_verify: parse_int.("MAX_CONCURRENT_VERIFY", 4),
  max_pending_per_peer: parse_int.("MAX_PENDING_PER_PEER", 16)
