defmodule ProtoServer.Space.Scope do
  @moduledoc false

  alias ProtoServer.Space.{Query, Schema}

  defstruct session_id: "main",
            read_dims: [],
            read_filter: %{},
            write_dims: [],
            write_filter: %{},
            can_create: true,
            can_delete: true,
            max_entities: 100

  @type t :: %__MODULE__{}

  @client_peer_dims ~w(
    space.position space.yaw space.pitch space.roll space.scale space.deform space.head space.crouch space.lean
    space.xr.left.position space.xr.left.rotation space.xr.left.tracked
    space.xr.right.position space.xr.right.rotation space.xr.right.tracked
    peer.ipfsPeerId
  )

  @spec default_member(binary(), binary()) :: t()
  def default_member(session_id, _peer_id) do
    filter = %{"all" => [%{"dim" => "session.id", "eq" => session_id}]}

    %__MODULE__{
      session_id: session_id,
      read_dims: [],
      read_filter: filter,
      write_dims: @client_peer_dims,
      write_filter: filter,
      can_create: true,
      can_delete: true,
      max_entities: Schema.max_objects()
    }
  end

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = scope) do
    %{
      "sessionId" => scope.session_id,
      "read" => %{"dims" => scope.read_dims, "filter" => scope.read_filter},
      "write" => %{
        "dims" => scope.write_dims,
        "filter" => scope.write_filter,
        "canCreate" => scope.can_create,
        "canDelete" => scope.can_delete,
        "maxEntities" => scope.max_entities
      }
    }
  end

  @spec strip_entity(t(), map()) :: map()
  def strip_entity(%__MODULE__{read_dims: []}, entity), do: entity

  def strip_entity(%__MODULE__{read_dims: dims}, %{"dimensions" => dimensions} = entity) do
    kept = Map.take(dimensions, dims)
    %{entity | "dimensions" => kept}
  end

  @spec effective_filter(t(), map()) :: map()
  def effective_filter(%__MODULE__{read_filter: read_filter}, requested) do
    cond do
      read_filter == %{} -> requested
      requested == %{} -> read_filter
      true -> %{"all" => [read_filter, requested]}
    end
  end

  @spec read_filter_valid?(t(), map()) :: boolean()
  def read_filter_valid?(%__MODULE__{} = scope, filter) do
    Query.valid_filter?(filter, scope.read_dims)
  end

  @spec write_filter_matches?(t(), map()) :: boolean()
  def write_filter_matches?(%__MODULE__{write_filter: filter}, dimensions) do
    filter == %{} or Query.matches?(dimensions, filter)
  end

  @spec can_create_kind?(t(), binary()) :: boolean()
  def can_create_kind?(%__MODULE__{can_create: true}, kind)
      when kind in ["box", "image", "file", "link"],
      do: true

  def can_create_kind?(_scope, _kind), do: false

  @doc "Whether the actor may write a dimension on this entity."
  @spec writable_dim?(t(), binary(), map(), binary()) :: boolean()
  def writable_dim?(%__MODULE__{} = scope, actor, entity, dim) do
    dimensions = Map.get(entity, "dimensions", %{})
    kind = Map.get(dimensions, "entity.kind")
    id = Map.get(entity, "id")

    cond do
      dim in ["entity.kind", "session.id", "time.createdAt", "time.updatedAt"] ->
        false

      dim == "interaction.heldBy" ->
        false

      kind == "peer" and id == actor ->
        dim in scope.write_dims

      kind == "peer" ->
        false

      String.starts_with?(dim, "peer.") ->
        false

      String.starts_with?(dim, "content.") or String.starts_with?(dim, "box.") ->
        false

      dim == "time.playback" ->
        kind == "file" and Map.get(dimensions, "content.category") == "video"

      String.starts_with?(dim, "space.") ->
        # The Store checks the current holder before applying a space patch.
        dim in scope.write_dims

      true ->
        false
    end
  end

  @spec can_delete?(t(), binary(), map()) :: boolean()
  def can_delete?(%__MODULE__{can_delete: false}, _actor, _entity), do: false

  def can_delete?(%__MODULE__{}, actor, entity) do
    held_by = entity |> Map.get("dimensions", %{}) |> Map.get("interaction.heldBy")
    held_by in [nil, actor]
  end

  @spec max_entities(t()) :: non_neg_integer()
  def max_entities(%__MODULE__{max_entities: max}), do: max
end
