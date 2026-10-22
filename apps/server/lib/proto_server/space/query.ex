defmodule ProtoServer.Space.Query do
  @moduledoc false

  alias ProtoServer.Space.Schema

  @spec valid_filter?(term(), [binary()]) :: boolean()
  def valid_filter?(filter, allowed_dims \\ []) do
    case validate_filter(filter, allowed_dims, 0) do
      {:ok, _count} -> true
      :error -> false
    end
  end

  @spec matches?(map(), map()) :: boolean()
  def matches?(dimensions, filter) when is_map(dimensions) and is_map(filter) do
    all_ok = Map.get(filter, "all", []) |> Enum.all?(&matches_predicate?(dimensions, &1))
    any_list = Map.get(filter, "any", [])

    any_ok =
      case any_list do
        [] -> true
        list -> Enum.any?(list, &matches_predicate?(dimensions, &1))
      end

    not_ok =
      case Map.get(filter, "not") do
        nil -> true
        nested -> not matches?(dimensions, nested)
      end

    all_ok and any_ok and not_ok
  end

  def matches?(_dimensions, _filter), do: false

  defp validate_filter(filter, allowed_dims, count) when is_map(filter) do
    keys = Map.keys(filter)
    allowed_keys = ["all", "any", "not"]

    cond do
      Enum.any?(keys, fn key -> key not in allowed_keys end) ->
        :error

      count > Schema.max_filter_predicates() ->
        :error

      true ->
        with {:ok, count} <- validate_list(Map.get(filter, "all"), allowed_dims, count),
             {:ok, count} <- validate_list(Map.get(filter, "any"), allowed_dims, count),
             {:ok, count} <- validate_nested(Map.get(filter, "not"), allowed_dims, count) do
          {:ok, count}
        end
    end
  end

  defp validate_filter(_filter, _allowed_dims, _count), do: :error

  defp validate_list(nil, _allowed, count), do: {:ok, count}

  defp validate_list(list, allowed, count) when is_list(list) do
    if length(list) > Schema.max_filter_predicates() do
      :error
    else
      Enum.reduce_while(list, {:ok, count}, fn predicate, {:ok, current} ->
        case validate_predicate(predicate, allowed) do
          :ok -> {:cont, {:ok, current + 1}}
          :error -> {:halt, :error}
        end
      end)
    end
  end

  defp validate_list(_list, _allowed, _count), do: :error

  defp validate_nested(nil, _allowed, count), do: {:ok, count}
  defp validate_nested(filter, allowed, count), do: validate_filter(filter, allowed, count + 1)

  defp validate_predicate(predicate, allowed) when is_map(predicate) do
    dim = Map.get(predicate, "dim")

    cond do
      is_binary(dim) ->
        cond do
          not Schema.known_dimension?(dim) ->
            :error

          allowed != [] and dim not in allowed ->
            :error

          Map.has_key?(predicate, "eq") ->
            :ok

          is_list(Map.get(predicate, "in")) ->
            :ok

          is_map(Map.get(predicate, "range")) ->
            range = Map.get(predicate, "range")

            if is_number(Map.get(range, "min")) or is_number(Map.get(range, "max")),
              do: :ok,
              else: :error

          Map.has_key?(predicate, "within") ->
            within = Map.get(predicate, "within")

            if dim == "space.position" and is_map(within) and valid_vec3?(Map.get(within, "min")) and
                 valid_vec3?(Map.get(within, "max")) do
              :ok
            else
              :error
            end

          true ->
            :error
        end

      Map.has_key?(predicate, "all") or Map.has_key?(predicate, "any") or
          Map.has_key?(predicate, "not") ->
        if valid_filter?(predicate, allowed), do: :ok, else: :error

      true ->
        :error
    end
  end

  defp validate_predicate(_predicate, _allowed), do: :error

  defp matches_predicate?(dimensions, %{"dim" => dim} = predicate) do
    value = Map.get(dimensions, dim)

    cond do
      Map.has_key?(predicate, "eq") ->
        value == Map.get(predicate, "eq")

      is_list(Map.get(predicate, "in")) ->
        value in Map.get(predicate, "in")

      is_map(Map.get(predicate, "range")) ->
        range = Map.get(predicate, "range")
        min = Map.get(range, "min")
        max = Map.get(range, "max")
        is_number(value) and (is_nil(min) or value >= min) and (is_nil(max) or value <= max)

      is_map(Map.get(predicate, "within")) ->
        within = Map.get(predicate, "within")
        min = Map.get(within, "min")
        max = Map.get(within, "max")

        valid_vec3?(value) and valid_vec3?(min) and valid_vec3?(max) and
          Enum.zip([value, min, max])
          |> Enum.all?(fn {v, lo, hi} -> v >= lo and v <= hi end)

      true ->
        false
    end
  end

  defp matches_predicate?(dimensions, %{} = nested) do
    if Map.has_key?(nested, "all") or Map.has_key?(nested, "any") or Map.has_key?(nested, "not") do
      matches?(dimensions, nested)
    else
      false
    end
  end

  defp matches_predicate?(_dimensions, _predicate), do: false

  defp valid_vec3?(value) when is_list(value) do
    length(value) == 3 and Enum.all?(value, &is_number/1)
  end

  defp valid_vec3?(_value), do: false
end
