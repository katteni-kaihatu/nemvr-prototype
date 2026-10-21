defmodule ProtoServer.HttpServer do
  @moduledoc """
  Starts the single Cowboy listener that serves both HTTP (`/media/...`) and
  WebSocket upgrades (every other path) on `HOST:PORT`.
  """

  use GenServer

  require Logger

  @listener :proto_http

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Process.flag(:trap_exit, true)
    host = ProtoServer.Config.host()
    port = ProtoServer.Config.port()
    ip = resolve_ip(host)

    dispatch =
      :cowboy_router.compile([
        {:_,
         [
           {"/media/[...]", ProtoServer.MediaHandler, []},
           {"/[...]", ProtoServer.WsHandler, []}
         ]}
      ])

    transport_opts = %{
      socket_opts: [ip: ip, port: port],
      num_acceptors: 100,
      max_connections: 1000
    }

    protocol_opts = %{
      env: %{dispatch: dispatch},
      idle_timeout: 60_000
    }

    case :cowboy.start_clear(@listener, transport_opts, protocol_opts) do
      {:ok, _pid} ->
        actual_port = :ranch.get_port(@listener)

        Logger.info(
          "proto_server listening on #{host}:#{actual_port} (HTTP + WebSocket); " <>
            "IPFS ws port #{ProtoServer.Config.get(:ipfs_public_port)}"
        )

        {:ok, %{ip: ip, port: actual_port}}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def terminate(_reason, _state) do
    :cowboy.stop_listener(@listener)
    :ok
  end

  defp resolve_ip(host) when is_binary(host) do
    charlist = String.to_charlist(host)

    case :inet.parse_address(charlist) do
      {:ok, ip} ->
        ip

      {:error, _} ->
        case :inet.getaddr(charlist, :inet) do
          {:ok, ip} -> ip
          {:error, _} -> {0, 0, 0, 0}
        end
    end
  end
end
