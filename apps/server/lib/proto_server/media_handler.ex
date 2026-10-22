defmodule ProtoServer.MediaHandler do
  @moduledoc """
  HTTP handler for `GET|HEAD /media/<cid>` and `POST /media/upload`.

  `GET|HEAD` looks up a stored file or image, parses one `Range: bytes=...`
  header and streams only that range from the Kubo gateway. `POST /media/upload`
  is the fallback for an image that Kubo could not fetch from the uploader's
  browser; it pins the bytes and marks existing provisional images as stored.
  """

  @behaviour :cowboy_handler

  require Logger

  alias ProtoServer.{Content, Ipfs, Media}
  alias ProtoServer.Space.Store

  @max_image_bytes 24 * 1024 * 1024

  @impl :cowboy_handler
  def init(req, state) do
    try do
      handle(req, state)
    rescue
      error ->
        Logger.warning("[media] request failed: #{Exception.message(error)}")
        reply_error(req, state)
    catch
      kind, reason ->
        Logger.warning("[media] request failed: #{inspect({kind, reason})}")
        reply_error(req, state)
    end
  end

  defp handle(req, state) do
    method = :cowboy_req.method(req)
    path = :cowboy_req.path(req)

    cond do
      method == "POST" and path == "/media/upload" ->
        upload(req, state)

      not String.starts_with?(path, "/media/") ->
        reply_not_found(req, state)

      method not in ["GET", "HEAD"] ->
        req =
          :cowboy_req.reply(
            405,
            %{
              "allow" => "GET, HEAD",
              "content-type" => "text/plain; charset=utf-8"
            },
            "",
            req
          )

        {:ok, req, state}

      true ->
        cid =
          path
          |> String.replace_prefix("/media/", "")
          |> URI.decode()

        if cid == "" do
          reply_not_found(req, state)
        else
          serve(req, state, cid, method)
        end
    end
  end

  defp upload(req, state) do
    case :cowboy_req.read_body(req, %{length: @max_image_bytes, period: 10_000}) do
      {:ok, body, req} ->
        cond do
          byte_size(body) == 0 ->
            reply_json(req, state, 400, %{"error" => "empty body"})

          byte_size(body) > @max_image_bytes ->
            reply_json(req, state, 413, %{"error" => "image too large"})

          is_nil(Media.sniff_image_type(body)) ->
            reply_json(req, state, 415, %{"error" => "unsupported image format"})

          true ->
            case Ipfs.add_bytes(body) do
              {:ok, cid, _dag_size} ->
                # `add_bytes` reports the cumulative UnixFS DAG size, which is
                # not the file length. HTTP content-length and range requests
                # need the raw byte length.
                size = byte_size(body)
                Store.mark_image_stored("main", cid, size)
                reply_json(req, state, 200, %{"cid" => cid, "size" => size})

              {:error, reason} ->
                Logger.warning("[media] image upload failed: #{inspect(reason)}")
                reply_json(req, state, 502, %{"error" => "IPFS add failed"})
            end
        end

      {:more, _partial, _req} ->
        reply_json(req, state, 413, %{"error" => "image too large"})

      {:error, reason} ->
        Logger.warning("[media] upload request failed: #{inspect(reason)}")
        reply_json(req, state, 400, %{"error" => "invalid request"})
    end
  end

  defp serve(req, state, cid, method) do
    case find_content(cid) do
      {:ok, %{"size" => size} = object} when is_integer(size) and size > 0 ->
        name = Map.get(object, "name") || cid

        case Media.parse_range(range_header(req), size) do
          :invalid ->
            req =
              :cowboy_req.reply(
                416,
                %{"content-range" => "bytes */#{size}"},
                "",
                req
              )

            {:ok, req, state}

          range ->
            {start, last, status} =
              case range do
                :none -> {0, size - 1, 200}
                {:ok, first, final} -> {first, final, 206}
              end

            length = last - start + 1

            headers = %{
              "content-type" => Media.media_type(name),
              "accept-ranges" => "bytes",
              "content-length" => Integer.to_string(length),
              "cache-control" => "private, max-age=0"
            }

            headers =
              if status == 206 do
                Map.put(headers, "content-range", "bytes #{start}-#{last}/#{size}")
              else
                headers
              end

            if method == "HEAD" do
              case gateway_available?(cid) do
                :ok ->
                  # `cowboy_req:reply/4` overwrites content-length with the
                  # size of the body it is given, which would turn every HEAD
                  # into `content-length: 0`. Send the headers with the real
                  # length and finish the stream without a body instead.
                  req = :cowboy_req.stream_reply(status, headers, req)
                  :ok = :cowboy_req.cast({:data, :fin, <<>>}, req)
                  {:ok, req, state}

                {:error, reason} ->
                  Logger.warning("[media] gateway unavailable for #{cid}: #{inspect(reason)}")
                  reply_error(req, state)
              end
            else
              case gateway_available?(cid) do
                :ok ->
                  stream(req, state, cid, start, length, status, headers)

                {:error, reason} ->
                  Logger.warning("[media] gateway unavailable for #{cid}: #{inspect(reason)}")
                  reply_error(req, state)
              end
            end
        end

      _ ->
        reply_not_found(req, state)
    end
  end

  defp stream(req, state, cid, start, length, status, headers) do
    Content.retain(cid)
    req = :cowboy_req.stream_reply(status, headers, req)

    try do
      result =
        Ipfs.stream_range(cid, start, length, fn chunk ->
          case :cowboy_req.stream_body(chunk, :nofin, req) do
            :ok -> :ok
            {:ok, _req} -> :ok
            {:error, reason} -> {:error, reason}
          end
        end)

      case result do
        :ok ->
          _ = :cowboy_req.stream_body(<<>>, :fin, req)
          :ok

        {:error, reason} ->
          Logger.warning("[media] streaming failed for #{cid}: #{inspect(reason)}")
          :ok
      end
    after
      Content.release(cid)
    end

    {:ok, req, state}
  end

  defp find_content(cid) do
    case Store.find_stored_file("main", cid) do
      {:ok, object} ->
        {:ok, object}

      :error ->
        case Store.find_stored_image("main", cid) do
          {:ok, object} ->
            {:ok, object}

          :error ->
            avatar_content(cid)
        end
    end
  end

  # アバターはワールドのオブジェクトではないため、Kubo 上のサイズを問い合わせて
  # `/media/<cid>` の Range 配信で読めるようにする。
  defp avatar_content(cid) do
    case Store.find_avatar("main", cid) do
      {:ok, object} ->
        case Ipfs.stat(cid) do
          {:ok, size} when is_integer(size) and size > 0 ->
            {:ok, Map.put(object, "size", size)}

          _ ->
            :error
        end

      :error ->
        :error
    end
  end

  defp gateway_available?(cid) do
    case Ipfs.stat(cid) do
      {:ok, _size} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp range_header(req) do
    case :cowboy_req.header("range", req) do
      :undefined -> nil
      value -> value
    end
  end

  defp reply_not_found(req, state) do
    req =
      :cowboy_req.reply(
        404,
        %{"content-type" => "text/plain; charset=utf-8"},
        "not found",
        req
      )

    {:ok, req, state}
  end

  defp reply_json(req, state, status, body) do
    req =
      :cowboy_req.reply(
        status,
        %{"content-type" => "application/json; charset=utf-8"},
        Jason.encode!(body),
        req
      )

    {:ok, req, state}
  end

  defp reply_error(req, state) do
    try do
      req =
        :cowboy_req.reply(
          500,
          %{"content-type" => "text/plain; charset=utf-8"},
          "internal server error",
          req
        )

      {:ok, req, state}
    rescue
      _ -> {:ok, req, state}
    catch
      _, _ -> {:ok, req, state}
    end
  end
end
