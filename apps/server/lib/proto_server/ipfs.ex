defmodule ProtoServer.Ipfs do
  @moduledoc """
  HTTP client for the local Kubo node plus the peer-id discovery process.

  Kubo owns the libp2p node, block store, pinning and gateway. The OTP server
  talks to the API (`/api/v0/...`) and the gateway over `ProtoServer.Finch`.
  Every public function returns an error tuple instead of raising.
  """

  use GenServer

  require Logger

  alias ProtoServer.Config

  @default_api_url "http://127.0.0.1:5001"
  @default_gateway_url "http://127.0.0.1:8082"
  @id_timeout_ms 2_000
  @retry_interval_ms 30_000
  @pin_timeout_ms 3_600_000
  @add_timeout_ms 300_000
  @stream_timeout_ms 3_600_000

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec peer_id() :: binary()
  def peer_id do
    case Process.whereis(__MODULE__) do
      nil -> configured_peer_id() || "unavailable"
      _pid -> GenServer.call(__MODULE__, :peer_id)
    end
  end

  @spec available?() :: boolean()
  def available? do
    case Process.whereis(__MODULE__) do
      nil -> configured_peer_id() != nil
      _pid -> GenServer.call(__MODULE__, :available?)
    end
  end

  @spec stat(binary()) :: {:ok, integer()} | {:error, term()}
  def stat(cid), do: guard("stat #{cid}", fn -> do_stat(cid) end)

  @spec head(binary(), non_neg_integer()) :: {:ok, binary(), integer()} | {:error, term()}
  def head(cid, count), do: guard("head #{cid}", fn -> do_head(cid, count) end)

  @spec pin(binary(), non_neg_integer()) :: :ok | {:error, term()}
  def pin(cid, timeout_ms \\ @pin_timeout_ms),
    do: guard("pin #{cid}", fn -> do_pin(cid, timeout_ms) end)

  @spec unpin(binary()) :: :ok | {:error, term()}
  def unpin(cid), do: guard("unpin #{cid}", fn -> do_unpin(cid) end)

  @spec has?(binary()) :: boolean()
  def has?(cid) do
    case guard("has #{cid}", fn -> do_has(cid) end) do
      {:ok, present?} -> present?
      _ -> false
    end
  end

  @spec gc() :: :ok | {:error, term()}
  def gc, do: guard("gc", fn -> do_gc() end)

  @spec add_bytes(binary()) :: {:ok, binary(), integer()} | {:error, term()}
  def add_bytes(bytes), do: guard("add_bytes", fn -> do_add_bytes(bytes) end)

  @spec stream_range(binary(), non_neg_integer(), non_neg_integer(), (binary() ->
                                                                        :ok | {:error, term()})) ::
          :ok | {:error, term()}
  def stream_range(cid, start, length, fun) do
    guard("stream_range #{cid}", fn -> do_stream_range(cid, start, length, fun) end)
  end

  @impl true
  def init(_opts) do
    case configured_peer_id() do
      nil ->
        case discover_peer_id() do
          {:ok, peer_id} ->
            Config.put_ipfs_peer_id(peer_id)
            {:ok, %{peer_id: peer_id, available: true, retry_timer: nil}}

          {:error, reason} ->
            log_unavailable(reason)
            timer = Process.send_after(self(), :retry_peer_id, @retry_interval_ms)
            {:ok, %{peer_id: "unavailable", available: false, retry_timer: timer}}
        end

      peer_id ->
        {:ok, %{peer_id: peer_id, available: true, retry_timer: nil}}
    end
  end

  @impl true
  def handle_call(:peer_id, _from, state), do: {:reply, state.peer_id, state}

  def handle_call(:available?, _from, state), do: {:reply, state.available, state}

  @impl true
  def handle_info(:retry_peer_id, state) do
    case discover_peer_id() do
      {:ok, peer_id} ->
        Config.put_ipfs_peer_id(peer_id)
        Logger.info("Kubo is available; peer id #{peer_id}")
        {:noreply, %{state | peer_id: peer_id, available: true, retry_timer: nil}}

      {:error, reason} ->
        log_unavailable(reason)
        timer = Process.send_after(self(), :retry_peer_id, @retry_interval_ms)
        {:noreply, %{state | available: false, retry_timer: timer}}
    end
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp discover_peer_id do
    task = Task.async(fn -> request_peer_id() end)

    case Task.yield(task, @id_timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} -> result
      nil -> {:error, :timeout}
      {:exit, reason} -> {:error, reason}
    end
  end

  defp request_peer_id do
    try do
      request = Finch.build(:post, api_url() <> "/api/v0/id")

      case Finch.request(request, ProtoServer.Finch, receive_timeout: @id_timeout_ms) do
        {:ok, %{status: 200, body: body}} ->
          case Jason.decode(body) do
            {:ok, %{"ID" => peer_id}} when is_binary(peer_id) and peer_id != "" ->
              {:ok, peer_id}

            {:ok, _} ->
              {:error, :missing_peer_id}

            {:error, reason} ->
              {:error, reason}
          end

        {:ok, %{status: status}} ->
          {:error, {:http_status, status}}

        {:error, reason} ->
          {:error, reason}
      end
    rescue
      error -> {:error, error}
    catch
      kind, reason -> {:error, {kind, reason}}
    end
  end

  defp log_unavailable(reason) do
    Logger.warning(
      "Kubo is unavailable (POST /api/v0/id failed: #{inspect(reason)}); " <>
        "retrying every #{div(@retry_interval_ms, 1000)}s"
    )
  end

  defp do_stat(cid) do
    url = gateway_url() <> "/ipfs/" <> encode_cid(cid)

    request =
      Finch.build(:head, url, [
        {"accept-encoding", "identity"}
      ])

    case Finch.request(request, ProtoServer.Finch, receive_timeout: 60_000) do
      {:ok, %{status: status, headers: headers}} when status in [200, 206] ->
        case header_integer(headers, "content-length") do
          {:ok, size} ->
            {:ok, size}

          :error ->
            stat_from_range(url)
        end

      {:ok, %{status: status}} ->
        {:error, {:http_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp stat_from_range(url) do
    request = Finch.build(:get, url, [{"range", "bytes=0-0"}, {"accept-encoding", "identity"}])

    case Finch.request(request, ProtoServer.Finch, receive_timeout: 60_000) do
      {:ok, %{status: status, headers: headers}} when status in [200, 206] ->
        case content_range_total(headers) do
          {:ok, total} -> {:ok, total}
          :error -> {:error, :unknown_size}
        end

      {:ok, %{status: status}} ->
        {:error, {:http_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp do_head(cid, count) when is_integer(count) and count > 0 do
    url = gateway_url() <> "/ipfs/" <> encode_cid(cid)
    last = count - 1

    request =
      Finch.build(:get, url, [
        {"range", "bytes=0-#{last}"},
        {"accept-encoding", "identity"}
      ])

    case Finch.request(request, ProtoServer.Finch, receive_timeout: 60_000) do
      {:ok, %{status: 200, body: body}} ->
        {:ok, body, byte_size(body)}

      {:ok, %{status: 206, body: body, headers: headers}} ->
        case content_range_total(headers) do
          {:ok, total} -> {:ok, body, total}
          :error -> {:error, :unknown_size}
        end

      {:ok, %{status: status}} ->
        {:error, {:http_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp do_head(_cid, _count), do: {:error, :invalid_range}

  defp do_pin(cid, timeout_ms) do
    request =
      Finch.build(
        :post,
        api_url() <> "/api/v0/pin/add?arg=" <> encode_cid(cid) <> "&recursive=true"
      )

    case Finch.request(request, ProtoServer.Finch, receive_timeout: timeout_ms) do
      {:ok, %{status: 200}} ->
        _ = do_provide(cid, 10_000)
        :ok

      {:ok, %{body: body}} ->
        if already_pinned?(body) do
          _ = do_provide(cid, 10_000)
          :ok
        else
          {:error, body}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp do_provide(cid, timeout_ms) do
    request =
      Finch.build(
        :post,
        api_url() <> "/api/v0/routing/provide?arg=" <> encode_cid(cid)
      )

    case Finch.request(request, ProtoServer.Finch, receive_timeout: timeout_ms) do
      {:ok, %{status: 200}} -> :ok
      {:ok, %{status: status}} -> {:error, {:http_status, status}}
      {:error, reason} -> {:error, reason}
    end
  end

  defp do_unpin(cid) do
    request =
      Finch.build(:post, api_url() <> "/api/v0/pin/rm?arg=" <> encode_cid(cid))

    case Finch.request(request, ProtoServer.Finch, receive_timeout: 60_000) do
      {:ok, %{status: 200}} ->
        :ok

      {:ok, %{body: body}} ->
        if not_pinned?(body), do: :ok, else: {:error, body}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp do_has(cid) do
    request =
      Finch.build(:post, api_url() <> "/api/v0/block/stat?arg=" <> encode_cid(cid))

    case Finch.request(request, ProtoServer.Finch, receive_timeout: 30_000) do
      {:ok, %{status: 200}} -> {:ok, true}
      {:ok, %{status: _status}} -> {:ok, false}
      {:error, reason} -> {:error, reason}
    end
  end

  defp do_gc do
    request = Finch.build(:post, api_url() <> "/api/v0/repo/gc")

    fun = fn
      {:status, status}, acc -> {:cont, %{acc | status: status}}
      _event, acc -> {:cont, acc}
    end

    case Finch.stream_while(request, ProtoServer.Finch, %{status: nil}, fun,
           receive_timeout: @stream_timeout_ms
         ) do
      {:ok, %{status: 200}} -> :ok
      {:ok, %{status: status}} -> {:error, {:http_status, status}}
      {:error, reason, _acc} -> {:error, reason}
    end
  end

  defp do_add_bytes(bytes) when is_binary(bytes) do
    boundary = "proto-" <> Base.encode16(:crypto.strong_rand_bytes(12), case: :lower)

    body = [
      "--",
      boundary,
      "\r\n",
      "Content-Disposition: form-data; name=\"file\"; filename=\"blob\"\r\n",
      "Content-Type: application/octet-stream\r\n\r\n",
      bytes,
      "\r\n--",
      boundary,
      "--\r\n"
    ]

    request =
      Finch.build(
        :post,
        api_url() <> "/api/v0/add?pin=false&cid-version=1&raw-leaves=true&chunker=size-262144",
        [{"content-type", "multipart/form-data; boundary=" <> boundary}],
        body
      )

    case Finch.request(request, ProtoServer.Finch, receive_timeout: @add_timeout_ms) do
      {:ok, %{status: 200, body: response_body}} ->
        with {:ok, hash, size} <- parse_add_response(response_body),
             :ok <- do_pin(hash, @pin_timeout_ms) do
          {:ok, hash, size}
        end

      {:ok, %{status: status, body: response_body}} ->
        {:error, {:http_status, status, response_body}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp do_add_bytes(_bytes), do: {:error, :invalid_body}

  defp parse_add_response(body) do
    body
    |> String.split("\n", trim: true)
    |> Enum.reverse()
    |> Enum.find_value(fn line ->
      case Jason.decode(line) do
        {:ok, %{"Hash" => hash} = object} when is_binary(hash) ->
          {hash, parse_size(Map.get(object, "Size"))}

        _ ->
          nil
      end
    end)
    |> case do
      {hash, {:ok, size}} -> {:ok, hash, size}
      {_hash, :error} -> {:error, :invalid_add_response}
      nil -> {:error, :invalid_add_response}
    end
  end

  defp do_stream_range(cid, start, length, fun) do
    url = gateway_url() <> "/ipfs/" <> encode_cid(cid)
    last = start + length - 1

    request =
      Finch.build(:get, url, [
        {"range", "bytes=#{start}-#{last}"},
        {"accept-encoding", "identity"}
      ])

    initial = %{status: nil, fun: fun, error: nil}
    fun_acc = &handle_stream_event/2

    case Finch.stream_while(request, ProtoServer.Finch, initial, fun_acc,
           receive_timeout: @stream_timeout_ms
         ) do
      {:ok, %{error: error}} when not is_nil(error) -> {:error, error}
      {:ok, %{status: status}} when status in [200, 206] -> :ok
      {:ok, %{status: status}} -> {:error, {:http_status, status}}
      {:error, _reason, %{error: error}} when not is_nil(error) -> {:error, error}
      {:error, reason, _acc} -> {:error, reason}
    end
  end

  defp handle_stream_event({:status, status}, acc), do: {:cont, %{acc | status: status}}

  defp handle_stream_event({:data, chunk}, %{status: status} = acc)
       when status in [200, 206] do
    case acc.fun.(chunk) do
      {:error, reason} -> {:halt, %{acc | error: reason}}
      _ -> {:cont, acc}
    end
  end

  defp handle_stream_event(_event, acc), do: {:cont, acc}

  defp header_integer(headers, name) do
    case header_value(headers, name) do
      nil ->
        :error

      value ->
        case Integer.parse(String.trim(value)) do
          {number, ""} when number >= 0 -> {:ok, number}
          _ -> :error
        end
    end
  end

  defp content_range_total(headers) do
    case header_value(headers, "content-range") do
      nil ->
        :error

      value ->
        case Regex.run(~r/^bytes\s+\d+-\d+\/(\d+)\s*$/i, String.trim(value)) do
          [_, total] ->
            case Integer.parse(total) do
              {number, ""} -> {:ok, number}
              _ -> :error
            end

          _ ->
            :error
        end
    end
  end

  defp header_value(headers, name) do
    Enum.find_value(headers, fn
      {key, value} -> if String.downcase(key) == name, do: value, else: nil
      _ -> nil
    end)
  end

  defp parse_size(value) when is_integer(value) and value >= 0, do: {:ok, value}

  defp parse_size(value) when is_binary(value) do
    case Integer.parse(String.trim(value)) do
      {number, ""} when number >= 0 -> {:ok, number}
      _ -> :error
    end
  end

  defp parse_size(_value), do: :error

  defp already_pinned?(body) do
    is_binary(body) and String.contains?(String.downcase(body), "already pinned")
  end

  defp not_pinned?(body) do
    is_binary(body) and String.contains?(String.downcase(body), "not pinned")
  end

  defp configured_peer_id do
    case Config.get(:ipfs_peer_id) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp api_url do
    case Config.get(:ipfs_api_url) do
      value when is_binary(value) and value != "" -> String.trim_trailing(value, "/")
      _ -> @default_api_url
    end
  end

  defp gateway_url do
    case Config.get(:ipfs_gateway_url) do
      value when is_binary(value) and value != "" -> String.trim_trailing(value, "/")
      _ -> @default_gateway_url
    end
  end

  defp encode_cid(cid), do: URI.encode(cid, &URI.char_unreserved?/1)

  defp guard(label, fun) do
    try do
      fun.()
    rescue
      error ->
        Logger.warning("[ipfs] #{label} failed: #{Exception.message(error)}")
        {:error, {:exception, Exception.message(error)}}
    catch
      kind, reason ->
        Logger.warning("[ipfs] #{label} failed: #{inspect({kind, reason})}")
        {:error, {kind, reason}}
    end
  end
end
