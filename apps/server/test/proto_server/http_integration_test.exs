defmodule ProtoServer.HttpIntegrationTest do
  use ExUnit.Case, async: false

  alias ProtoServer.{Content, Room}

  setup do
    start_supervised!(
      {Room,
       seed: false,
       ipfs_info: %{"peerId" => "test", "wsPort" => 8081},
       ice_servers_fun: fn _ -> nil end}
    )

    start_supervised!(Content)

    %{port: :sys.get_state(ProtoServer.HttpServer).port}
  end

  test "unknown media and non-media paths return 404", %{port: port} do
    assert {404, _headers, "not found"} = request(port, "/media/deadbeef")
    assert {404, _headers, "not found"} = request(port, "/not-media")
  end

  test "unsupported media methods return 405 with an Allow header", %{port: port} do
    assert {405, headers, ""} = request(port, "/media/deadbeef", :post)
    assert header(headers, "allow") == "GET, HEAD"
  end

  test "an unsatisfiable range returns 416 without contacting the gateway", %{port: port} do
    assert {:ok, _object} =
             Room.add_file(%{
               "cid" => "bafy-range",
               "name" => "clip.mp4",
               "position" => [0, 0, 0],
               "yaw" => 0,
               "size" => 10,
               "category" => "video",
               "stored" => true
             })

    assert {416, headers, ""} = request(port, "/media/bafy-range", :get, "bytes=100-")
    assert header(headers, "content-range") == "bytes */10"
  end

  test "a stored file returns 500 when the Kubo gateway is unreachable", %{port: port} do
    assert {:ok, _object} =
             Room.add_file(%{
               "cid" => "bafy-gateway",
               "name" => "clip.mp4",
               "position" => [0, 0, 0],
               "yaw" => 0,
               "size" => 10,
               "category" => "video",
               "stored" => true
             })

    assert {500, _headers, "internal server error"} = request(port, "/media/bafy-gateway")
  end

  defp request(port, path, method \\ :get, range \\ nil) do
    headers =
      case range do
        nil -> []
        value -> [{"range", value}]
      end

    request = Finch.build(method, "http://127.0.0.1:#{port}" <> path, headers)

    {:ok, %{status: status, headers: response_headers, body: body}} =
      Finch.request(request, ProtoServer.Finch, receive_timeout: 5_000)

    {status, response_headers, body}
  end

  defp header(headers, name) do
    Enum.find_value(headers, fn {key, value} ->
      if String.downcase(key) == name, do: value, else: nil
    end)
  end
end
