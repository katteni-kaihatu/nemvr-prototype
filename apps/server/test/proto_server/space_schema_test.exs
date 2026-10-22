defmodule ProtoServer.Space.SchemaTest do
  use ExUnit.Case, async: true

  alias ProtoServer.Space.{Query, Schema, Scope}

  test "the server copy of the shared schema matches the protocol package" do
    server = Path.expand("../../priv/space-schema.json", __DIR__)
    protocol = Path.expand("../../../../packages/protocol/space-schema.json", __DIR__)

    assert File.read!(server) == File.read!(protocol)
  end

  test "validates a box create" do
    dims = %{
      "entity.kind" => "box",
      "space.position" => [1, 0, 2],
      "space.yaw" => 0.5,
      "box.size" => 1,
      "box.color" => "#aabbcc"
    }

    assert Schema.validate_create("box", dims) == :ok
    assert Schema.validate_create("box", Map.put(dims, "box.color", "red")) ==
             {:error, "invalid_dimension"}
    assert Schema.validate_create("box", Map.put(dims, "space.position", [5000, 0, 0])) ==
             {:error, "invalid_dimension"}
  end

  test "requires the mandatory dimensions" do
    assert Schema.validate_create("box", %{"entity.kind" => "box"}) ==
             {:error, "missing_dimension"}
  end

  test "matches nested filters and position ranges" do
    dims = %{"session.id" => "main", "space.position" => [5, 0, 5]}

    filter = %{
      "all" => [
        %{"dim" => "session.id", "eq" => "main"},
        %{"dim" => "space.position", "within" => %{"min" => [4, -1, 4], "max" => [6, 1, 6]}}
      ]
    }

    assert Query.valid_filter?(filter)
    assert Query.matches?(dims, filter)
    refute Query.matches?(dims, %{"all" => [%{"dim" => "session.id", "eq" => "other"}]})
  end

  test "allows holding peers only their own writable dimensions" do
    scope = Scope.default_member("main", "peer-1")

    peer = %{
      "id" => "peer-1",
      "dimensions" => %{"entity.kind" => "peer", "peer.color" => "#aabbcc"}
    }

    object = %{
      "id" => "box-1",
      "dimensions" => %{
        "entity.kind" => "box",
        "interaction.heldBy" => "peer-2",
        "space.position" => [0, 0, 0]
      }
    }

    assert Scope.writable_dim?(scope, "peer-1", peer, "space.position")
    refute Scope.writable_dim?(scope, "peer-1", peer, "peer.color")
    # Scope allows the dimension; the Store enforces the current holder.
    assert Scope.writable_dim?(scope, "peer-1", object, "space.position")
    refute Scope.writable_dim?(scope, "peer-1", object, "content.cid")
  end
end
