defmodule ProtoServer.UuidTest do
  use ExUnit.Case, async: true

  test "v4 returns a lowercase 8-4-4-4-12 UUID with version and variant bits" do
    uuid = ProtoServer.Uuid.v4()

    assert uuid =~ ~r/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    refute uuid == ProtoServer.Uuid.v4()
  end
end
