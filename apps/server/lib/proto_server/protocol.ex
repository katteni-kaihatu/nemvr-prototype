defmodule ProtoServer.Protocol do
  @moduledoc """
  Parsing and normalization for the legacy client protocol.

  `parse/1` mirrors `apps/server/src/validate.ts`: it returns a normalized,
  string-keyed map for accepted messages, `:error` for malformed or unknown
  messages, and `{:unsupported, type}` for the removed crdt-v1 message types.
  """

  import Bitwise

  @max_name_length 24
  @max_file_name_length 120
  @max_url_length 2048
  @max_abs_position 1000
  @min_object_size 0.1
  @max_object_size 20
  @min_object_scale 0.1
  @max_object_scale 10
  @max_cid_length 128
  @codec_dag_pb 0x70
  @codec_raw 0x55
  @hash_sha2_256 0x12
  @crdt_types ~w(sync_hello sync_update sync_part claim claim_release)
  @id_types ~w(grab_object release_object delete_object duplicate_object request_file)

  @uuid_re ~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  @color_re ~r/^#[0-9a-fA-F]{6}$/
  @url_re ~r/^https?:\/\//i
  @peer_id_re ~r/^[A-Za-z0-9]{10,128}$/
  @illegal_file_chars ~r/[\\\/:*?"<>|]/
  @leading_dots ~r/^\.+/
  @trailing_dots_and_spaces ~r/[ .]+$/
  @extension_re ~r/^[a-z0-9_+-]{1,10}$/

  @base58_alphabet "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  @base58_index @base58_alphabet
                |> String.to_charlist()
                |> Enum.with_index()
                |> Map.new()
  @base32_alphabet "abcdefghijklmnopqrstuvwxyz234567"

  @type parse_result :: {:ok, map()} | :error | {:unsupported, binary()}

  @spec parse(binary()) :: parse_result()
  def parse(text) when is_binary(text) do
    case Jason.decode(text) do
      {:ok, message} when is_map(message) -> parse_message(message)
      _ -> :error
    end
  end

  def parse(_), do: :error

  @spec encode(map()) :: binary()
  def encode(message), do: Jason.encode!(message)

  @doc """
  Trim and truncate a display name to 24 characters.

  Non-strings become an empty name and therefore fall back to
  `"Guest-" <> fallback_suffix`.
  """
  @spec sanitize_name(term(), binary()) :: binary()
  def sanitize_name(raw, fallback_suffix) when is_binary(raw) do
    name = raw |> String.trim() |> String.slice(0, @max_name_length)

    if name == "" do
      "Guest-" <> to_string(fallback_suffix)
    else
      name
    end
  end

  def sanitize_name(_raw, fallback_suffix), do: "Guest-" <> to_string(fallback_suffix)

  @doc """
  Make a file name safe for download while preserving a known extension.
  """
  @spec sanitize_file_name(term(), binary()) :: binary()
  def sanitize_file_name(raw, fallback \\ "file")

  def sanitize_file_name(raw, fallback) when is_binary(raw) do
    name =
      raw
      |> nfc()
      |> remove_forbidden_characters()
      |> String.replace(@illegal_file_chars, "_")
      |> String.trim()
      |> String.replace(@leading_dots, "")
      |> String.replace(@trailing_dots_and_spaces, "")

    if name == "" do
      fallback
    else
      truncate_file_name(name)
    end
  end

  def sanitize_file_name(_raw, fallback), do: fallback

  @doc """
  Validate and normalize a UnixFS CID (dag-pb or raw, sha2-256).
  """
  @spec normalize_cid(term()) :: binary() | :error
  def normalize_cid(value) when is_binary(value) do
    if value == "" or String.length(value) > @max_cid_length do
      :error
    else
      cond do
        String.starts_with?(value, "Qm") ->
          normalize_cid_v0(value)

        String.starts_with?(value, ["b", "B"]) ->
          normalize_cid_v1(&base32_decode/1, binary_part(value, 1, byte_size(value) - 1))

        String.starts_with?(value, "z") ->
          normalize_cid_v1(&base58_decode/1, binary_part(value, 1, byte_size(value) - 1))

        true ->
          :error
      end
    end
  end

  def normalize_cid(_), do: :error

  defp parse_message(%{"type" => type}) when is_binary(type) and type in @crdt_types do
    {:unsupported, type}
  end

  defp parse_message(%{"type" => "join"} = message) do
    name =
      case Map.get(message, "name") do
        name when is_binary(name) -> name
        _ -> ""
      end

    {:ok, %{"type" => "join", "name" => name}}
  end

  defp parse_message(%{"type" => "pose"} = message) do
    case parse_pose(Map.get(message, "pose")) do
      {:ok, pose} -> {:ok, %{"type" => "pose", "pose" => pose}}
      :error -> :error
    end
  end

  defp parse_message(%{"type" => type} = message) when type in @id_types do
    case parse_object_id(Map.get(message, "id")) do
      {:ok, id} -> {:ok, %{"type" => type, "id" => id}}
      :error -> :error
    end
  end

  defp parse_message(%{"type" => "video_control"} = message) do
    id = parse_object_id(Map.get(message, "id"))
    playing = Map.get(message, "playing")
    time = Map.get(message, "time")

    if match?({:ok, _}, id) and is_boolean(playing) and is_number(time) and time >= 0 and
         time <= 24 * 60 * 60 do
      {:ok, id} = id

      {:ok,
       %{
         "type" => "video_control",
         "id" => id,
         "playing" => playing,
         "time" => time
       }}
    else
      :error
    end
  end

  defp parse_message(%{"type" => "move_object"} = message) do
    id = parse_object_id(Map.get(message, "id"))
    placement = parse_placement(message)
    scale = Map.get(message, "scale")

    scale_valid? =
      not Map.has_key?(message, "scale") or
        (is_number(scale) and scale >= @min_object_scale and scale <= @max_object_scale)

    if match?({:ok, _}, id) and match?({:ok, _}, placement) and scale_valid? do
      {:ok, id} = id
      {:ok, placement} = placement

      result =
        placement
        |> Map.put("type", "move_object")
        |> Map.put("id", id)

      result =
        if Map.has_key?(message, "scale"), do: Map.put(result, "scale", scale), else: result

      {:ok, result}
    else
      :error
    end
  end

  defp parse_message(%{"type" => "place_url"} = message) do
    with {:ok, placement} <- parse_placement(message),
         url when is_binary(url) <- Map.get(message, "url"),
         true <- String.length(url) >= 1 and String.length(url) <= @max_url_length,
         true <- Regex.match?(@url_re, url) do
      placement
      |> Map.put("type", "place_url")
      |> Map.put("url", url)
      |> put_object_id(message)
    else
      _ -> :error
    end
  end

  defp parse_message(%{"type" => "place_box"} = message) do
    with {:ok, placement} <- parse_placement(message),
         size when is_number(size) <- Map.get(message, "size"),
         true <- size >= @min_object_size and size <= @max_object_size,
         color when is_binary(color) <- Map.get(message, "color"),
         true <- Regex.match?(@color_re, color) do
      placement
      |> Map.put("type", "place_box")
      |> Map.put("size", size)
      |> Map.put("color", color)
      |> put_object_id(message)
    else
      _ -> :error
    end
  end

  defp parse_message(%{"type" => "place_image"} = message) do
    cid = normalize_cid(Map.get(message, "cid"))
    placement = parse_placement(message)
    width = Map.get(message, "width")
    height = Map.get(message, "height")

    if is_binary(cid) and match?({:ok, _}, placement) and object_size?(width) and
         object_size?(height) do
      {:ok, placement} = placement

      result =
        placement
        |> Map.put("type", "place_image")
        |> Map.put("cid", cid)
        |> Map.put("width", width)
        |> Map.put("height", height)

      result =
        case Map.get(message, "name") do
          name when is_binary(name) ->
            sanitized = sanitize_file_name(name, "")

            if sanitized == "" do
              result
            else
              Map.put(result, "name", sanitized)
            end

          _ ->
            result
        end

      put_object_id(result, message)
    else
      :error
    end
  end

  defp parse_message(%{"type" => "place_file"} = message) do
    cid = normalize_cid(Map.get(message, "cid"))
    placement = parse_placement(message)

    if is_binary(cid) and match?({:ok, _}, placement) do
      {:ok, placement} = placement

      placement
      |> Map.put("type", "place_file")
      |> Map.put("cid", cid)
      |> Map.put("name", sanitize_file_name(Map.get(message, "name"), "file"))
      |> put_object_id(message)
    else
      :error
    end
  end

  defp parse_message(%{"type" => "ipfs_peer"} = message) do
    case Map.get(message, "peerId") do
      peer_id when is_binary(peer_id) ->
        if Regex.match?(@peer_id_re, peer_id) do
          {:ok, %{"type" => "ipfs_peer", "peerId" => peer_id}}
        else
          :error
        end

      _ ->
        :error
    end
  end

  defp parse_message(%{"type" => "set_avatar"} = message) do
    case Map.fetch(message, "cid") do
      {:ok, nil} ->
        {:ok, %{"type" => "set_avatar", "cid" => nil}}

      {:ok, cid} ->
        case normalize_cid(cid) do
          cid when is_binary(cid) -> {:ok, %{"type" => "set_avatar", "cid" => cid}}
          :error -> :error
        end

      :error ->
        :error
    end
  end

  defp parse_message(_), do: :error

  defp parse_pose(pose) when is_map(pose) do
    position = Map.get(pose, "position")
    head = Map.get(pose, "head")

    cond do
      not finite_array?(position, 3) ->
        :error

      not finite_array?(head, 4) ->
        :error

      Enum.any?(position, &(abs(&1) > @max_abs_position)) ->
        :error

      not optional_number?(pose, "crouch") ->
        :error

      not optional_number?(pose, "lean") ->
        :error

      true ->
        case normalize_quaternion(head) do
          {:ok, quaternion} ->
            result = %{"position" => position, "head" => quaternion}

            result =
              if Map.has_key?(pose, "crouch") do
                Map.put(result, "crouch", clamp(Map.get(pose, "crouch"), 0, 1))
              else
                result
              end

            result =
              if Map.has_key?(pose, "lean") do
                Map.put(result, "lean", clamp(Map.get(pose, "lean"), -1, 1))
              else
                result
              end

            {:ok, result}

          :error ->
            :error
        end
    end
  end

  defp parse_pose(_), do: :error

  defp parse_placement(message) when is_map(message) do
    position = Map.get(message, "position")
    yaw = Map.get(message, "yaw")

    cond do
      not finite_array?(position, 3) ->
        :error

      Enum.any?(position, &(abs(&1) > @max_abs_position)) ->
        :error

      not is_number(yaw) ->
        :error

      not optional_number?(message, "pitch") ->
        :error

      true ->
        result = %{"position" => position, "yaw" => yaw}

        result =
          if Map.has_key?(message, "pitch") do
            Map.put(result, "pitch", Map.get(message, "pitch"))
          else
            result
          end

        {:ok, result}
    end
  end

  defp parse_placement(_), do: :error

  defp parse_object_id(value) when is_binary(value) do
    if Regex.match?(@uuid_re, value), do: {:ok, value}, else: :error
  end

  defp parse_object_id(_), do: :error

  defp put_object_id(result, message) do
    case Map.fetch(message, "objectId") do
      :error ->
        {:ok, result}

      {:ok, value} ->
        case parse_object_id(value) do
          {:ok, id} -> {:ok, Map.put(result, "objectId", id)}
          :error -> :error
        end
    end
  end

  defp finite_array?(value, length) when is_list(value) do
    length(value) == length and Enum.all?(value, &is_number/1)
  end

  defp finite_array?(_value, _length), do: false

  defp optional_number?(map, key) do
    not Map.has_key?(map, key) or is_number(Map.get(map, key))
  end

  defp object_size?(value) do
    is_number(value) and value >= @min_object_size and value <= @max_object_size
  end

  defp clamp(value, minimum, maximum) do
    value |> Kernel.max(minimum) |> Kernel.min(maximum)
  end

  defp normalize_quaternion([x, y, z, w]) do
    values = [x, y, z, w]
    max_abs = values |> Enum.map(&abs/1) |> Enum.max()

    if max_abs == 0 do
      :error
    else
      scaled_square =
        Enum.reduce(values, 0.0, fn value, acc ->
          scaled = value / max_abs
          acc + scaled * scaled
        end)

      scaled_length = :math.sqrt(scaled_square)

      length_ok? =
        max_abs >= 1.0e-6 or max_abs * scaled_length >= 1.0e-6

      if length_ok? do
        {:ok, Enum.map(values, fn value -> value / max_abs / scaled_length end)}
      else
        :error
      end
    end
  end

  defp nfc(value) do
    case :unicode.characters_to_nfc_binary(value) do
      normalized when is_binary(normalized) -> normalized
      _ -> value
    end
  rescue
    _ -> value
  end

  defp remove_forbidden_characters(value) do
    value
    |> String.to_charlist()
    |> Enum.reject(&forbidden_character?/1)
    |> List.to_string()
  end

  defp forbidden_character?(codepoint) do
    (codepoint >= 0x0000 and codepoint <= 0x001F) or
      (codepoint >= 0x007F and codepoint <= 0x009F) or
      (codepoint >= 0x200B and codepoint <= 0x200F) or
      (codepoint >= 0x202A and codepoint <= 0x202E) or
      (codepoint >= 0x2060 and codepoint <= 0x2064) or
      (codepoint >= 0x2066 and codepoint <= 0x2069) or
      codepoint == 0xFEFF
  end

  defp truncate_file_name(name) do
    if String.length(name) > @max_file_name_length do
      extension = extension_of(name)
      suffix = if extension == "", do: "", else: "." <> extension
      base_length = max(1, @max_file_name_length - String.length(suffix))
      String.slice(name, 0, base_length) <> suffix
    else
      name
    end
  end

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

  defp normalize_cid_v0(value) do
    case base58_decode(value) do
      {:ok, <<0x12, 0x20, _digest::binary-size(32)>>} -> value
      _ -> :error
    end
  end

  defp normalize_cid_v1(decoder, encoded) do
    with {:ok, bytes} <- decoder.(encoded),
         {:ok, version, rest} <- read_varint(bytes),
         {:ok, codec, rest} <- read_varint(rest),
         {:ok, hash_code, rest} <- read_varint(rest),
         {:ok, digest_length, rest} <- read_varint(rest),
         true <- version == 1,
         true <- codec == @codec_dag_pb or codec == @codec_raw,
         true <- hash_code == @hash_sha2_256,
         true <- digest_length == 32,
         <<digest::binary-size(32)>> <- rest do
      canonical =
        "b" <>
          base32_encode(
            encode_varint(version) <>
              encode_varint(codec) <>
              encode_varint(hash_code) <>
              encode_varint(digest_length) <> digest
          )

      canonical
    else
      _ -> :error
    end
  end

  defp base58_decode(value) do
    zeros = count_leading(value, ?1, 0)

    case decode_base58(value, 0) do
      {:ok, number} ->
        body = if number == 0, do: <<>>, else: :binary.encode_unsigned(number)
        {:ok, :binary.copy(<<0>>, zeros) <> body}

      :error ->
        :error
    end
  end

  defp decode_base58(<<>>, acc), do: {:ok, acc}

  defp decode_base58(<<character, rest::binary>>, acc) do
    case Map.fetch(@base58_index, character) do
      {:ok, value} -> decode_base58(rest, acc * 58 + value)
      :error -> :error
    end
  end

  defp count_leading(<<character, rest::binary>>, character, count) do
    count_leading(rest, character, count + 1)
  end

  defp count_leading(_value, _character, count), do: count

  defp base32_decode(value) do
    decode_base32(value, 0, 0, [])
  end

  defp decode_base32(<<>>, bits, acc, output) do
    if bits < 8 and acc == 0 do
      {:ok, output |> Enum.reverse() |> :erlang.list_to_binary()}
    else
      :error
    end
  end

  defp decode_base32(<<character, rest::binary>>, bits, acc, output) do
    case base32_value(character) do
      :error ->
        :error

      value ->
        {next_acc, next_bits, next_output} =
          emit_base32_bytes(acc <<< 5 ||| value, bits + 5, output)

        decode_base32(rest, next_bits, next_acc, next_output)
    end
  end

  defp emit_base32_bytes(acc, bits, output) when bits >= 8 do
    shift = bits - 8
    byte = acc >>> shift &&& 0xFF
    emit_base32_bytes(acc &&& (1 <<< shift) - 1, shift, [byte | output])
  end

  defp emit_base32_bytes(acc, bits, output), do: {acc, bits, output}

  defp base32_value(character) when character >= ?a and character <= ?z, do: character - ?a
  defp base32_value(character) when character >= ?A and character <= ?Z, do: character - ?A
  defp base32_value(character) when character >= ?2 and character <= ?7, do: character - ?2 + 26
  defp base32_value(_character), do: :error

  defp base32_encode(value) do
    {_acc, _bits, output} = encode_base32(value, 0, 0, [])
    output |> Enum.reverse() |> List.to_string()
  end

  defp encode_base32(<<>>, 0, _acc, output), do: {0, 0, output}

  defp encode_base32(<<>>, bits, acc, output) do
    shift = 5 - bits
    index = acc <<< shift &&& 0x1F
    {0, 0, [base32_character(index) | output]}
  end

  defp encode_base32(<<byte, rest::binary>>, bits, acc, output) do
    {next_acc, next_bits, next_output} =
      emit_base32_characters(acc <<< 8 ||| byte, bits + 8, output)

    encode_base32(rest, next_bits, next_acc, next_output)
  end

  defp emit_base32_characters(acc, bits, output) when bits >= 5 do
    shift = bits - 5
    index = acc >>> shift &&& 0x1F

    emit_base32_characters(acc &&& (1 <<< shift) - 1, shift, [
      base32_character(index) | output
    ])
  end

  defp emit_base32_characters(acc, bits, output), do: {acc, bits, output}

  defp base32_character(index), do: binary_part(@base32_alphabet, index, 1)

  defp read_varint(value), do: read_varint(value, 0, 0)

  defp read_varint(<<>>, _shift, _acc), do: :error

  defp read_varint(<<byte, rest::binary>>, shift, acc) when shift <= 56 do
    next_acc = acc ||| (byte &&& 0x7F) <<< shift

    if (byte &&& 0x80) == 0 do
      {:ok, next_acc, rest}
    else
      read_varint(rest, shift + 7, next_acc)
    end
  end

  defp read_varint(_value, _shift, _acc), do: :error

  defp encode_varint(value) when value < 0x80, do: <<value>>

  defp encode_varint(value) do
    <<(value &&& 0x7F) ||| 0x80>> <> encode_varint(value >>> 7)
  end
end
