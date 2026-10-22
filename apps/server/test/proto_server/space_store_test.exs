defmodule ProtoServer.Space.StoreTest do
  use ExUnit.Case, async: false

  alias ProtoServer.Uuid
  alias ProtoServer.Space.{Scope, Store}

  setup do
    session = "test-" <> Integer.to_string(System.unique_integer([:positive]))

    start_supervised!(
      {Store,
       session_id: session,
       seed: false,
       ipfs_info: %{"peerId" => "test", "wsPort" => 8081},
       ice_servers_fun: fn _ -> nil end}
    )

    {:ok, peer_id, _self, []} = Store.create_peer(session, self(), "alice")
    scope = Scope.default_member(session, peer_id)

    %{session: session, peer_id: peer_id, scope: scope}
  end

  test "creates a peer entity and returns a welcome identity", %{session: session, peer_id: peer_id} do
    assert {:ok, %{"kind" => "peer", "name" => "alice"}} = Store.get_object(session, peer_id)
  end

  test "sets and clears a peer avatar even when pinning is not available", %{
    session: session,
    peer_id: peer_id
  } do
    assert :ok = Store.set_peer_avatar(session, peer_id, "bafy-avatar")
    assert {:ok, %{"avatarCid" => "bafy-avatar"}} = Store.get_object(session, peer_id)

    assert :ok = Store.set_peer_avatar(session, peer_id, nil)
    assert {:ok, peer} = Store.get_object(session, peer_id)
    refute Map.has_key?(peer, "avatarCid")
  end

  test "finds an avatar cid for media delivery", %{session: session, peer_id: peer_id} do
    assert :error = Store.find_avatar(session, "bafy-avatar")
    assert :ok = Store.set_peer_avatar(session, peer_id, "bafy-avatar")
    assert {:ok, %{"name" => "avatar.vrm", "cid" => "bafy-avatar"}} = Store.find_avatar(session, "bafy-avatar")
  end

  test "places an image before the server has pinned it", %{session: session} do
    cid = "bafy-image"

    assert {:ok, %{"kind" => "image", "cid" => ^cid, "width" => 2, "height" => 1}} =
             Store.add_image(session, %{
               "cid" => cid,
               "position" => [1, 0, 2],
               "yaw" => 0,
               "width" => 2,
               "height" => 1,
               "name" => "pixel.png",
               "stored" => false,
               "owner" => "peer-1"
             })

    assert [_] = Store.mark_image_stored(session, cid, 68)
  end

  test "creates, patches and deletes a box", %{session: session, peer_id: peer_id, scope: scope} do
    id = Uuid.v4()

    create = %{
      "commandId" => Uuid.v4(),
      "op" => "create",
      "entityId" => id,
      "dimensions" => %{
        "entity.kind" => "box",
        "space.position" => [1, 0, 2],
        "space.yaw" => 0.5,
        "box.size" => 1,
        "box.color" => "#aabbcc"
      }
    }

    assert {:ok, version, %{"id" => ^id}} = Store.mutate(session, peer_id, scope, create)
    assert version > 0

    patch = %{
      "commandId" => Uuid.v4(),
      "op" => "patch",
      "entityId" => id,
      "set" => %{"space.position" => [3, 0, 4], "space.yaw" => 0.9}
    }

    assert {:ok, _version, %{"position" => [3, 0, 4], "heldBy" => ^peer_id}} =
             Store.mutate(session, peer_id, scope, patch)

    delete = %{"commandId" => Uuid.v4(), "op" => "delete", "entityId" => id}
    assert {:ok, _version, %{"id" => ^id}} = Store.mutate(session, peer_id, scope, delete)
    assert Store.get_object(session, id) == :error
  end

  test "rejects a patch by a peer that does not hold the box", %{
    session: session,
    peer_id: first,
    scope: first_scope
  } do
    id = Uuid.v4()

    assert {:ok, _version, _object} =
             Store.mutate(session, first, first_scope, %{
               "commandId" => Uuid.v4(),
               "op" => "create",
               "entityId" => id,
               "dimensions" => %{
                 "entity.kind" => "box",
                 "space.position" => [0, 0, 0],
                 "space.yaw" => 0,
                 "box.size" => 1,
                 "box.color" => "#aabbcc"
               }
             })

    {:ok, second, _self, []} = Store.create_peer(session, self(), "bob")
    second_scope = Scope.default_member(session, second)

    assert {:ok, _version, _object} =
             Store.mutate(session, first, first_scope, %{
               "commandId" => Uuid.v4(),
               "op" => "claim",
               "entityId" => id
             })

    assert {:error, "held_by_other"} =
             Store.mutate(session, second, second_scope, %{
               "commandId" => Uuid.v4(),
               "op" => "patch",
               "entityId" => id,
               "set" => %{"space.position" => [9, 0, 9]}
             })
  end

  test "queries and subscribes to session entities", %{
    session: session,
    peer_id: peer_id,
    scope: scope
  } do
    id = Uuid.v4()

    assert {:ok, _version, _object} =
             Store.mutate(session, peer_id, scope, %{
               "commandId" => Uuid.v4(),
               "op" => "create",
               "entityId" => id,
               "dimensions" => %{
                 "entity.kind" => "box",
                 "space.position" => [5, 0, 5],
                 "space.yaw" => 0,
                 "box.size" => 1,
                 "box.color" => "#aabbcc"
               }
             })

    filter = %{"all" => [%{"dim" => "space.position", "within" => %{"min" => [4, -1, 4], "max" => [6, 1, 6]}}]}
    assert {:ok, version, [%{"id" => ^id}]} = Store.query(session, filter, 100)
    assert version > 0

    {:ok, subscription_id, _version, entities} = Store.subscribe(session, self(), filter, "sub-test")
    assert Enum.any?(entities, &(&1["id"] == id))

    patch = %{
      "commandId" => Uuid.v4(),
      "op" => "patch",
      "entityId" => id,
      "set" => %{"space.position" => [20, 0, 20]}
    }

    assert {:ok, _version, _object} = Store.mutate(session, peer_id, scope, patch)

    assert_receive {:space_event, ^subscription_id, _version, _at,
                    [%{"op" => "remove", "id" => ^id}]}
  end

  test "leaves a peer, releases its claim and marks its unstored files offline", %{
    session: session,
    peer_id: peer_id,
    scope: scope
  } do
    box_id = Uuid.v4()

    assert {:ok, _version, _object} =
             Store.mutate(session, peer_id, scope, %{
               "commandId" => Uuid.v4(),
               "op" => "create",
               "entityId" => box_id,
               "dimensions" => %{
                 "entity.kind" => "box",
                 "space.position" => [0, 0, 0],
                 "space.yaw" => 0,
                 "box.size" => 1,
                 "box.color" => "#aabbcc"
               }
             })

    assert {:ok, _version, _object} =
             Store.mutate(session, peer_id, scope, %{
               "commandId" => Uuid.v4(),
               "op" => "claim",
               "entityId" => box_id
             })

    assert {:ok, _object} = Store.get_object(session, peer_id)
    assert :ok = Store.leave_peer(session, peer_id)
    assert Store.get_object(session, peer_id) == :error
    assert {:ok, released} = Store.get_object(session, box_id)
    refute Map.has_key?(released, "heldBy")
  end
end
