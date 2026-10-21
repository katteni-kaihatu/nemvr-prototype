defmodule ProtoServer.RoomTest do
  use ExUnit.Case, async: false

  alias ProtoServer.Room

  @ipfs %{"peerId" => "peer", "wsPort" => 8081}

  defp start_room(opts \\ []) do
    opts =
      Keyword.merge(
        [seed: false, ipfs_info: @ipfs, ice_servers_fun: fn _ -> nil end],
        opts
      )

    start_supervised!({Room, opts})
  end

  defp fake_peer do
    test = self()
    spawn_link(fn -> forward_loop(test) end)
  end

  defp forward_loop(test) do
    receive do
      msg ->
        send(test, {:peer, msg})
        forward_loop(test)
    end
  end

  defp next_json(timeout \\ 1_000) do
    receive do
      {:peer, {:proto_send, json}} -> Jason.decode!(json)
    after
      timeout -> flunk("timed out waiting for a peer message")
    end
  end

  defp await_type(type, timeout \\ 1_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_await_type(type, deadline)
  end

  defp do_await_type(type, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:peer, {:proto_send, json}} ->
        message = Jason.decode!(json)

        if message["type"] == type do
          message
        else
          do_await_type(type, deadline)
        end
    after
      remaining -> flunk("timed out waiting for #{type}")
    end
  end

  defp refute_type(type, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_refute_type(type, deadline)
  end

  defp do_refute_type(type, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:peer, {:proto_send, json}} ->
        message = Jason.decode!(json)

        if message["type"] == type do
          flunk("unexpected #{type}: #{inspect(message)}")
        else
          do_refute_type(type, deadline)
        end
    after
      remaining -> :ok
    end
  end

  defp flush_peers do
    receive do
      {:peer, _msg} -> flush_peers()
    after
      0 -> :ok
    end
  end

  defp settle do
    Process.sleep(30)
    flush_peers()
  end

  defp box_place(attrs \\ %{}) do
    Map.merge(%{"position" => [0, 0, 0], "yaw" => 0, "size" => 1, "color" => "#d9534f"}, attrs)
  end

  defp image_place(attrs) do
    Map.merge(
      %{
        "cid" => "bafyimage",
        "name" => "image.png",
        "position" => [0, 0, 0],
        "yaw" => 0,
        "width" => 1,
        "height" => 1
      },
      attrs
    )
  end

  defp file_place(attrs) do
    Map.merge(
      %{
        "cid" => "baffile",
        "name" => "file.bin",
        "position" => [0, 0, 0],
        "yaw" => 0,
        "size" => 1,
        "category" => "file",
        "stored" => true
      },
      attrs
    )
  end

  test "join sends a welcome with the legacy shape" do
    start_room()
    peer = fake_peer()

    assert {:ok, id} = Room.join(peer, "alice")
    welcome = next_json()

    assert welcome["type"] == "welcome"
    assert welcome["self"] == %{"id" => id, "name" => "alice", "color" => "#e6194b"}
    assert welcome["peers"] == []
    assert welcome["objects"] == []
    assert welcome["videos"] == %{}
    assert welcome["ipfs"] == @ipfs
    assert welcome["tickRate"] == 20
    refute Map.has_key?(welcome, "iceServers")
    refute Map.has_key?(welcome, "sync")
    assert Room.size() == 1
  end

  test "second join sees the first peer, broadcasts peer_joined, and snapshots stop when empty" do
    start_room()

    first = fake_peer()
    second = fake_peer()

    assert {:ok, first_id} = Room.join(first, "first")
    assert %{"type" => "welcome"} = await_type("welcome")

    assert {:ok, second_id} = Room.join(second, "second")
    welcome = await_type("welcome")

    assert [first_peer] = welcome["peers"]
    assert first_peer["id"] == first_id
    assert first_peer["name"] == "first"
    assert first_peer["color"] == "#e6194b"

    joined = await_type("peer_joined")
    assert joined["peer"]["id"] == second_id
    assert joined["peer"]["pose"] == %{"position" => [0, 0, 0], "head" => [0, 0, 0, 1]}

    snapshot = await_type("snapshot")
    assert is_integer(snapshot["time"])
    assert snapshot["poses"] |> Map.keys() |> Enum.sort() == Enum.sort([first_id, second_id])

    assert :ok = Room.leave(first_id)
    assert :ok = Room.leave(second_id)

    Process.sleep(80)
    flush_peers()
    refute_type("snapshot", 120)
  end

  test "empty names fall back to Guest-<id prefix>" do
    start_room()

    assert {:ok, id} = Room.join(fake_peer(), "   ")
    welcome = next_json()

    assert welcome["self"]["name"] == "Guest-" <> binary_part(id, 0, 4)
  end

  test "grab is exclusive and grabbing another object releases the previous one" do
    start_room()

    first = fake_peer()
    second = fake_peer()

    assert {:ok, first_id} = Room.join(first, "first")
    assert %{"type" => "welcome"} = await_type("welcome")

    assert {:ok, second_id} = Room.join(second, "second")
    assert %{"type" => "welcome"} = await_type("welcome")
    assert %{"type" => "peer_joined"} = await_type("peer_joined")

    assert {:ok, object1} = Room.add_box(box_place())
    assert {:ok, object2} = Room.add_box(box_place(%{"position" => [3, 0, 0]}))
    settle()

    assert :ok = Room.grab_object(first_id, object1["id"])
    assert {:ok, %{"heldBy" => ^first_id}} = Room.get_object(object1["id"])
    settle()

    assert :ok = Room.grab_object(second_id, object1["id"])

    error = await_type("error")
    assert error["message"] == "他の人がつかんでいます"

    rollback = await_type("object_updated")
    assert rollback["object"]["id"] == object1["id"]
    assert rollback["object"]["heldBy"] == first_id

    assert {:ok, %{"heldBy" => ^first_id}} = Room.get_object(object1["id"])

    assert :ok = Room.grab_object(first_id, object2["id"])

    assert {:ok, released} = Room.get_object(object1["id"])
    refute Map.has_key?(released, "heldBy")

    assert {:ok, %{"heldBy" => ^first_id}} = Room.get_object(object2["id"])
  end

  test "only the holder can move an object, the mover is excluded, and nil orientation is removed" do
    start_room()

    first = fake_peer()
    second = fake_peer()

    assert {:ok, first_id} = Room.join(first, "first")
    assert %{"type" => "welcome"} = await_type("welcome")

    assert {:ok, second_id} = Room.join(second, "second")
    assert %{"type" => "welcome"} = await_type("welcome")
    assert %{"type" => "peer_joined"} = await_type("peer_joined")

    assert {:ok, object} = Room.add_box(box_place())
    assert :ok = Room.grab_object(first_id, object["id"])
    settle()

    assert :ok =
             Room.move_object(first_id, object["id"], [1, 0, 2], 0.5, 0.3, 2)

    update = await_type("object_updated")
    assert update["object"]["id"] == object["id"]
    assert update["object"]["position"] == [1, 0, 2]
    assert update["object"]["yaw"] == 0.5
    assert update["object"]["pitch"] == 0.3
    assert update["object"]["scale"] == 2

    settle()

    assert :ok = Room.move_object(first_id, object["id"], [3, 0, 4], 0.7, nil, nil)

    update = await_type("object_updated")
    assert update["object"]["position"] == [3, 0, 4]
    refute Map.has_key?(update["object"], "pitch")
    refute Map.has_key?(update["object"], "scale")

    settle()

    assert :ok = Room.move_object(second_id, object["id"], [9, 9, 9], 0, nil, nil)
    refute_type("object_updated", 100)

    assert {:ok, %{"position" => [3, 0, 4]}} = Room.get_object(object["id"])
  end

  test "delete refuses an object held by another peer and removes the holder's object" do
    start_room()

    first = fake_peer()
    second = fake_peer()

    assert {:ok, first_id} = Room.join(first, "first")
    assert %{"type" => "welcome"} = await_type("welcome")

    assert {:ok, second_id} = Room.join(second, "second")
    assert %{"type" => "welcome"} = await_type("welcome")
    assert %{"type" => "peer_joined"} = await_type("peer_joined")

    assert {:ok, object} = Room.add_box(box_place())
    assert :ok = Room.grab_object(first_id, object["id"])
    settle()

    assert {:error, :held} = Room.delete_object(second_id, object["id"])
    error = await_type("error")
    assert error["message"] == "他の人がつかんでいます"
    assert {:ok, _object} = Room.get_object(object["id"])

    assert {:ok, removed} = Room.delete_object(first_id, object["id"])
    assert removed["id"] == object["id"]

    removed_message = await_type("object_removed")
    assert removed_message["id"] == object["id"]
    assert Room.get_object(object["id"]) == :error
  end

  test "duplicate offsets boxes and images, assigns a new id and clears heldBy" do
    start_room()

    peer = fake_peer()
    assert {:ok, peer_id} = Room.join(peer, "duplicator")
    assert %{"type" => "welcome"} = await_type("welcome")

    assert {:ok, box} =
             Room.add_box(box_place(%{"position" => [1, 2, 3], "size" => 2}))

    assert :ok = Room.grab_object(peer_id, box["id"])

    assert {:ok, box_copy} = Room.duplicate_object(peer_id, box["id"])
    assert box_copy["id"] != box["id"]
    assert box_copy["kind"] == "box"
    refute Map.has_key?(box_copy, "heldBy")
    assert [x, y, z] = box_copy["position"]
    assert_in_delta x, 3.2, 1.0e-9
    assert y == 2
    assert_in_delta z, 3.05, 1.0e-9

    assert {:ok, image} =
             Room.add_image(image_place(%{"position" => [10, 0, 0]}))

    assert {:ok, image_copy} = Room.duplicate_object(peer_id, image["id"])
    assert image_copy["id"] != image["id"]
    assert image_copy["kind"] == "image"
    refute Map.has_key?(image_copy, "heldBy")
    assert [x, y, z] = image_copy["position"]
    assert_in_delta x, 10.6, 1.0e-9
    assert y == 0
    assert_in_delta z, 0.05, 1.0e-9
  end

  test "video state only applies to stored video files, clamps time, and is removed with the object" do
    start_room()

    peer = fake_peer()
    assert {:ok, peer_id} = Room.join(peer, "viewer")
    assert %{"type" => "welcome"} = await_type("welcome")

    assert {:ok, unstored} =
             Room.add_file(
               file_place(%{"cid" => "cid-unstored", "stored" => false, "category" => "video"})
             )

    assert {:ok, audio} =
             Room.add_file(
               file_place(%{"cid" => "cid-audio", "stored" => true, "category" => "audio"})
             )

    assert {:ok, video} =
             Room.add_file(
               file_place(%{"cid" => "cid-video", "stored" => true, "category" => "video"})
             )

    settle()

    assert :ok = Room.set_video_state(peer_id, unstored["id"], true, 10)
    assert :ok = Room.set_video_state(peer_id, audio["id"], true, 10)
    refute_type("video_state", 100)

    assert :ok = Room.set_video_state(peer_id, video["id"], true, -5)
    video_state = await_type("video_state")
    assert video_state["id"] == video["id"]
    assert video_state["playing"] == true
    assert video_state["time"] == 0
    assert is_integer(video_state["at"])

    assert %{videos: videos} = :sys.get_state(Room)
    assert videos[video["id"]]["time"] == 0

    assert :ok = Room.set_video_state(peer_id, video["id"], false, 100_000)
    video_state = await_type("video_state")
    assert video_state["playing"] == false
    assert video_state["time"] == 86_400

    assert {:ok, _removed} = Room.delete_object(peer_id, video["id"])
    assert %{"type" => "object_removed"} = await_type("object_removed")

    assert %{videos: videos} = :sys.get_state(Room)
    refute Map.has_key?(videos, video["id"])
  end

  test "mark_stored updates matching files and remove_unstored keeps offline files" do
    start_room()

    peer = fake_peer()
    assert {:ok, peer_id} = Room.join(peer, "owner")
    assert %{"type" => "welcome"} = await_type("welcome")

    assert {:ok, first} =
             Room.add_file(
               file_place(%{
                 "cid" => "cid-a",
                 "stored" => false,
                 "owner" => peer_id,
                 "size" => 1
               })
             )

    assert {:ok, second} =
             Room.add_file(
               file_place(%{
                 "cid" => "cid-a",
                 "stored" => false,
                 "owner" => peer_id,
                 "size" => 2
               })
             )

    assert {:ok, offline} =
             Room.add_file(
               file_place(%{
                 "cid" => "cid-a",
                 "stored" => false,
                 "owner" => peer_id,
                 "size" => 3,
                 "offline" => true
               })
             )

    settle()

    updated = Room.mark_stored("cid-a", 42)
    assert length(updated) == 3

    for object <- updated do
      assert object["stored"] == true
      assert object["size"] == 42
      refute Map.has_key?(object, "owner")
      refute Map.has_key?(object, "offline")
    end

    for object <- [first, second, offline] do
      assert {:ok, updated_object} = Room.get_object(object["id"])
      assert updated_object["stored"] == true
      assert updated_object["size"] == 42
      refute Map.has_key?(updated_object, "owner")
      refute Map.has_key?(updated_object, "offline")
    end

    assert {:ok, removable} =
             Room.add_file(file_place(%{"cid" => "cid-b", "stored" => false}))

    assert {:ok, offline_b} =
             Room.add_file(file_place(%{"cid" => "cid-b", "stored" => false, "offline" => true}))

    assert {:ok, stored_b} =
             Room.add_file(file_place(%{"cid" => "cid-b", "stored" => true}))

    assert Room.remove_unstored("cid-b") == 1
    assert Room.get_object(removable["id"]) == :error
    assert {:ok, _} = Room.get_object(offline_b["id"])
    assert {:ok, _} = Room.get_object(stored_b["id"])
  end

  test "leaving broadcasts peer_left, releases held objects, and marks owner files offline" do
    start_room()

    first = fake_peer()
    second = fake_peer()

    assert {:ok, first_id} = Room.join(first, "first")
    assert %{"type" => "welcome"} = await_type("welcome")

    assert {:ok, second_id} = Room.join(second, "second")
    assert %{"type" => "welcome"} = await_type("welcome")
    assert %{"type" => "peer_joined"} = await_type("peer_joined")

    assert {:ok, box} = Room.add_box(box_place())

    assert {:ok, file} =
             Room.add_file(
               file_place(%{
                 "cid" => "cid-leave",
                 "stored" => false,
                 "owner" => first_id
               })
             )

    assert :ok = Room.grab_object(first_id, box["id"])
    settle()

    assert :ok = Room.leave(first_id)

    left = await_type("peer_left")
    assert left["id"] == first_id

    box_update = await_type("object_updated")
    assert box_update["object"]["id"] == box["id"]
    refute Map.has_key?(box_update["object"], "heldBy")

    file_update = await_type("object_updated")
    assert file_update["object"]["id"] == file["id"]
    assert file_update["object"]["offline"] == true

    assert {:ok, box_after} = Room.get_object(box["id"])
    refute Map.has_key?(box_after, "heldBy")
    assert {:ok, %{"offline" => true}} = Room.get_object(file["id"])
    assert Room.size() == 1
    assert second_id != first_id
  end

  test "seed true creates the five demo boxes" do
    start_room(seed: true)

    assert %{objects: objects} = :sys.get_state(Room)
    assert map_size(objects) == 5
    assert objects |> Map.values() |> Enum.all?(&(&1["kind"] == "box"))
    assert objects |> Map.keys() |> Enum.uniq() |> length() == 5

    expected = [
      {[0, 0, 0], 1, "#d9534f"},
      {[6, 0, -4], 2, "#5bc0de"},
      {[-7, 0, -6], 1.5, "#5cb85c"},
      {[10, 0, 8], 1, "#f0ad4e"},
      {[-10, 0, 7], 3, "#9b59b6"}
    ]

    for {position, size, color} <- expected do
      assert Enum.any?(Map.values(objects), fn object ->
               object["position"] == position and object["size"] == size and
                 object["color"] == color and object["yaw"] == 0
             end)
    end
  end

  test "progress and error messages omit optional fields and only go to the target peer" do
    start_room()

    first = fake_peer()
    second = fake_peer()

    assert {:ok, first_id} = Room.join(first, "first")
    assert %{"type" => "welcome"} = await_type("welcome")

    assert {:ok, _second_id} = Room.join(second, "second")
    assert %{"type" => "welcome"} = await_type("welcome")
    assert %{"type" => "peer_joined"} = await_type("peer_joined")

    assert :ok = Room.send_place_progress(first_id, "cid", 10, nil, false)
    progress = await_type("place_progress")
    assert progress == %{"type" => "place_progress", "cid" => "cid", "loaded" => 10}

    assert :ok = Room.send_prepare_progress(first_id, "cid", 20, 100, true)
    progress = await_type("prepare_progress")
    assert progress["total"] == 100
    assert progress["queued"] == true

    assert :ok = Room.send_prepare_failed(first_id, "cid", "failed")
    assert %{"type" => "prepare_failed", "message" => "failed"} = await_type("prepare_failed")

    assert :ok = Room.send_error(first_id, "oops")
    assert %{"type" => "error", "message" => "oops"} = await_type("error")
  end
end
