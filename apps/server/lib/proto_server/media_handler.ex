defmodule ProtoServer.MediaHandler do
  @moduledoc """
  HTTP handler for `GET|HEAD /media/<cid>`.

  Looks up a stored file object in the room, parses one `Range: bytes=...`
  header and streams only that range from the Kubo gateway. The content
  reference is retained for the duration of the response and released in all
  cases.
  """

  @behaviour :cowboy_handler

  require Logger

  alias ProtoServer.{Content, Ipfs, Media}
  alias ProtoServer.Space.Store

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

  defp serve(req, state, cid, method) do
    case Store.find_stored_file("main", cid) do
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
