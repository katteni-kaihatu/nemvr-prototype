defmodule ProtoServer.Space.Store do
  @moduledoc """
  Authoritative entity store for one session.

  The store only knows dimensions and versions. 3D projection, content policy and
  permissions live in the client, `ProtoServer.Place`, and
  `ProtoServer.Space.Writer` respectively.
  """

  use GenServer

  alias ProtoServer.{Protocol, Turn, Uuid}
  alias ProtoServer.Space.{Entity, Query, Schema, Scope}

  @colors ~w(#e6194b #3cb44b #ffe119 #4363d8 #f58231 #911eb4 #46f0f0 #f032e6 #bcf60c #fabebe)
  @file_icon_width 0.9
  @duplicate_normal_offset 0.05

  @initial_boxes [
    %{"position" => [0, 0, 0], "yaw" => 0, "size" => 1, "color" => "#d9534f"},
    %{"position" => [6, 0, -4], "yaw" => 0, "size" => 2, "color" => "#5bc0de"},
    %{"position" => [-7, 0, -6], "yaw" => 0, "size" => 1.5, "color" => "#5cb85c"},
    %{"position" => [10, 0, 8], "yaw" => 0, "size" => 1, "color" => "#f0ad4e"},
    %{"position" => [-10, 0, 7], "yaw" => 0, "size" => 3, "color" => "#9b59b6"}
  ]

  @default_session "main"

  @type session_id :: binary()
  @type entity :: map()

  def default_session, do: @default_session

  @spec store_name(session_id()) :: GenServer.name()
  def store_name(session_id \\ @default_session) do
    {:via, Registry, {ProtoServer.Space.Registry, {:store, session_id}}}
  end

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    session_id = Keyword.get(opts, :session_id, @default_session)
    name = Keyword.get(opts, :name, store_name(session_id))
    GenServer.start_link(__MODULE__, Keyword.put(opts, :session_id, session_id), name: name)
  end

  @spec create_peer(session_id(), pid(), term()) ::
          {:ok, binary(), map(), [map()]} | {:error, term()}
  def create_peer(session_id, ws_pid, raw_name) do
    GenServer.call(store_name(session_id), {:create_peer, ws_pid, raw_name})
  end

  @spec subscribe(session_id(), pid(), map(), binary() | nil) ::
          {:ok, binary(), non_neg_integer(), [entity()]}
  def subscribe(session_id, reader_pid, filter, requested_id \\ nil) do
    GenServer.call(store_name(session_id), {:subscribe, reader_pid, filter, requested_id})
  end

  @spec unsubscribe(session_id(), binary()) :: :ok
  def unsubscribe(session_id, subscription_id) do
    GenServer.call(store_name(session_id), {:unsubscribe, subscription_id})
  end

  @spec query(session_id(), map(), non_neg_integer()) :: {:ok, non_neg_integer(), [entity()]}
  def query(session_id, filter, limit) do
    GenServer.call(store_name(session_id), {:query, filter, limit})
  end

  @spec mutate(session_id(), binary(), Scope.t(), map()) ::
          {:ok, non_neg_integer(), map()} | {:error, binary()}
  def mutate(session_id, actor, scope, mutation) do
    GenServer.call(store_name(session_id), {:mutate, actor, scope, mutation})
  end

  @spec register_writer(session_id(), binary(), pid()) :: :ok
  def register_writer(session_id, peer_id, writer_pid) do
    GenServer.call(store_name(session_id), {:register_writer, peer_id, writer_pid})
  end

  @spec peer_pid(session_id(), binary()) :: pid() | nil
  def peer_pid(session_id, peer_id) do
    GenServer.call(store_name(session_id), {:peer_pid, peer_id})
  end

  @spec get_object(session_id(), binary()) :: {:ok, map()} | :error
  def get_object(session_id, id) do
    GenServer.call(store_name(session_id), {:get_object, id})
  end

  @spec add_box(session_id(), map()) :: {:ok, map()} | :full | {:error, binary()}
  def add_box(session_id, place), do: GenServer.call(store_name(session_id), {:add, "box", place})

  @spec add_image(session_id(), map()) :: {:ok, map()} | :full | {:error, binary()}
  def add_image(session_id, place), do: GenServer.call(store_name(session_id), {:add, "image", place})

  @spec add_file(session_id(), map()) :: {:ok, map()} | :full | {:error, binary()}
  def add_file(session_id, place), do: GenServer.call(store_name(session_id), {:add, "file", place})

  @spec add_link(session_id(), map()) :: {:ok, map()} | :full | {:error, binary()}
  def add_link(session_id, place), do: GenServer.call(store_name(session_id), {:add, "link", place})

  @spec mark_stored(session_id(), binary(), integer()) :: [map()]
  def mark_stored(session_id, cid, size) do
    GenServer.call(store_name(session_id), {:mark_stored, cid, size})
  end

  @spec mark_image_stored(session_id(), binary(), integer()) :: [map()]
  def mark_image_stored(session_id, cid, size) do
    GenServer.call(store_name(session_id), {:mark_image_stored, cid, size})
  end

  @spec remove_unstored(session_id(), binary()) :: non_neg_integer()
  def remove_unstored(session_id, cid) do
    GenServer.call(store_name(session_id), {:remove_unstored, cid})
  end

  @spec find_stored_file(session_id(), binary()) :: {:ok, map()} | :error
  def find_stored_file(session_id, cid) do
    GenServer.call(store_name(session_id), {:find_file, :stored, cid})
  end

  @spec find_stored_image(session_id(), binary()) :: {:ok, map()} | :error
  def find_stored_image(session_id, cid) do
    GenServer.call(store_name(session_id), {:find_image, cid})
  end

  @spec find_avatar(session_id(), binary()) :: {:ok, map()} | :error
  def find_avatar(session_id, cid) do
    GenServer.call(store_name(session_id), {:find_avatar, cid})
  end

  @spec find_unstored_file(session_id(), binary()) :: {:ok, map()} | :error
  def find_unstored_file(session_id, cid) do
    GenServer.call(store_name(session_id), {:find_file, :unstored, cid})
  end

  @spec set_peer_avatar(session_id(), binary(), binary() | nil) :: :ok
  def set_peer_avatar(session_id, peer_id, cid) do
    GenServer.call(store_name(session_id), {:set_peer_avatar, peer_id, cid})
  end

  @spec leave_peer(session_id(), binary()) :: :ok
  def leave_peer(session_id, peer_id) do
    GenServer.call(store_name(session_id), {:leave_peer, peer_id})
  end

  @impl true
  def init(opts) do
    session_id = Keyword.fetch!(opts, :session_id)

    state = %{
      session_id: session_id,
      version: 0,
      entities: %{},
      subscriptions: %{},
      next_subscription: 0,
      peer_pids: %{},
      peer_refs: %{},
      writer_refs: %{},
      join_count: 0,
      ipfs_info: Keyword.get(opts, :ipfs_info),
      ice_servers_fun:
        Keyword.get(opts, :ice_servers_fun, fn user_id -> Turn.ice_servers(user_id) end)
    }

    state =
      if Keyword.get(opts, :seed, true) do
        Enum.reduce(seed_demo_boxes(), state, fn box, acc -> add_seed_box(acc, box) end)
      else
        state
      end

    {:ok, state}
  end

  @impl true
  def handle_call({:create_peer, ws_pid, raw_name}, _from, state) do
    id = Uuid.v4()
    color = Enum.at(@colors, rem(state.join_count, length(@colors)))
    name = Protocol.sanitize_name(raw_name, binary_part(id, 0, 4))

    dimensions =
      %{
        "entity.kind" => "peer",
        "space.position" => [0, 0, 0],
        "space.head" => [0, 0, 0, 1],
        "space.crouch" => 0,
        "space.lean" => 0,
        "peer.name" => name,
        "peer.color" => color
      }

    entity = new_entity(id, dimensions, state.session_id)
    state = put_entity(state, entity)
    ref = Process.monitor(ws_pid)

    state = %{
      state
      | peer_pids: Map.put(state.peer_pids, id, ws_pid),
        peer_refs: Map.put(state.peer_refs, ref, id),
        join_count: state.join_count + 1
    }

    ice_servers =
      case state.ice_servers_fun.(id) do
        servers when is_list(servers) -> servers
        _ -> []
      end

    self_info = %{"peerId" => id, "entityId" => id, "name" => name, "color" => color}
    {:reply, {:ok, id, self_info, ice_servers}, state}
  end

  def handle_call({:subscribe, reader_pid, filter, requested_id}, _from, state) do
    filter = if is_map(filter) and map_size(filter) > 0, do: filter, else: default_filter(state.session_id)

    subscription_id =
      if is_binary(requested_id) and not Map.has_key?(state.subscriptions, requested_id) do
        requested_id
      else
        fresh_subscription_id(state)
      end

    ref = Process.monitor(reader_pid)

    matched =
      state.entities
      |> Enum.filter(fn {_id, entity} -> Query.matches?(Entity.dims(entity), filter) end)
      |> MapSet.new(fn {id, _entity} -> id end)

    entities =
      state.entities
      |> Enum.filter(fn {id, _entity} -> MapSet.member?(matched, id) end)
      |> Enum.map(fn {_id, entity} -> entity end)

    subscription = %{pid: reader_pid, filter: filter, matched: matched, ref: ref}

    state = %{
      state
      | subscriptions: Map.put(state.subscriptions, subscription_id, subscription),
        next_subscription: state.next_subscription + 1
    }

    {:reply, {:ok, subscription_id, state.version, entities}, state}
  end

  def handle_call({:unsubscribe, subscription_id}, _from, state) do
    {subscription, subscriptions} = Map.pop(state.subscriptions, subscription_id)
    if subscription, do: Process.demonitor(subscription.ref, [:flush])
    {:reply, :ok, %{state | subscriptions: subscriptions}}
  end

  def handle_call({:query, filter, limit}, _from, state) do
    filter = if is_map(filter), do: filter, else: %{}
    limit = limit |> max(1) |> min(100)

    entities =
      state.entities
      |> Enum.filter(fn {_id, entity} -> Query.matches?(Entity.dims(entity), filter) end)
      |> Enum.take(limit)
      |> Enum.map(fn {_id, entity} -> entity end)

    {:reply, {:ok, state.version, entities}, state}
  end

  def handle_call({:mutate, actor, scope, mutation}, _from, state) do
    case apply_mutation(state, actor, scope, mutation) do
      {:ok, version, legacy, new_state} -> {:reply, {:ok, version, legacy}, new_state}
      {:error, code} -> {:reply, {:error, code}, state}
    end
  end

  def handle_call({:register_writer, peer_id, writer_pid}, _from, state) do
    ref = Process.monitor(writer_pid)
    {:reply, :ok, %{state | writer_refs: Map.put(state.writer_refs, ref, peer_id)}}
  end

  def handle_call({:peer_pid, peer_id}, _from, state) do
    {:reply, Map.get(state.peer_pids, peer_id), state}
  end

  def handle_call({:get_object, id}, _from, state) do
    case Map.fetch(state.entities, id) do
      {:ok, entity} -> {:reply, {:ok, Entity.to_legacy(entity)}, state}
      :error -> {:reply, :error, state}
    end
  end

  def handle_call({:add, kind, place}, _from, state) do
    dimensions = Entity.from_legacy(kind, place)

    cond do
      object_count(state) >= Schema.max_objects() ->
        {:reply, :full, state}

      true ->
        case Schema.validate_create(kind, dimensions) do
          :ok ->
            id = valid_id_or_new(Map.get(place, "objectId"), state.entities)
            entity = new_entity(id, dimensions, state.session_id)
            state = put_entity(state, entity)
            {:reply, {:ok, Entity.to_legacy(entity)}, state}

          {:error, code} ->
            {:reply, {:error, code}, state}
        end
    end
  end

  def handle_call({:mark_stored, cid, size}, _from, state) do
    {state, updated} =
      Enum.reduce(state.entities, {state, []}, fn {_id, entity}, {acc, updated} ->
        dims = Entity.dims(entity)

        if Map.get(dims, "entity.kind") == "file" and Map.get(dims, "content.cid") == cid and
             Map.get(dims, "content.stored") != true do
          new_dims =
            dims
            |> Map.put("content.stored", true)
            |> Map.put("content.size", size)
            |> Map.drop(["content.owner", "content.offline"])
            |> Map.put("time.updatedAt", now_ms())

          new_entity = %{entity | "dimensions" => new_dims}
          state = put_entity(acc, new_entity)
          {state, [Entity.to_legacy(new_entity) | updated]}
        else
          {acc, updated}
        end
      end)

    {:reply, Enum.reverse(updated), state}
  end

  def handle_call({:mark_image_stored, cid, size}, _from, state) do
    {state, updated} =
      Enum.reduce(state.entities, {state, []}, fn {_id, entity}, {acc, updated} ->
        dims = Entity.dims(entity)

        if Map.get(dims, "entity.kind") == "image" and Map.get(dims, "content.cid") == cid and
             Map.get(dims, "content.stored") != true do
          new_dims =
            dims
            |> Map.put("content.stored", true)
            |> Map.put("content.size", size)
            |> Map.drop(["content.owner", "content.offline"])
            |> Map.put("time.updatedAt", now_ms())

          new_entity = %{entity | "dimensions" => new_dims}
          state = put_entity(acc, new_entity)
          {state, [Entity.to_legacy(new_entity) | updated]}
        else
          {acc, updated}
        end
      end)

    {:reply, Enum.reverse(updated), state}
  end

  def handle_call({:remove_unstored, cid}, _from, state) do
    ids =
      state.entities
      |> Enum.filter(fn {_id, entity} ->
        dims = Entity.dims(entity)
        Map.get(dims, "entity.kind") == "file" and Map.get(dims, "content.cid") == cid and
          Map.get(dims, "content.stored") != true and Map.get(dims, "content.offline") != true
      end)
      |> Enum.map(fn {id, _entity} -> id end)

    state = Enum.reduce(ids, state, fn id, acc -> delete_entity(acc, id) end)
    {:reply, length(ids), state}
  end

  def handle_call({:find_file, storedness, cid}, _from, state) do
    result =
      Enum.find_value(state.entities, :error, fn {_id, entity} ->
        dims = Entity.dims(entity)
        stored = Map.get(dims, "content.stored") == true
        matches_storedness = if storedness == :stored, do: stored, else: not stored

        if Map.get(dims, "entity.kind") == "file" and Map.get(dims, "content.cid") == cid and
             matches_storedness do
          {:ok, Entity.to_legacy(entity)}
        else
          nil
        end
      end)

    {:reply, result, state}
  end

  def handle_call({:find_image, cid}, _from, state) do
    result =
      Enum.find_value(state.entities, :error, fn {_id, entity} ->
        dims = Entity.dims(entity)

        if Map.get(dims, "entity.kind") == "image" and
             Map.get(dims, "content.cid") == cid and
             Map.get(dims, "content.stored") == true do
          {:ok, Entity.to_legacy(entity)}
        else
          nil
        end
      end)

    {:reply, result, state}
  end

  def handle_call({:find_avatar, cid}, _from, state) do
    result =
      Enum.find_value(state.entities, :error, fn {_id, entity} ->
        dims = Entity.dims(entity)

        if Map.get(dims, "entity.kind") == "peer" and
             Map.get(dims, "peer.avatarCid") == cid do
          {:ok, %{"name" => "avatar.vrm", "cid" => cid}}
        else
          nil
        end
      end)

    {:reply, result, state}
  end

  def handle_call({:set_peer_avatar, peer_id, cid}, _from, state) do
    case Map.fetch(state.entities, peer_id) do
      {:ok, entity} ->
        dims = Entity.dims(entity)

        new_dims =
          if is_nil(cid) do
            Map.delete(dims, "peer.avatarCid")
          else
            Map.put(dims, "peer.avatarCid", cid)
          end

        new_dims = Map.put(new_dims, "time.updatedAt", now_ms())
        state = put_entity(state, %{entity | "dimensions" => new_dims})
        {:reply, :ok, state}

      :error ->
        {:reply, :ok, state}
    end
  end

  def handle_call({:leave_peer, peer_id}, _from, state) do
    {:reply, :ok, leave_peer_state(state, peer_id)}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    cond do
      Map.has_key?(state.peer_refs, ref) ->
        peer_id = Map.fetch!(state.peer_refs, ref)

        {:noreply,
         leave_peer_state(%{state | peer_refs: Map.delete(state.peer_refs, ref)}, peer_id)}

      Map.has_key?(state.writer_refs, ref) ->
        peer_id = Map.fetch!(state.writer_refs, ref)
        state = %{state | writer_refs: Map.delete(state.writer_refs, ref)}
        {:noreply, release_held_by(state, peer_id, nil)}

      true ->
        subscriptions =
          state.subscriptions
          |> Enum.reject(fn {_id, subscription} -> subscription.ref == ref end)
          |> Map.new()

        {:noreply, %{state | subscriptions: subscriptions}}
    end
  end

  def handle_info(_info, state), do: {:noreply, state}

  defp apply_mutation(state, _actor, scope, %{"op" => "create"} = mutation) do
    dimensions = Map.get(mutation, "dimensions", %{})
    kind = Map.get(dimensions, "entity.kind")
    id = Map.get(mutation, "entityId")

    cond do
      not Scope.can_create_kind?(scope, kind) ->
        {:error, "forbidden"}

      kind != "box" ->
        {:error, "invalid_dimension"}

      not valid_uuid?(id) ->
        {:error, "invalid_message"}

      Map.has_key?(state.entities, id) ->
        {:error, "already_exists"}

      object_count(state) >= min(Schema.max_objects(), Scope.max_entities(scope)) ->
        {:error, "limit_exceeded"}

      not Scope.write_filter_matches?(scope, Map.put(dimensions, "session.id", state.session_id)) ->
        {:error, "forbidden"}

      true ->
        case Schema.validate_create(kind, dimensions) do
          :ok ->
            entity = new_entity(id, dimensions, state.session_id)
            new_state = put_entity(state, entity)
            {:ok, new_state.version, Entity.to_legacy(entity), new_state}

          {:error, code} ->
            {:error, code}
        end
    end
  end

  defp apply_mutation(state, actor, scope, %{"op" => "patch"} = mutation) do
    id = Map.get(mutation, "entityId")

    with {:ok, entity} <- fetch_entity(state, id),
         :ok <- check_version(entity, mutation),
         :ok <- check_conditions(entity, mutation),
         :ok <- check_write_filter(scope, entity),
         {:ok, set} <- patch_set(mutation),
         {:ok, unset} <- patch_unset(mutation),
         :ok <- check_patch_dims(scope, actor, entity, set, unset) do
      held_by = entity |> Entity.dims() |> Map.get("interaction.heldBy")
      kind = entity |> Entity.dims() |> Map.get("entity.kind")

      if space_patch?(set, unset) and kind != "peer" and held_by not in [nil, actor] do
        {:error, "held_by_other"}
      else
        dims = Entity.dims(entity)

        dims =
          Enum.reduce(set, dims, fn {name, value}, acc ->
            Map.put(acc, name, Schema.normalize(name, value))
          end)

        dims = Enum.reduce(unset, dims, fn name, acc -> Map.delete(acc, name) end)

        dims =
          if space_patch?(set, unset) and kind != "peer" and is_nil(held_by) do
            Map.put(dims, "interaction.heldBy", actor)
          else
            dims
          end

        if Schema.within_size_limit?(dims) do
          new_entity = %{entity | "dimensions" => Map.put(dims, "time.updatedAt", now_ms())}
          new_state = put_entity(state, new_entity)
          {:ok, new_state.version, Entity.to_legacy(new_entity), new_state}
        else
          {:error, "entity_too_large"}
        end
      end
    else
      {:error, code} -> {:error, code}
    end
  end

  defp apply_mutation(state, actor, scope, %{"op" => "delete"} = mutation) do
    id = Map.get(mutation, "entityId")

    with {:ok, entity} <- fetch_entity(state, id),
         :ok <- check_version(entity, mutation),
         :ok <- check_conditions(entity, mutation),
         true <- Entity.dims(entity)["entity.kind"] != "peer",
         true <- Scope.can_delete?(scope, actor, entity) do
      held_by = entity |> Entity.dims() |> Map.get("interaction.heldBy")

      if held_by != nil and held_by != actor do
        {:error, "held_by_other"}
      else
        new_state = delete_entity(state, id)
        {:ok, new_state.version, Entity.to_legacy(entity), new_state}
      end
    else
      false -> {:error, "forbidden"}
      {:error, code} -> {:error, code}
    end
  end

  defp apply_mutation(state, _actor, scope, %{"op" => "duplicate"} = mutation) do
    id = Map.get(mutation, "entityId")
    new_id = Map.get(mutation, "newEntityId")

    case fetch_entity(state, id) do
      {:ok, entity} ->
        cond do
          Map.get(Entity.dims(entity), "entity.kind") == "peer" ->
            {:error, "forbidden"}

          not Scope.write_filter_matches?(scope, Entity.dims(entity)) ->
            {:error, "forbidden"}

          not valid_uuid?(new_id) ->
            {:error, "invalid_message"}

          Map.has_key?(state.entities, new_id) ->
            {:error, "already_exists"}

          object_count(state) >= min(Schema.max_objects(), Scope.max_entities(scope)) ->
            {:error, "limit_exceeded"}

          true ->
            dims = Entity.dims(entity)
            position = Map.get(dims, "space.position", [0, 0, 0])
            yaw = Map.get(dims, "space.yaw", 0)
            scale = Map.get(dims, "space.scale", 1)
            side = duplicate_side(Map.get(dims, "entity.kind"), dims, scale)

            position = [
              Enum.at(position, 0) + :math.cos(yaw) * side + :math.sin(yaw) * @duplicate_normal_offset,
              Enum.at(position, 1),
              Enum.at(position, 2) - :math.sin(yaw) * side + :math.cos(yaw) * @duplicate_normal_offset
            ]

            copy_dims =
              dims
              |> Map.put("space.position", position)
              |> Map.drop(["interaction.heldBy", "time.playback", "time.createdAt", "time.updatedAt"])

            copy = new_entity(new_id, copy_dims, state.session_id)
            new_state = put_entity(state, copy)
            {:ok, new_state.version, Entity.to_legacy(copy), new_state}
        end

      {:error, code} ->
        {:error, code}
    end
  end

  defp apply_mutation(state, actor, scope, %{"op" => "claim"} = mutation) do
    id = Map.get(mutation, "entityId")

    with {:ok, entity} <- fetch_entity(state, id),
         true <- Entity.dims(entity)["entity.kind"] != "peer",
         true <- Scope.write_filter_matches?(scope, Entity.dims(entity)) do
      dims = Entity.dims(entity)
      held_by = Map.get(dims, "interaction.heldBy")

      if held_by in [nil, actor] do
        new_entity = %{
          entity
          | "dimensions" => dims |> Map.put("interaction.heldBy", actor) |> Map.put("time.updatedAt", now_ms())
        }

        new_state = put_entity(state, new_entity)
        {:ok, new_state.version, Entity.to_legacy(new_entity), new_state}
      else
        {:error, "held_by_other"}
      end
    else
      false -> {:error, "forbidden"}
      {:error, code} -> {:error, code}
    end
  end

  defp apply_mutation(state, actor, scope, %{"op" => "release"} = mutation) do
    id = Map.get(mutation, "entityId")

    with {:ok, entity} <- fetch_entity(state, id),
         true <- Entity.dims(entity)["entity.kind"] != "peer",
         true <- Scope.write_filter_matches?(scope, Entity.dims(entity)) do
      dims = Entity.dims(entity)

      if Map.get(dims, "interaction.heldBy") == actor do
        new_entity = %{
          entity
          | "dimensions" => dims |> Map.delete("interaction.heldBy") |> Map.put("time.updatedAt", now_ms())
        }

        new_state = put_entity(state, new_entity)
        {:ok, new_state.version, Entity.to_legacy(new_entity), new_state}
      else
        {:ok, state.version, Entity.to_legacy(entity), state}
      end
    else
      false -> {:error, "forbidden"}
      {:error, code} -> {:error, code}
    end
  end

  defp apply_mutation(_state, _actor, _scope, _mutation), do: {:error, "invalid_message"}

  defp fetch_entity(state, id) do
    case Map.fetch(state.entities, id) do
      {:ok, entity} -> {:ok, entity}
      :error -> {:error, "not_found"}
    end
  end

  defp check_version(entity, %{"ifVersion" => version}) when is_number(version) do
    if entity["version"] == version, do: :ok, else: {:error, "stale_entity"}
  end

  defp check_version(_entity, _mutation), do: :ok

  defp check_conditions(entity, %{"if" => conditions}) when is_list(conditions) do
    dims = Entity.dims(entity)

    if Enum.all?(conditions, &condition_ok?(dims, &1)) do
      :ok
    else
      {:error, "condition_failed"}
    end
  end

  defp check_conditions(_entity, _mutation), do: :ok

  defp condition_ok?(dims, %{"dim" => dim} = condition) do
    cond do
      Map.get(condition, "isAbsent") == true -> not Map.has_key?(dims, dim)
      Map.has_key?(condition, "eq") -> Map.get(dims, dim) == Map.get(condition, "eq")
      true -> false
    end
  end

  defp condition_ok?(_dims, _condition), do: false

  defp check_write_filter(scope, entity) do
    if Scope.write_filter_matches?(scope, Entity.dims(entity)), do: :ok, else: {:error, "forbidden"}
  end

  defp patch_set(%{"set" => set}) when is_map(set), do: {:ok, set}
  defp patch_set(%{"set" => nil}), do: {:ok, %{}}
  defp patch_set(_mutation), do: {:ok, %{}}

  defp patch_unset(%{"unset" => unset}) when is_list(unset) do
    if Enum.all?(unset, &is_binary/1), do: {:ok, unset}, else: {:error, "invalid_dimension"}
  end

  defp patch_unset(%{"unset" => nil}), do: {:ok, []}
  defp patch_unset(_mutation), do: {:ok, []}

  defp check_patch_dims(scope, actor, entity, set, unset) do
    with :ok <- Schema.validate_patch(set),
         true <- Enum.all?(Map.keys(set), &Scope.writable_dim?(scope, actor, entity, &1)),
         true <- Enum.all?(unset, &Scope.writable_dim?(scope, actor, entity, &1)) do
      :ok
    else
      false -> {:error, "forbidden"}
      {:error, code} -> {:error, code}
    end
  end

  defp space_patch?(set, unset) do
    Enum.any?(Map.keys(set), &String.starts_with?(&1, "space.")) or
      Enum.any?(unset, &String.starts_with?(&1, "space."))
  end

  defp add_seed_box(state, box) do
    id = Uuid.v4()
    dims = Entity.from_legacy("box", box)
    put_entity(state, new_entity(id, dims, state.session_id))
  end

  defp seed_demo_boxes, do: @initial_boxes

  defp new_entity(id, dimensions, session_id) do
    now = now_ms()

    dimensions =
      dimensions
      |> Map.put("session.id", session_id)
      |> Map.put("time.createdAt", now)
      |> Map.put("time.updatedAt", now)

    %{"id" => id, "version" => 0, "dimensions" => dimensions}
  end

  defp put_entity(state, entity) do
    version = state.version + 1
    entity = %{entity | "version" => version}
    old = Map.get(state.entities, entity["id"])
    entities = Map.put(state.entities, entity["id"], entity)
    state = %{state | version: version, entities: entities}
    broadcast_changes(state, [{:upsert, old, entity}])
  end

  defp delete_entity(state, id) do
    version = state.version + 1
    old = Map.get(state.entities, id)
    state = %{state | version: version, entities: Map.delete(state.entities, id)}
    broadcast_changes(state, [{:remove, old}])
  end

  defp broadcast_changes(state, changes) do
    now = now_ms()

    subscriptions =
      Enum.reduce(state.subscriptions, %{}, fn {sub_id, sub}, acc ->
        {sub, out} =
          Enum.reduce(changes, {sub, []}, fn change, {sub, out} ->
            {sub, out} = apply_change_to_subscription(sub, change, out)
            {sub, out}
          end)

        if out != [] do
          # Store the last version in each change set; the Reader adds its own seq.
          send(sub.pid, {:space_event, sub_id, state.version, now, Enum.reverse(out)})
        end

        Map.put(acc, sub_id, sub)
      end)

    %{state | subscriptions: subscriptions}
  end

  defp apply_change_to_subscription(sub, {:upsert, _old, entity}, out) do
    id = entity["id"]
    was = MapSet.member?(sub.matched, id)
    now = Query.matches?(Entity.dims(entity), sub.filter)
    matched = if now, do: MapSet.put(sub.matched, id), else: MapSet.delete(sub.matched, id)

    cond do
      now -> {%{sub | matched: matched}, [%{"op" => "upsert", "entity" => entity} | out]}
      was -> {%{sub | matched: matched}, [%{"op" => "remove", "id" => id} | out]}
      true -> {%{sub | matched: matched}, out}
    end
  end

  defp apply_change_to_subscription(sub, {:remove, old}, out) do
    case old do
      nil ->
        {sub, out}

      entity ->
        id = entity["id"]

        if MapSet.member?(sub.matched, id) do
          {%{sub | matched: MapSet.delete(sub.matched, id)}, [%{"op" => "remove", "id" => id} | out]}
        else
          {sub, out}
        end
    end
  end

  defp release_held_by(state, peer_id, keep_id) do
    Enum.reduce(state.entities, state, fn {id, entity}, acc ->
      dims = Entity.dims(entity)

      if Map.get(dims, "interaction.heldBy") == peer_id and id != keep_id do
        put_entity(acc, %{
          entity
          | "dimensions" => dims |> Map.delete("interaction.heldBy") |> Map.put("time.updatedAt", now_ms())
        })
      else
        acc
      end
    end)
  end

  defp mark_offline(state, owner_id) do
    Enum.reduce(state.entities, state, fn {_id, entity}, acc ->
      dims = Entity.dims(entity)

      if Map.get(dims, "entity.kind") in ["file", "image"] and
           Map.get(dims, "content.stored") != true and
           Map.get(dims, "content.owner") == owner_id and Map.get(dims, "content.offline") != true do
        put_entity(acc, %{
          entity
          | "dimensions" => dims |> Map.put("content.offline", true) |> Map.put("time.updatedAt", now_ms())
        })
      else
        acc
      end
    end)
  end

  defp leave_peer_state(state, peer_id) do
    state = delete_entity(state, peer_id)
    state = release_held_by(state, peer_id, nil)
    state = mark_offline(state, peer_id)

    peer_refs =
      Enum.reduce(state.peer_refs, %{}, fn {ref, id}, acc ->
        if id == peer_id do
          Process.demonitor(ref, [:flush])
          acc
        else
          Map.put(acc, ref, id)
        end
      end)

    %{
      state
      | peer_pids: Map.delete(state.peer_pids, peer_id),
        peer_refs: peer_refs
    }
  end

  defp object_count(state) do
    Enum.count(state.entities, fn {_id, entity} ->
      Map.get(Entity.dims(entity), "entity.kind") != "peer"
    end)
  end

  defp default_filter(session_id) do
    %{"all" => [%{"dim" => "session.id", "eq" => session_id}]}
  end

  defp fresh_subscription_id(state) do
    id = "sub-" <> Integer.to_string(state.next_subscription)

    if Map.has_key?(state.subscriptions, id) do
      fresh_subscription_id(%{state | next_subscription: state.next_subscription + 1})
    else
      id
    end
  end

  defp duplicate_side("box", dims, scale) do
    (Map.get(dims, "box.size", 1) * scale) + 0.2
  end

  defp duplicate_side("file", _dims, scale), do: (@file_icon_width + 0.15) * scale
  defp duplicate_side(_kind, _dims, scale), do: 0.6 * scale

  defp valid_id_or_new(nil, entities), do: fresh_id(entities)
  defp valid_id_or_new(id, entities) when is_binary(id), do: if(Map.has_key?(entities, id), do: fresh_id(entities), else: id)
  defp valid_id_or_new(_id, entities), do: fresh_id(entities)

  defp fresh_id(entities) do
    id = Uuid.v4()
    if Map.has_key?(entities, id), do: fresh_id(entities), else: id
  end

  defp valid_uuid?(value) when is_binary(value) do
    Regex.match?(~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, value)
  end

  defp valid_uuid?(_value), do: false

  defp now_ms, do: System.system_time(:millisecond)
end
