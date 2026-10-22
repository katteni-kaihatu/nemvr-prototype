defmodule ProtoServer.UrlFetch do
  @moduledoc """
  Fetch a pasted URL with SSRF protection and media detection.

  Only public `http(s)` destinations are allowed. Redirects are followed
  manually (at most three) and every hop is revalidated. Images, audio and
  video are downloaded with a size cap; everything else becomes a link without
  reading the body.
  """

  import Bitwise

  require Logger

  alias ProtoServer.Media

  @max_url_length 2_048
  @fetch_timeout_ms 120_000
  @max_redirects 3
  @image_max_bytes 24 * 1024 * 1024
  @media_max_bytes 128 * 1024 * 1024
  @image_long_edge 2.5
  @min_object_size 0.1

  @image_extensions ~r/\.(png|jpe?g|gif|webp)$/i
  @video_extensions ~r/\.(mp4|m4v|webm|mov|mkv|ogv)$/i
  @audio_extensions ~r/\.(mp3|m4a|ogg|oga|wav|flac)$/i
  @illegal_name_characters ~r/[\\\/:*?"<>|\x00-\x1F]/
  @has_extension ~r/\.[A-Za-z0-9]{1,8}$/
  @hostname_characters ~r/[^A-Za-z0-9.-]/

  @type fetched :: %{binary() => term()}

  @spec fetch(binary()) :: {:ok, fetched()} | {:error, binary()}
  def fetch(url) when is_binary(url) do
    with {:ok, uri} <- assert_public_url(url) do
      deadline = now_ms() + @fetch_timeout_ms
      do_fetch(uri, 0, deadline)
    end
  end

  def fetch(_url), do: {:error, "URL が正しくありません"}

  @doc """
  True when the address is private, reserved, link-local or otherwise unsafe.

  Unknown values are treated as private so that a failed parse cannot turn into
  an SSRF path.
  """
  @spec is_private_address(binary()) :: boolean()
  def is_private_address(address) when is_binary(address) do
    value = address |> String.trim() |> String.downcase()

    case :inet.parse_address(String.to_charlist(value)) do
      {:ok, tuple} -> private_address?(tuple)
      {:error, _} -> true
    end
  end

  def is_private_address(_address), do: true

  @doc """
  Build a safe display/download name from the final URL and content type.
  """
  @spec file_name_from_url(binary(), binary()) :: binary()
  def file_name_from_url(url, content_type \\ "") do
    content_type =
      content_type
      |> String.split(";", parts: 2)
      |> List.first()
      |> String.trim()
      |> String.downcase()

    {pathname, hostname} =
      case URI.parse(url) do
        %URI{path: path, host: host} -> {path || "", host || "link"}
        _ -> {"", "link"}
      end

    from_path =
      pathname
      |> String.split("/")
      |> Enum.reject(&(&1 == ""))
      |> List.last()
      |> decode_segment()

    from_path =
      from_path
      |> String.replace(@illegal_name_characters, "_")
      |> String.trim()

    name =
      if from_path == "" do
        String.replace(hostname, @hostname_characters, "_")
      else
        from_path
      end

    extension = extension_for(content_type)

    name =
      if extension != "" and
           (from_path == "" or not Regex.match?(@has_extension, name)) do
        name <> extension
      else
        name
      end

    String.slice(name, 0, 80)
  end

  defp decode_segment(nil), do: ""

  defp decode_segment(segment) do
    URI.decode(segment)
  rescue
    _ -> segment
  end

  defp assert_public_url(input) do
    cond do
      String.length(input) > @max_url_length ->
        {:error, "URL が長すぎます"}

      true ->
        case parse_uri(input) do
          {:ok, uri} -> validate_uri(uri)
          :error -> {:error, "URL が正しくありません"}
        end
    end
  end

  defp parse_uri(input) do
    uri = URI.parse(input)

    if is_nil(uri.scheme) and is_nil(uri.host) do
      :error
    else
      {:ok, uri}
    end
  rescue
    _ -> :error
  end

  defp validate_uri(uri) do
    scheme = if is_binary(uri.scheme), do: String.downcase(uri.scheme), else: ""
    host = uri.host || ""

    cond do
      scheme not in ["http", "https"] ->
        {:error, "http(s) の URL だけを貼れます"}

      uri.userinfo != nil ->
        {:error, "認証情報を含む URL は使えません"}

      host == "" or String.contains?(host, [" ", "\t", "\n", "\r"]) ->
        {:error, "URL が正しくありません"}

      true ->
        validate_host(uri, host)
    end
  end

  defp validate_host(uri, host) do
    lower = String.downcase(host)

    if lower == "localhost" or String.ends_with?(lower, ".local") or
         String.ends_with?(lower, ".internal") or
         String.ends_with?(lower, ".home.arpa") do
      {:error, "この URL は取得できません"}
    else
      case :inet.parse_address(String.to_charlist(host)) do
        {:ok, tuple} ->
          if private_address?(tuple) do
            {:error, "この URL は取得できません"}
          else
            {:ok, uri}
          end

        {:error, _} ->
          resolve_host(uri, host)
      end
    end
  end

  defp resolve_host(uri, host) do
    addresses = lookup_addresses(host)

    cond do
      addresses == [] ->
        {:error, "URL のホストを解決できませんでした"}

      Enum.any?(addresses, &private_address?/1) ->
        {:error, "この URL は取得できません"}

      true ->
        {:ok, uri}
    end
  end

  defp lookup_addresses(host) do
    charlist = String.to_charlist(host)

    ipv4 =
      case :inet.getaddrs(charlist, :inet) do
        {:ok, addresses} -> addresses
        _ -> []
      end

    ipv6 =
      case :inet.getaddrs(charlist, :inet6) do
        {:ok, addresses} -> addresses
        _ -> []
      end

    ipv4 ++ ipv6
  rescue
    _ -> []
  catch
    _, _ -> []
  end

  defp private_address?({a, b, _c, _d}) do
    cond do
      a == 0 -> true
      a == 10 -> true
      a == 127 -> true
      a == 169 and b == 254 -> true
      a == 172 and b >= 16 and b <= 31 -> true
      a == 192 and b == 168 -> true
      a == 100 and b >= 64 and b <= 127 -> true
      a == 192 and b == 0 -> true
      a == 198 and b in [18, 19] -> true
      a >= 224 -> true
      true -> false
    end
  end

  defp private_address?({a, b, c, d, e, f, g, h}) do
    cond do
      a == 0 and b == 0 and c == 0 and d == 0 and e == 0 and f == 0 and g == 0 and h == 0 ->
        true

      a == 0 and b == 0 and c == 0 and d == 0 and e == 0 and f == 0 and g == 0 and h == 1 ->
        true

      a == 0 and b == 0 and c == 0 and d == 0 and e == 0 and f == 0xFFFF ->
        private_address?({g >>> 8, g &&& 0xFF, h >>> 8, h &&& 0xFF})

      (a &&& 0xFE00) == 0xFC00 ->
        true

      (a &&& 0xFFC0) == 0xFE80 ->
        true

      a == 0x2001 and b == 0x0DB8 ->
        true

      (a &&& 0xFF00) == 0xFF00 ->
        true

      true ->
        false
    end
  end

  defp private_address?(_other), do: true

  defp do_fetch(uri, redirects, deadline) do
    remaining = deadline - now_ms()

    if remaining <= 0 do
      {:error, "URL の取得がタイムアウトしました"}
    else
      request =
        Finch.build(:get, URI.to_string(uri), [
          {"user-agent", "vr-sns-prototype/1.0"},
          {"accept", "*/*"}
        ])

      acc = %{
        uri: uri,
        status: nil,
        headers: [],
        kind: nil,
        name: "",
        content_type: "",
        limit: nil,
        total: 0,
        chunks: [],
        too_large: false
      }

      fun = &handle_event/2

      case Finch.stream_while(request, ProtoServer.Finch, acc, fun,
             receive_timeout: remaining,
             request_timeout: remaining
           ) do
        {:ok, acc} -> finish_stream(acc, redirects, deadline)
        {:error, reason, _acc} -> stream_error(reason, deadline)
      end
    end
  end

  defp handle_event({:status, status}, acc), do: {:cont, %{acc | status: status}}

  defp handle_event({:headers, headers}, acc) do
    acc = %{acc | headers: headers}

    cond do
      is_integer(acc.status) and acc.status >= 300 and acc.status < 400 ->
        {:halt, acc}

      is_integer(acc.status) and (acc.status < 200 or acc.status >= 300) ->
        {:halt, acc}

      true ->
        content_type = content_type_of(headers)
        name = file_name_from_url(URI.to_string(acc.uri), content_type)
        kind = media_kind(name, content_type)

        acc = %{acc | content_type: content_type, name: name, kind: kind}

        if kind == :link do
          {:halt, acc}
        else
          limit = if kind == :image, do: @image_max_bytes, else: @media_max_bytes

          case header_integer(headers, "content-length") do
            {:ok, declared} when declared > limit ->
              {:halt, %{acc | limit: limit, too_large: true}}

            _ ->
              {:cont, %{acc | limit: limit}}
          end
        end
    end
  end

  defp handle_event({:data, chunk}, %{limit: limit} = acc) when is_integer(limit) do
    total = acc.total + byte_size(chunk)

    if total > limit do
      {:halt, %{acc | too_large: true}}
    else
      {:cont, %{acc | total: total, chunks: [chunk | acc.chunks]}}
    end
  end

  defp handle_event(_event, acc), do: {:cont, acc}

  defp finish_stream(%{status: status} = acc, redirects, deadline)
       when is_integer(status) and status >= 300 and status < 400 do
    case header_value(acc.headers, "location") do
      nil ->
        {:error, "リダイレクト先がありません"}

      location ->
        if redirects >= @max_redirects do
          {:error, "リダイレクトが多すぎます"}
        else
          resolve_redirect(acc.uri, location, redirects + 1, deadline)
        end
    end
  end

  defp finish_stream(%{status: nil}, _redirects, _deadline) do
    {:error, "URL を取得できませんでした"}
  end

  defp finish_stream(%{status: status}, _redirects, _deadline)
       when is_integer(status) and (status < 200 or status >= 300) do
    {:error, "URL を取得できませんでした (HTTP #{status})"}
  end

  defp finish_stream(%{too_large: true, kind: :image} = acc, _redirects, _deadline) do
    _ = acc
    {:error, "画像が大きすぎます (上限 #{Media.format_bytes(@image_max_bytes)})"}
  end

  defp finish_stream(%{too_large: true} = acc, _redirects, _deadline) do
    _ = acc
    {:error, "URL のファイルが大きすぎます (上限 #{Media.format_bytes(@media_max_bytes)})"}
  end

  defp finish_stream(%{kind: :link} = acc, _redirects, _deadline) do
    {:ok, link_result(acc)}
  end

  defp finish_stream(%{kind: :image} = acc, _redirects, _deadline) do
    bytes = acc.chunks |> Enum.reverse() |> IO.iodata_to_binary()
    finish_image(acc, bytes)
  end

  defp finish_stream(%{kind: kind} = acc, _redirects, _deadline)
       when kind in [:video, :audio] do
    bytes = acc.chunks |> Enum.reverse() |> IO.iodata_to_binary()

    {:ok,
     %{
       "kind" => Atom.to_string(kind),
       "url" => URI.to_string(acc.uri),
       "name" => acc.name,
       "contentType" => acc.content_type,
       "size" => byte_size(bytes),
       "bytes" => bytes
     }}
  end

  defp finish_stream(_acc, _redirects, _deadline) do
    {:error, "URL を取得できませんでした"}
  end

  defp finish_image(acc, bytes) do
    with type when type != nil <- Media.sniff_image_type(bytes),
         {:ok, width, height} <- Media.image_size(bytes),
         true <- width > 0 and height > 0 do
      scale = @image_long_edge / max(width, height)
      scaled_width = width * scale
      scaled_height = height * scale

      if min(scaled_width, scaled_height) < @min_object_size do
        {:ok, link_result(acc)}
      else
        {:ok,
         %{
           "kind" => "image",
           "url" => URI.to_string(acc.uri),
           "name" => acc.name,
           "contentType" => acc.content_type,
           "size" => byte_size(bytes),
           "bytes" => bytes,
           "width" => scaled_width,
           "height" => scaled_height
         }}
      end
    else
      _ -> {:ok, link_result(acc)}
    end
  end

  defp link_result(acc) do
    %{
      "kind" => "link",
      "url" => URI.to_string(acc.uri),
      "name" => acc.name,
      "contentType" => acc.content_type,
      "size" => 0
    }
  end

  defp resolve_redirect(current, location, redirects, deadline) do
    resolved =
      try do
        URI.merge(current, location)
      rescue
        _ -> nil
      end

    case resolved do
      nil ->
        {:error, "URL が正しくありません"}

      uri ->
        case assert_public_url(URI.to_string(uri)) do
          {:ok, next} -> do_fetch(next, redirects, deadline)
          {:error, message} -> {:error, message}
        end
    end
  end

  defp stream_error(_reason, deadline) do
    if now_ms() >= deadline do
      {:error, "URL の取得がタイムアウトしました"}
    else
      {:error, "URL を取得できませんでした"}
    end
  end

  defp media_kind(name, content_type) do
    image = String.starts_with?(content_type, "image/") or Regex.match?(@image_extensions, name)
    video = String.starts_with?(content_type, "video/") or Regex.match?(@video_extensions, name)
    audio = String.starts_with?(content_type, "audio/") or Regex.match?(@audio_extensions, name)

    cond do
      image -> :image
      video -> :video
      audio -> :audio
      true -> :link
    end
  end

  defp content_type_of(headers) do
    case header_value(headers, "content-type") do
      nil ->
        ""

      value ->
        value |> String.split(";", parts: 2) |> List.first() |> String.trim() |> String.downcase()
    end
  end

  defp extension_for(content_type) do
    Map.get(
      %{
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "video/mp4" => ".mp4",
        "video/webm" => ".webm",
        "video/quicktime" => ".mov",
        "video/ogg" => ".ogv",
        "audio/mpeg" => ".mp3",
        "audio/mp4" => ".m4a",
        "audio/ogg" => ".ogg",
        "audio/wav" => ".wav",
        "audio/flac" => ".flac"
      },
      content_type,
      ""
    )
  end

  defp header_value(headers, name) do
    Enum.find_value(headers, fn
      {key, value} -> if String.downcase(key) == name, do: value, else: nil
      _ -> nil
    end)
  end

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

  defp now_ms, do: System.monotonic_time(:millisecond)
end
