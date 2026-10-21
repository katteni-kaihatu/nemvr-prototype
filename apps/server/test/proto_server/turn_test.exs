defmodule ProtoServer.TurnTest do
  use ExUnit.Case, async: false

  alias ProtoServer.Turn

  @keys [:turn_host, :turn_port, :turn_secret, :turn_ttl_seconds]

  setup do
    previous =
      for key <- @keys do
        {key, Application.fetch_env(:proto_server, key)}
      end

    on_exit(fn ->
      for {key, value} <- previous do
        case value do
          {:ok, configured} -> Application.put_env(:proto_server, key, configured)
          :error -> Application.delete_env(:proto_server, key)
        end
      end
    end)

    for key <- @keys, do: Application.delete_env(:proto_server, key)

    :ok
  end

  test "config/0 returns nil when TURN is unset" do
    assert Turn.config() == nil
  end

  test "config/0 requires both host and secret" do
    Application.put_env(:proto_server, :turn_host, "turn.example.com")
    assert Turn.config() == nil

    Application.delete_env(:proto_server, :turn_host)
    Application.put_env(:proto_server, :turn_secret, "secret")
    assert Turn.config() == nil
  end

  test "config/0 treats blank host and secret as unset" do
    Application.put_env(:proto_server, :turn_host, "   ")
    Application.put_env(:proto_server, :turn_secret, "secret")
    assert Turn.config() == nil

    Application.put_env(:proto_server, :turn_host, "turn.example.com")
    Application.put_env(:proto_server, :turn_secret, "\t")
    assert Turn.config() == nil
  end

  test "config/0 trims values and applies defaults" do
    Application.put_env(:proto_server, :turn_host, "  turn.example.com  ")
    Application.put_env(:proto_server, :turn_secret, "  topsecret  ")

    assert Turn.config() == %{
             host: "turn.example.com",
             port: 3478,
             secret: "topsecret",
             ttl_seconds: 21_600
           }

    Application.put_env(:proto_server, :turn_port, 5349)
    Application.put_env(:proto_server, :turn_ttl_seconds, 3600)

    assert Turn.config() == %{
             host: "turn.example.com",
             port: 5349,
             secret: "topsecret",
             ttl_seconds: 3600
           }
  end

  test "ice_servers/2 returns nil without configuration" do
    assert Turn.ice_servers("user-1", 1_767_225_600_000) == nil
  end

  test "ice_servers/2 issues deterministic REST credentials" do
    Application.put_env(:proto_server, :turn_host, "turn.example.com")
    Application.put_env(:proto_server, :turn_port, 3478)
    Application.put_env(:proto_server, :turn_secret, "topsecret")
    Application.put_env(:proto_server, :turn_ttl_seconds, 3600)

    # 2026-01-01T00:00:00Z, expiry = 1767229200, HMAC-SHA1("topsecret", "1767229200:user-1")
    assert Turn.ice_servers("user-1", 1_767_225_600_000) == [
             %{"urls" => ["stun:turn.example.com:3478", "stun:stun.l.google.com:19302"]},
             %{
               "urls" => [
                 "turn:turn.example.com:3478?transport=udp",
                 "turn:turn.example.com:3478?transport=tcp"
               ],
               "username" => "1767229200:user-1",
               "credential" => "Wz9IkY8mLYpTc+LoG2YOq/mYpKU="
             }
           ]
  end

  test "ice_servers/2 does not leak the secret and differs per user" do
    Application.put_env(:proto_server, :turn_host, "turn.example.com")
    Application.put_env(:proto_server, :turn_secret, "topsecret")

    servers = Turn.ice_servers("user-1", 0)
    refute inspect(servers) =~ "topsecret"

    [_, first] = Turn.ice_servers("a", 0)
    [_, second] = Turn.ice_servers("b", 0)
    assert first["username"] != second["username"]
    assert first["credential"] != second["credential"]
  end
end
