defmodule ProtoServer.ConfigTest do
  use ExUnit.Case, async: false

  test "documented defaults are present" do
    assert ProtoServer.Config.default(:host) == "0.0.0.0"
    assert ProtoServer.Config.default(:port) == 8080
    assert ProtoServer.Config.default(:ipfs_port) == 8081
    assert ProtoServer.Config.default(:ipfs_public_port) == 8081
    assert ProtoServer.Config.default(:ipfs_api_url) == "http://127.0.0.1:5001"
    assert ProtoServer.Config.default(:ipfs_gateway_url) == "http://127.0.0.1:8082"
    assert ProtoServer.Config.default(:content_max_total_mb) == 20_480
    assert ProtoServer.Config.default(:turn_port) == 3478
    assert ProtoServer.Config.default(:turn_ttl_seconds) == 21_600
    assert ProtoServer.Config.default(:max_concurrent_verify) == 4
    assert ProtoServer.Config.default(:max_pending_per_peer) == 16
  end

  test "runtime accessors return the configured values" do
    assert is_binary(ProtoServer.Config.host())
    assert is_integer(ProtoServer.Config.port())
    assert is_integer(ProtoServer.Config.get(:ipfs_port))
  end

  test "ipfs_info has the protocol shape and a peer id fallback" do
    info = ProtoServer.Config.ipfs_info()

    assert is_binary(info["peerId"])
    assert info["peerId"] != ""
    assert is_integer(info["wsPort"])
    assert info["wsPort"] == ProtoServer.Config.get(:ipfs_public_port)
  end
end
