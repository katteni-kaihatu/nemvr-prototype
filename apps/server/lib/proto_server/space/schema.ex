defmodule ProtoServer.Space.Schema do
  @moduledoc false

  @schema_path Path.expand("../../../priv/space-schema.json", __DIR__)
  @external_resource @schema_path
  @schema @schema_path |> File.read!() |> Jason.decode!()

  @type dimension :: map()

  @spec schema() :: map()
  def schema, do: @schema

  @spec schema_version() :: non_neg_integer()
  def schema_version, do: Map.fetch!(@schema, "schemaVersion")

  @spec max_objects() :: non_neg_integer()
  def max_objects, do: Map.fetch!(@schema, "maxObjects")

  @spec max_dimensions() :: non_neg_integer()
  def max_dimensions, do: Map.fetch!(@schema, "maxDimensions")

  @spec max_entity_bytes() :: non_neg_integer()
  def max_entity_bytes, do: Map.fetch!(@schema, "maxEntityBytes")

  @spec max_filter_predicates() :: non_neg_integer()
  def max_filter_predicates, do: Map.fetch!(@schema, "maxFilterPredicates")

  @spec dimensions() :: map()
  def dimensions, do: Map.fetch!(@schema, "dimensions")

  @spec dimension(binary()) :: map() | nil
  def dimension(name), do: Map.get(dimensions(), name)

  @spec required(binary()) :: [binary()]
  def required(kind), do: @schema |> Map.fetch!("required") |> Map.get(kind, [])

  @spec known_dimension?(binary()) :: boolean()
  def known_dimension?(name), do: Map.has_key?(dimensions(), name)

  @doc "Validate a single dimension value against the shared schema."
  @spec valid_value?(binary(), term()) :: boolean()
  def valid_value?(name, value) do
    case dimension(name) do
      nil ->
        false

      spec ->
        valid_typed?(Map.fetch!(spec, "type"), spec, value)
    end
  end

  @spec validate_create(binary(), map()) :: :ok | {:error, binary()}
  def validate_create(kind, dimensions) when is_binary(kind) and is_map(dimensions) do
    cond do
      Map.get(dimensions, "entity.kind") != kind ->
        {:error, "entity_kind_mismatch"}

      map_size(dimensions) > max_dimensions() ->
        {:error, "too_many_dimensions"}

      Enum.any?(dimensions, fn {name, _value} -> not known_dimension?(name) end) ->
        {:error, "unknown_dimension"}

      not Enum.all?(required(kind), &Map.has_key?(dimensions, &1)) ->
        {:error, "missing_dimension"}

      not Enum.all?(dimensions, fn {name, value} -> valid_value?(name, value) end) ->
        {:error, "invalid_dimension"}

      not within_size_limit?(dimensions) ->
        {:error, "entity_too_large"}

      true ->
        :ok
    end
  end

  def validate_create(_kind, _dimensions), do: {:error, "invalid_dimension"}

  @spec validate_patch(map()) :: :ok | {:error, binary()}
  def validate_patch(dimensions) when is_map(dimensions) do
    cond do
      map_size(dimensions) > max_dimensions() ->
        {:error, "too_many_dimensions"}

      Enum.any?(dimensions, fn {name, _value} -> not known_dimension?(name) end) ->
        {:error, "unknown_dimension"}

      not Enum.all?(dimensions, fn {name, value} -> valid_value?(name, value) end) ->
        {:error, "invalid_dimension"}

      true ->
        :ok
    end
  end

  def validate_patch(_dimensions), do: {:error, "invalid_dimension"}

  @spec normalize(binary(), term()) :: term()
  def normalize("space.head", value) do
    case value do
      [x, y, z, w] when is_number(x) and is_number(y) and is_number(z) and is_number(w) ->
        normalize_quaternion([x, y, z, w])

      _ ->
        value
    end
  end

  def normalize("time.playback", value) when is_map(value) do
    playing = Map.get(value, "playing")
    time = Map.get(value, "time")
    at = Map.get(value, "at")

    if is_boolean(playing) and is_number(time) do
      %{
        "playing" => playing,
        "time" => time |> max(0) |> min(24 * 60 * 60),
        "at" => if(is_number(at), do: at, else: System.system_time(:millisecond))
      }
    else
      value
    end
  end

  def normalize(_name, value), do: value

  @spec within_size_limit?(map()) :: boolean()
  def within_size_limit?(dimensions) do
    byte_size(Jason.encode!(dimensions)) <= max_entity_bytes()
  rescue
    _ -> false
  end

  defp valid_typed?("string", spec, value) do
    (is_nil(value) and Map.get(spec, "nullable", false)) or
      (is_binary(value) and String.length(value) <= Map.get(spec, "maxLength", 4096))
  end

  defp valid_typed?("number", spec, value) when is_number(value) do
    min = Map.get(spec, "min", :none)
    max = Map.get(spec, "max", :none)

    (min == :none or value >= min) and (max == :none or value <= max)
  end

  defp valid_typed?("number", _spec, _value), do: false

  defp valid_typed?("boolean", _spec, value), do: is_boolean(value)

  defp valid_typed?("enum", spec, value) do
    is_binary(value) and value in Map.get(spec, "values", [])
  end

  defp valid_typed?("vec3", spec, value) do
    valid_vector?(value, 3) and within_component_range?(value, spec)
  end

  defp valid_typed?("quat", _spec, value), do: valid_vector?(value, 4)

  defp valid_typed?("object", _spec, value), do: is_map(value)

  defp valid_typed?("color", _spec, value) do
    is_binary(value) and Regex.match?(~r/^#[0-9a-fA-F]{6}$/, value)
  end

  defp valid_typed?("playback", _spec, value) when is_map(value) do
    is_boolean(Map.get(value, "playing")) and is_number(Map.get(value, "time")) and
      Map.get(value, "time") >= 0 and Map.get(value, "time") <= 24 * 60 * 60
  end

  defp valid_typed?("playback", _spec, _value), do: false
  defp valid_typed?(_type, _spec, _value), do: false

  defp valid_vector?(value, length) when is_list(value) do
    length(value) == length and Enum.all?(value, &is_number/1)
  end

  defp valid_vector?(_value, _length), do: false

  defp within_component_range?(value, spec) do
    min = Map.get(spec, "min", :none)
    max = Map.get(spec, "max", :none)

    Enum.all?(value, fn component ->
      (min == :none or component >= min) and (max == :none or component <= max)
    end)
  end

  defp normalize_quaternion([x, y, z, w]) do
    values = [x, y, z, w]
    max_abs = values |> Enum.map(&abs/1) |> Enum.max()

    if max_abs == 0 do
      [0, 0, 0, 1]
    else
      scaled_square =
        Enum.reduce(values, 0.0, fn value, acc ->
          scaled = value / max_abs
          acc + scaled * scaled
        end)

      scaled_length = :math.sqrt(scaled_square)

      if max_abs * scaled_length < 1.0e-6 do
        [0, 0, 0, 1]
      else
        Enum.map(values, fn value -> value / max_abs / scaled_length end)
      end
    end
  end
end
