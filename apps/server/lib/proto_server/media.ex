defmodule ProtoServer.Media do
  @moduledoc """
  Pure helpers for media streaming and file classification.

  Range parsing, MIME lookup, media sniffing, image dimension parsing and byte
  formatting mirror the Node implementation (`media.ts`, `files.ts` and the
  image-size portion of `urlFetch.ts`).
  """

  import Bitwise

  @range_re ~r/^bytes=([0-9]*)-([0-9]*)$/
  @extension_re ~r/^[a-z0-9_+-]{1,10}$/

  @media_types %{
    "mp4" => "video/mp4",
    "m4v" => "video/mp4",
    "webm" => "video/webm",
    "ogv" => "video/ogg",
    "mov" => "video/quicktime",
    "mkv" => "video/x-matroska",
    "mp3" => "audio/mpeg",
    "m4a" => "audio/mp4",
    "ogg" => "audio/ogg",
    "oga" => "audio/ogg",
    "wav" => "audio/wav",
    "flac" => "audio/flac"
  }

  @audio_extensions ~w(mp3 wav ogg oga opus flac aac m4a m4b wma aif aiff mid midi weba amr ape)

  @video_extensions ~w(mp4 m4v webm mkv mov avi wmv flv ogv mpg mpeg 3gp m2ts vob)

  @spec parse_range(nil | binary(), non_neg_integer()) ::
          :none | {:ok, non_neg_integer(), non_neg_integer()} | :invalid
  def parse_range(nil, _size), do: :none

  def parse_range(header, size) when is_binary(header) and is_integer(size) do
    trimmed = String.trim(header)

    case Regex.run(@range_re, trimmed) do
      nil ->
        :invalid

      [_, "", ""] ->
        :invalid

      [_, "", end_text] ->
        with {:ok, suffix} <- parse_integer(end_text),
             true <- suffix > 0,
             start = max(0, size - suffix),
             end_position = size - 1,
             true <- size > 0 and start < size do
          {:ok, start, end_position}
        else
          _ -> :invalid
        end

      [_, start_text, end_text] ->
        with {:ok, start} <- parse_integer(start_text),
             {:ok, raw_end} <- parse_end(end_text, size),
             true <- raw_end >= start,
             end_position = min(raw_end, size - 1),
             true <- size > 0 and start < size do
          {:ok, start, end_position}
        else
          _ -> :invalid
        end
    end
  end

  def parse_range(_header, _size), do: :invalid

  @spec media_type(binary()) :: binary()
  def media_type(name) when is_binary(name) do
    Map.get(@media_types, extension_of(name), "application/octet-stream")
  end

  def media_type(_name), do: "application/octet-stream"

  @spec classify_file(binary(), binary()) :: binary()
  def classify_file(name, head) when is_binary(name) and is_binary(head) do
    case extension_of(name) do
      extension when extension in @audio_extensions -> "audio"
      extension when extension in @video_extensions -> "video"
      _ -> sniff_media_kind(head)
    end
  end

  def classify_file(_name, _head), do: "file"

  @spec sniff_image_type(binary()) :: :png | :jpeg | :gif | :webp | nil
  def sniff_image_type(bytes) when is_binary(bytes) do
    cond do
      starts_with?(bytes, <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A>>) -> :png
      starts_with?(bytes, <<0xFF, 0xD8, 0xFF>>) -> :jpeg
      starts_with?(bytes, "GIF87a") -> :gif
      starts_with?(bytes, "GIF89a") -> :gif
      starts_with?(bytes, "RIFF") and starts_at?(bytes, 8, "WEBP") -> :webp
      true -> nil
    end
  end

  def sniff_image_type(_bytes), do: nil

  @spec image_size(binary()) :: {:ok, integer(), integer()} | :error
  def image_size(bytes) when is_binary(bytes) do
    case sniff_image_type(bytes) do
      :png ->
        if byte_size(bytes) < 24 do
          :error
        else
          {:ok, unsigned_at(bytes, 16, 4, :big), unsigned_at(bytes, 20, 4, :big)}
        end

      :gif ->
        if byte_size(bytes) < 10 do
          :error
        else
          {:ok, unsigned_at(bytes, 6, 2, :little), unsigned_at(bytes, 8, 2, :little)}
        end

      :jpeg ->
        jpeg_size(bytes, 2, byte_size(bytes))

      :webp ->
        webp_size(bytes)

      nil ->
        :error
    end
  end

  def image_size(_bytes), do: :error

  @spec format_bytes(number()) :: binary()
  def format_bytes(bytes) when is_number(bytes) do
    cond do
      bytes < 0 ->
        "?"

      bytes < 1024 ->
        "#{round(bytes)} B"

      true ->
        {value, unit} = scale_bytes(bytes / 1024, 0)

        formatted =
          if value < 10 do
            :erlang.float_to_binary(value, decimals: 1)
          else
            Integer.to_string(round(value))
          end

        formatted <> " " <> unit
    end
  end

  def format_bytes(_bytes), do: "?"

  defp parse_integer(text) do
    case Integer.parse(text) do
      {value, ""} when value >= 0 -> {:ok, value}
      _ -> :error
    end
  end

  defp parse_end("", size), do: {:ok, size - 1}
  defp parse_end(text, _size), do: parse_integer(text)

  defp extension_of(name) do
    characters = String.to_charlist(name)
    count = length(characters)

    case last_dot_index(characters) do
      nil ->
        ""

      index when index <= 0 or index == count - 1 ->
        ""

      index ->
        extension =
          characters
          |> Enum.drop(index + 1)
          |> List.to_string()
          |> String.downcase()

        if Regex.match?(@extension_re, extension), do: extension, else: ""
    end
  end

  defp last_dot_index(characters) do
    characters
    |> Enum.with_index()
    |> Enum.reduce(nil, fn
      {?., index}, _last -> index
      _, last -> last
    end)
  end

  defp sniff_media_kind(head) do
    cond do
      starts_with?(head, <<0x1A, 0x45, 0xDF, 0xA3>>) ->
        "video"

      starts_with?(head, "RIFF") and starts_at?(head, 8, "AVI ") ->
        "video"

      starts_at?(head, 4, "ftyp") ->
        brand = if byte_size(head) >= 12, do: binary_part(head, 8, 4), else: ""
        if brand in ["M4A ", "M4B ", "F4A "], do: "audio", else: "video"

      starts_with?(head, "ID3") ->
        "audio"

      byte_size(head) >= 2 and :binary.at(head, 0) == 0xFF and
          :binary.at(head, 1) in [0xFB, 0xFA, 0xF3, 0xF2] ->
        "audio"

      byte_size(head) >= 2 and :binary.at(head, 0) == 0xFF and
          :binary.at(head, 1) in [0xF1, 0xF9] ->
        "audio"

      starts_with?(head, "RIFF") and starts_at?(head, 8, "WAVE") ->
        "audio"

      starts_with?(head, "OggS") ->
        "audio"

      starts_with?(head, "fLaC") ->
        "audio"

      starts_with?(head, "FORM") and starts_at?(head, 8, "AIFF") ->
        "audio"

      starts_with?(head, "MThd") ->
        "audio"

      true ->
        "file"
    end
  end

  defp jpeg_size(_bytes, offset, length) when offset + 9 >= length, do: :error

  defp jpeg_size(bytes, offset, length) do
    if :binary.at(bytes, offset) == 0xFF do
      marker = :binary.at(bytes, offset + 1)

      cond do
        marker == 0xD8 or marker == 0xD9 or (marker >= 0xD0 and marker <= 0xD7) ->
          jpeg_size(bytes, offset + 2, length)

        marker >= 0xC0 and marker <= 0xCF and marker not in [0xC4, 0xC8, 0xCC] ->
          {:ok, unsigned_at(bytes, offset + 7, 2, :big), unsigned_at(bytes, offset + 5, 2, :big)}

        true ->
          segment_length = unsigned_at(bytes, offset + 2, 2, :big)
          jpeg_size(bytes, offset + 2 + segment_length, length)
      end
    else
      jpeg_size(bytes, offset + 1, length)
    end
  end

  defp webp_size(bytes) when byte_size(bytes) < 16, do: :error

  defp webp_size(bytes) do
    case binary_part(bytes, 12, 4) do
      "VP8 " ->
        if byte_size(bytes) < 30 do
          :error
        else
          {:ok, unsigned_at(bytes, 26, 2, :little) &&& 0x3FFF,
           unsigned_at(bytes, 28, 2, :little) &&& 0x3FFF}
        end

      "VP8L" ->
        if byte_size(bytes) < 25 do
          :error
        else
          b21 = :binary.at(bytes, 21)
          b22 = :binary.at(bytes, 22)
          b23 = :binary.at(bytes, 23)
          b24 = :binary.at(bytes, 24)

          width = 1 + ((b22 &&& 0x3F) <<< 8 ||| b21)

          height =
            1 +
              ((b24 &&& 0x0F) <<< 10 ||| b23 <<< 2 ||| (b22 &&& 0xC0) >>> 6)

          {:ok, width, height}
        end

      "VP8X" ->
        if byte_size(bytes) < 30 do
          :error
        else
          {:ok, 1 + unsigned_at(bytes, 24, 3, :little), 1 + unsigned_at(bytes, 27, 3, :little)}
        end

      _ ->
        :error
    end
  end

  defp starts_with?(bytes, prefix) do
    byte_size(bytes) >= byte_size(prefix) and binary_part(bytes, 0, byte_size(prefix)) == prefix
  end

  defp starts_at?(bytes, offset, prefix) do
    length = byte_size(prefix)

    byte_size(bytes) >= offset + length and
      binary_part(bytes, offset, length) == prefix
  end

  defp unsigned_at(bytes, offset, length, endian) do
    :binary.decode_unsigned(binary_part(bytes, offset, length), endian)
  end

  defp scale_bytes(value, index) when value >= 1024 and index < 2 do
    scale_bytes(value / 1024, index + 1)
  end

  defp scale_bytes(value, index) do
    {value, Enum.at(~w(KB MB GB), index)}
  end
end
