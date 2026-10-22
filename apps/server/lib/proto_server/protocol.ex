defmodule ProtoServer.Protocol do
  @moduledoc """
  Parsing and normalization for the space v2 client protocol.

  `parse/1` returns a normalized string-keyed map, `{:legacy, type}` for the
  removed world protocol messages, or `:error`.
  """

  import Bitwise

  @max_name_length 24
  @max_file_name_length 120
  @max_url_length 2048
  @max_abs_position 1000
  @max_cid_length 128
  @codec_dag_pb 0x70
  @codec_raw 0x55
  @hash_sha2_256 0x12

  @legacy_types ~w(
    join pose place_image place_file place_box place_url request_file ipfs_peer set_avatar
    video_control grab_object move_object release_object delete_object duplicate_object
    sync_hello sync_update sync_part claim claim_release
  )
  @mutation_ops ~w(create patch delete duplicate claim release)

  @uuid_re ~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  @url_re ~r/^https?:\/\//i
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

  @type parse_result :: {:ok, map()} | :error | {:legacy, binary()}

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

  defp parse_message(%{"type" => type}) when is_binary(type) and type in @legacy_types do
    {:legacy, type}
  end

  defp parse_message(%{"type" => "space_ping"} = message) do
    id = Map.get(message, "id")

    if is_integer(id) and id >= 0 do
      {:ok, %{"type" => "space_ping", "id" => id}}
    else
      :error
    end
  end

  defp parse_message(%{"type" => "space_join"} = message) do
    name = Map.get(message, "name")
    template_id = Map.get(message, "templateId")
    schema_version = Map.get(message, "schemaVersion")
    session_id = Map.get(message, "sessionId")

    if is_binary(name) and is_binary(template_id) and is_number(schema_version) and
         (is_nil(session_id) or is_binary(session_id)) do
      result = %{
        "type" => "space_join",
        "name" => name,
        "templateId" => template_id,
        "schemaVersion" => schema_version
      }

      {:ok, if(is_binary(session_id), do: Map.put(result, "sessionId", session_id), else: result)}
    else
      :error
    end
  end

  defp parse_message(%{"type" => "space_query"} = message) do
    request_id = Map.get(message, "requestId")
    filter = Map.get(message, "filter", %{})
    limit = Map.get(message, "limit", 100)

    if is_binary(request_id) and is_map(filter) and is_number(limit) do
      {:ok,
       %{
         "type" => "space_query",
         "requestId" => request_id,
         "filter" => filter,
         "limit" => limit
       }}
    else
      :error
    end
  end

  defp parse_message(%{"type" => "space_subscribe"} = message) do
    subscription_id = Map.get(message, "subscriptionId")
    filter = Map.get(message, "filter", %{})

    if is_binary(subscription_id) and is_map(filter) do
      {:ok,
       %{
         "type" => "space_subscribe",
         "subscriptionId" => subscription_id,
         "filter" => filter
       }}
    else
      :error
    end
  end

  defp parse_message(%{"type" => "space_unsubscribe"} = message) do
    subscription_id = Map.get(message, "subscriptionId")

    if is_binary(subscription_id) do
      {:ok, %{"type" => "space_unsubscribe", "subscriptionId" => subscription_id}}
    else
      :error
    end
  end

  defp parse_message(%{"type" => "space_mutate"} = message) do
    case parse_mutation(Map.get(message, "mutation")) do
      {:ok, mutation} -> {:ok, %{"type" => "space_mutate", "mutation" => mutation}}
      :error -> :error
    end
  end

  defp parse_message(%{"type" => "space_import_url"} = message) do
    command_id = Map.get(message, "commandId")
    entity_id = Map.get(message, "entityId")
    url = Map.get(message, "url")
    position = Map.get(message, "position")
    yaw = Map.get(message, "yaw")
    pitch = Map.get(message, "pitch")

    with {:ok, command_id} <- parse_uuid(command_id),
         {:ok, entity_id} <- parse_uuid(entity_id),
         true <- is_binary(url) and String.length(url) >= 1 and String.length(url) <= @max_url_length,
         true <- Regex.match?(@url_re, url),
         true <- finite_vec3?(position),
         true <- is_number(yaw),
         true <- is_nil(pitch) or is_number(pitch) do
      result = %{
        "type" => "space_import_url",
        "commandId" => command_id,
        "entityId" => entity_id,
        "url" => url,
        "position" => position,
        "yaw" => yaw
      }

      {:ok, if(is_number(pitch), do: Map.put(result, "pitch", pitch), else: result)}
    else
      _ -> :error
    end
  end

  defp parse_message(%{"type" => "space_set_avatar"} = message) do
    command_id = Map.get(message, "commandId")
    cid = Map.get(message, "cid")

    with true <- Map.has_key?(message, "cid"),
         {:ok, command_id} <- parse_uuid(command_id),
         {:ok, cid} <- parse_nullable_cid(cid) do
      {:ok, %{"type" => "space_set_avatar", "commandId" => command_id, "cid" => cid}}
    else
      _ -> :error
    end
  end

  defp parse_message(%{"type" => "file_request"} = message) do
    command_id = Map.get(message, "commandId")
    entity_id = Map.get(message, "entityId")

    with {:ok, command_id} <- parse_uuid(command_id),
         {:ok, entity_id} <- parse_uuid(entity_id) do
      {:ok, %{"type" => "file_request", "commandId" => command_id, "entityId" => entity_id}}
    else
      _ -> :error
    end
  end

  defp parse_message(_), do: :error

  defp parse_mutation(mutation) when is_map(mutation) do
    command_id = Map.get(mutation, "commandId")
    op = Map.get(mutation, "op")

    with {:ok, command_id} <- parse_uuid(command_id),
         true <- op in @mutation_ops do
      parse_mutation_op(op, command_id, mutation)
    else
      _ -> :error
    end
  end

  defp parse_mutation(_mutation), do: :error

  defp parse_mutation_op("create", command_id, mutation) do
    entity_id = Map.get(mutation, "entityId")
    dimensions = Map.get(mutation, "dimensions")

    with {:ok, entity_id} <- parse_uuid(entity_id),
         true <- is_map(dimensions) do
      {:ok,
       %{
         "commandId" => command_id,
         "op" => "create",
         "entityId" => entity_id,
         "dimensions" => dimensions
       }}
    else
      _ -> :error
    end
  end

  defp parse_mutation_op("patch", command_id, mutation) do
    entity_id = Map.get(mutation, "entityId")
    set = Map.get(mutation, "set", %{})
    unset = Map.get(mutation, "unset", [])
    conditions = Map.get(mutation, "if", [])
    if_version = Map.get(mutation, "ifVersion")

    with {:ok, entity_id} <- parse_uuid(entity_id),
         true <- is_map(set),
         true <- is_list(unset) and Enum.all?(unset, &is_binary/1),
         true <- is_list(conditions),
         true <- is_nil(if_version) or is_number(if_version) do
      result = %{
        "commandId" => command_id,
        "op" => "patch",
        "entityId" => entity_id,
        "set" => set,
        "unset" => unset,
        "if" => conditions
      }

      {:ok, if(is_number(if_version), do: Map.put(result, "ifVersion", if_version), else: result)}
    else
      _ -> :error
    end
  end

  defp parse_mutation_op("delete", command_id, mutation) do
    entity_id = Map.get(mutation, "entityId")
    conditions = Map.get(mutation, "if", [])
    if_version = Map.get(mutation, "ifVersion")

    with {:ok, entity_id} <- parse_uuid(entity_id),
         true <- is_list(conditions),
         true <- is_nil(if_version) or is_number(if_version) do
      result = %{
        "commandId" => command_id,
        "op" => "delete",
        "entityId" => entity_id,
        "if" => conditions
      }

      {:ok, if(is_number(if_version), do: Map.put(result, "ifVersion", if_version), else: result)}
    else
      _ -> :error
    end
  end

  defp parse_mutation_op("duplicate", command_id, mutation) do
    entity_id = Map.get(mutation, "entityId")
    new_entity_id = Map.get(mutation, "newEntityId")

    with {:ok, entity_id} <- parse_uuid(entity_id),
         {:ok, new_entity_id} <- parse_uuid(new_entity_id) do
      {:ok,
       %{
         "commandId" => command_id,
         "op" => "duplicate",
         "entityId" => entity_id,
         "newEntityId" => new_entity_id
       }}
    else
      _ -> :error
    end
  end

  defp parse_mutation_op(op, command_id, mutation) when op in ["claim", "release"] do
    entity_id = Map.get(mutation, "entityId")

    with {:ok, entity_id} <- parse_uuid(entity_id) do
      {:ok, %{"commandId" => command_id, "op" => op, "entityId" => entity_id}}
    else
      _ -> :error
    end
  end

  defp parse_uuid(value) when is_binary(value) do
    if Regex.match?(@uuid_re, value), do: {:ok, value}, else: :error
  end

  defp parse_uuid(_value), do: :error

  defp parse_nullable_cid(nil), do: {:ok, nil}

  defp parse_nullable_cid(value) do
    case normalize_cid(value) do
      cid when is_binary(cid) -> {:ok, cid}
      :error -> :error
    end
  end

  defp finite_vec3?(value) when is_list(value) do
    length(value) == 3 and Enum.all?(value, &is_number/1) and
      Enum.all?(value, &(abs(&1) <= @max_abs_position))
  end

  defp finite_vec3?(_value), do: false

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
      "b" <>
        base32_encode(
          encode_varint(version) <>
            encode_varint(codec) <>
            encode_varint(hash_code) <>
            encode_varint(digest_length) <> digest
        )
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
