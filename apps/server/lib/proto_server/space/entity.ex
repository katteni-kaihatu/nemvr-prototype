defmodule ProtoServer.Space.Entity do
  @moduledoc false

  @doc "Build the internal entity map from legacy object-shaped fields."
  @spec from_legacy(binary(), map()) :: map()
  def from_legacy(kind, object) when is_map(object) do
    dimensions =
      %{"entity.kind" => kind}
      |> put_vec("space.position", Map.get(object, "position"))
      |> put_number("space.yaw", Map.get(object, "yaw"))
      |> put_number("space.pitch", Map.get(object, "pitch"))
      |> put_number("space.scale", Map.get(object, "scale"))
      |> put_number("space.roll", Map.get(object, "roll"))
      |> put_json("space.deform", Map.get(object, "deform"))
      |> put_value("interaction.heldBy", Map.get(object, "heldBy"))

    dimensions =
      case kind do
        "box" ->
          dimensions
          |> put_number("box.size", Map.get(object, "size"))
          |> put_value("box.color", Map.get(object, "color"))

        "image" ->
          dimensions
          |> put_value("content.cid", Map.get(object, "cid"))
          |> put_value("content.name", Map.get(object, "name"))
          |> put_number("content.width", Map.get(object, "width"))
          |> put_number("content.height", Map.get(object, "height"))
          |> put_number("content.size", Map.get(object, "size"))
          |> put_value("content.stored", Map.get(object, "stored"))
          |> put_value("content.owner", Map.get(object, "owner"))
          |> put_value("content.offline", Map.get(object, "offline"))

        "file" ->
          dimensions
          |> put_value("content.cid", Map.get(object, "cid"))
          |> put_value("content.name", Map.get(object, "name"))
          |> put_number("content.size", Map.get(object, "size"))
          |> put_value("content.category", Map.get(object, "category"))
          |> put_value("content.stored", Map.get(object, "stored"))
          |> put_value("content.owner", Map.get(object, "owner"))
          |> put_value("content.offline", Map.get(object, "offline"))

        "link" ->
          put_value(dimensions, "content.url", Map.get(object, "url"))

        "peer" ->
          dimensions
          |> put_value("space.head", Map.get(object, "head"))
          |> put_number("space.crouch", Map.get(object, "crouch"))
          |> put_number("space.lean", Map.get(object, "lean"))
          |> put_value("peer.name", Map.get(object, "name"))
          |> put_value("peer.color", Map.get(object, "color"))
          |> put_value("peer.avatarCid", Map.get(object, "avatarCid"))
          |> put_value("peer.ipfsPeerId", Map.get(object, "ipfsPeerId"))

        _ ->
          dimensions
      end

    dimensions
  end

  @doc "Convert the internal dimensions back to the legacy object shape used by content code."
  @spec to_legacy(map()) :: map()
  def to_legacy(%{"id" => id, "dimensions" => dimensions}) do
    kind = Map.get(dimensions, "entity.kind")

    base =
      %{"id" => id, "kind" => kind}
      |> maybe_put("position", Map.get(dimensions, "space.position"))
      |> maybe_put("yaw", Map.get(dimensions, "space.yaw"))
      |> maybe_put("pitch", Map.get(dimensions, "space.pitch"))
      |> maybe_put("scale", Map.get(dimensions, "space.scale"))
      |> maybe_put("heldBy", Map.get(dimensions, "interaction.heldBy"))

    case kind do
      "box" ->
        base
        |> Map.put("size", Map.get(dimensions, "box.size"))
        |> Map.put("color", Map.get(dimensions, "box.color"))

      "image" ->
        base
        |> Map.put("cid", Map.get(dimensions, "content.cid"))
        |> Map.put("name", Map.get(dimensions, "content.name"))
        |> Map.put("width", Map.get(dimensions, "content.width"))
        |> Map.put("height", Map.get(dimensions, "content.height"))
        |> Map.put("stored", Map.get(dimensions, "content.stored", false))
        |> maybe_put("owner", Map.get(dimensions, "content.owner"))
        |> maybe_put("offline", Map.get(dimensions, "content.offline"))

      "file" ->
        base
        |> Map.put("cid", Map.get(dimensions, "content.cid"))
        |> Map.put("name", Map.get(dimensions, "content.name"))
        |> Map.put("size", Map.get(dimensions, "content.size", 0))
        |> Map.put("stored", Map.get(dimensions, "content.stored", false))
        |> Map.put("category", Map.get(dimensions, "content.category"))
        |> maybe_put("owner", Map.get(dimensions, "content.owner"))
        |> maybe_put("offline", Map.get(dimensions, "content.offline"))

      "link" ->
        Map.put(base, "url", Map.get(dimensions, "content.url"))

      "peer" ->
        base
        |> Map.put("name", Map.get(dimensions, "peer.name"))
        |> Map.put("color", Map.get(dimensions, "peer.color"))
        |> Map.put("head", Map.get(dimensions, "space.head", [0, 0, 0, 1]))
        |> Map.put("crouch", Map.get(dimensions, "space.crouch", 0))
        |> Map.put("lean", Map.get(dimensions, "space.lean", 0))
        |> maybe_put("avatarCid", Map.get(dimensions, "peer.avatarCid"))
        |> maybe_put("ipfsPeerId", Map.get(dimensions, "peer.ipfsPeerId"))

      _ ->
        base
    end
  end

  @spec dims(map()) :: map()
  def dims(%{"dimensions" => dimensions}), do: dimensions

  defp put_value(map, _key, nil), do: map
  defp put_value(map, key, value), do: Map.put(map, key, value)

  defp put_number(map, _key, value) when not is_number(value), do: map
  defp put_number(map, key, value), do: Map.put(map, key, value)

  defp put_vec(map, _key, value) when not is_list(value), do: map
  defp put_vec(map, key, value), do: Map.put(map, key, value)

  defp put_json(map, _key, value) when not is_map(value), do: map
  defp put_json(map, key, value), do: Map.put(map, key, value)

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
