defmodule ProtoServer.ProtocolTest do
  use ExUnit.Case, async: true

  alias ProtoServer.Protocol

  @uuid "123e4567-e89b-42d3-a456-426614174000"
  @dag_pb_cid "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
  @raw_cid "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy"
  @v0_cid "QmRN6wdp1S2A5EtjW9A3M1vKSBuQQGcgvuhoMUoEz4iiT5"

  # Generated with Python's base32 encoder from the sha256("hello") digest.
  @raw_hello_cid "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
  @dag_pb_hello_cid "bafybeibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
  @raw_hello_z "zb2rhZfjRh2FHHB2RkHVEvL2vJnCTcu7kwRqgVsf9gpkLgteo"
  @bad_codec_cid "bafyreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
  @bad_hash_cid "bafkrgibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
  @bad_length_cid "bafkrehzm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4y"
  @trailing_bytes_cid "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeqaa"
  @bad_version_cid "bajkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"

  defp parse(message), do: Protocol.parse(Jason.encode!(message))

  describe "parse/1 join" do
    test "accepts join with and without a name" do
      assert parse(%{"type" => "join", "name" => "bob"}) ==
               {:ok, %{"type" => "join", "name" => "bob"}}

      assert parse(%{"type" => "join"}) == {:ok, %{"type" => "join", "name" => ""}}
      assert parse(%{"type" => "join", "name" => 5}) == {:ok, %{"type" => "join", "name" => ""}}
    end
  end

  describe "parse/1 pose" do
    test "normalizes the quaternion and preserves position" do
      message = %{
        "type" => "pose",
        "pose" => %{"position" => [1, 2, 3], "head" => [0, 0, 0, 2]}
      }

      assert parse(message) ==
               {:ok,
                %{
                  "type" => "pose",
                  "pose" => %{"position" => [1, 2, 3], "head" => [0.0, 0.0, 0.0, 1.0]}
                }}
    end

    test "normalizes a non-axis quaternion" do
      {:ok, %{"pose" => pose}} =
        parse(%{
          "type" => "pose",
          "pose" => %{"position" => [0, 0, 0], "head" => [0, 0, 0, 4]}
        })

      [x, y, z, w] = pose["head"]
      assert x == 0.0 and y == 0.0 and z == 0.0
      assert_in_delta w, 1.0, 1.0e-12
    end

    test "clamps optional crouch and lean and omits them when absent" do
      base = %{"position" => [0, 0, 0], "head" => [0, 0, 0, 1]}

      {:ok, %{"pose" => pose}} =
        parse(%{"type" => "pose", "pose" => Map.put(base, "crouch", 7)})

      assert pose["crouch"] == 1

      {:ok, %{"pose" => pose}} =
        parse(%{"type" => "pose", "pose" => Map.put(base, "crouch", -3)})

      assert pose["crouch"] == 0

      {:ok, %{"pose" => pose}} =
        parse(%{"type" => "pose", "pose" => Map.put(base, "lean", 9)})

      assert pose["lean"] == 1

      {:ok, %{"pose" => pose}} =
        parse(%{"type" => "pose", "pose" => Map.put(base, "lean", -9)})

      assert pose["lean"] == -1

      {:ok, %{"pose" => pose}} = parse(%{"type" => "pose", "pose" => base})
      refute Map.has_key?(pose, "crouch")
      refute Map.has_key?(pose, "lean")

      {:ok, %{"pose" => pose}} =
        parse(%{"type" => "pose", "pose" => Map.merge(base, %{"crouch" => 0.5, "lean" => 0.25})})

      assert pose["crouch"] == 0.5
      assert pose["lean"] == 0.25
    end

    test "rejects malformed poses" do
      base = %{"position" => [0, 0, 0], "head" => [0, 0, 0, 1]}

      for pose <- [
            nil,
            %{},
            Map.put(base, "position", [0, 0]),
            Map.put(base, "position", [0, 0, "0"]),
            Map.put(base, "position", [1001, 0, 0]),
            Map.put(base, "head", [0, 0, 0]),
            Map.put(base, "head", [0, 0, 0, 0]),
            Map.put(base, "head", [0, 0, 0, 1.0e-9]),
            Map.put(base, "crouch", "1"),
            Map.put(base, "crouch", nil),
            Map.put(base, "lean", "1"),
            Map.put(base, "lean", nil)
          ] do
        assert parse(%{"type" => "pose", "pose" => pose}) == :error
      end
    end
  end

  describe "parse/1 object operations" do
    test "accepts the documented id-only messages" do
      for type <- ~w(grab_object release_object delete_object duplicate_object request_file) do
        assert parse(%{"type" => type, "id" => @uuid}) ==
                 {:ok, %{"type" => type, "id" => @uuid}}
      end
    end

    test "rejects malformed ids" do
      for type <- ~w(grab_object release_object delete_object duplicate_object request_file) do
        assert parse(%{"type" => type, "id" => "nope"}) == :error
        assert parse(%{"type" => type}) == :error
        assert parse(%{"type" => type, "id" => 5}) == :error
        assert parse(%{"type" => type, "id" => String.upcase(@uuid)}) == :error
      end
    end
  end

  describe "parse/1 video_control" do
    test "accepts valid playback state" do
      message = %{
        "type" => "video_control",
        "id" => @uuid,
        "playing" => true,
        "time" => 12.5
      }

      assert parse(message) == {:ok, message}
      assert parse(%{message | "time" => 0}) == {:ok, %{message | "time" => 0}}
      assert parse(%{message | "time" => 86_400}) == {:ok, %{message | "time" => 86_400}}
    end

    test "rejects invalid playback state" do
      valid = %{"type" => "video_control", "id" => @uuid, "playing" => true, "time" => 1}

      for patch <- [
            %{"playing" => "yes"},
            %{"playing" => nil},
            %{"time" => -1},
            %{"time" => 86_401},
            %{"time" => "1"},
            %{"time" => nil},
            %{"id" => "nope"}
          ] do
        assert parse(Map.merge(valid, patch)) == :error
      end

      assert parse(Map.delete(valid, "playing")) == :error
      assert parse(Map.delete(valid, "time")) == :error
    end
  end

  describe "parse/1 move_object" do
    test "accepts placement and omits absent optional fields" do
      message = %{"type" => "move_object", "id" => @uuid, "position" => [1, 0, -2], "yaw" => 0.5}

      assert parse(message) == {:ok, message}

      {:ok, parsed} = parse(message)
      refute Map.has_key?(parsed, "pitch")
      refute Map.has_key?(parsed, "scale")
    end

    test "accepts optional pitch and scale" do
      message = %{
        "type" => "move_object",
        "id" => @uuid,
        "position" => [1, 2, -2],
        "yaw" => 0.5,
        "pitch" => -0.7,
        "scale" => 2.5
      }

      assert parse(message) == {:ok, message}
    end

    test "rejects invalid placement and scale" do
      valid = %{"type" => "move_object", "id" => @uuid, "position" => [1, 0, -2], "yaw" => 0.5}

      for patch <- [
            %{"position" => [1, 0]},
            %{"position" => [5000, 0, 0]},
            %{"position" => [nil, 0, 0]},
            %{"yaw" => "1"},
            %{"yaw" => nil},
            %{"pitch" => "1"},
            %{"pitch" => nil},
            %{"scale" => 0},
            %{"scale" => 0.05},
            %{"scale" => 10.5},
            %{"scale" => "2"},
            %{"scale" => nil},
            %{"id" => "nope"}
          ] do
        assert parse(Map.merge(valid, patch)) == :error
      end
    end
  end

  describe "parse/1 place_box" do
    test "accepts a box and omits an absent objectId" do
      message = %{
        "type" => "place_box",
        "position" => [1, 0, 2],
        "yaw" => 0,
        "size" => 1.5,
        "color" => "#aabbcc"
      }

      assert parse(message) == {:ok, message}
      {:ok, parsed} = parse(message)
      refute Map.has_key?(parsed, "objectId")
    end

    test "accepts an optional pitch and objectId" do
      message = %{
        "type" => "place_box",
        "position" => [1, 0, 2],
        "yaw" => 0,
        "pitch" => -0.5,
        "size" => 1,
        "color" => "#AABBCC",
        "objectId" => @uuid
      }

      assert parse(message) == {:ok, message}
    end

    test "rejects invalid size, color, placement and objectId" do
      valid = %{
        "type" => "place_box",
        "position" => [1, 0, 2],
        "yaw" => 0,
        "size" => 1,
        "color" => "#aabbcc"
      }

      for patch <- [
            %{"size" => 0},
            %{"size" => 0.09},
            %{"size" => 1000},
            %{"size" => "1"},
            %{"color" => "red"},
            %{"color" => "#12345"},
            %{"position" => [1, 2]},
            %{"pitch" => "x"},
            %{"objectId" => "nope"},
            %{"objectId" => 5}
          ] do
        assert parse(Map.merge(valid, patch)) == :error
      end
    end
  end

  describe "parse/1 place_image" do
    test "accepts an image and omits an absent name and objectId" do
      message = %{
        "type" => "place_image",
        "cid" => @dag_pb_cid,
        "position" => [1, 0, -2],
        "yaw" => 1.5,
        "width" => 2,
        "height" => 1.5
      }

      assert parse(message) == {:ok, message}
      {:ok, parsed} = parse(message)
      refute Map.has_key?(parsed, "name")
      refute Map.has_key?(parsed, "objectId")

      assert parse(%{message | "cid" => @raw_cid}) == {:ok, %{message | "cid" => @raw_cid}}
    end

    test "sanitizes an optional name and omits unusable names" do
      base = %{
        "type" => "place_image",
        "cid" => @dag_pb_cid,
        "position" => [0, 0, 0],
        "yaw" => 0,
        "width" => 2,
        "height" => 1
      }

      assert {:ok, %{"name" => "cat.png"}} =
               parse(Map.put(base, "name", "cat.png"))

      assert {:ok, %{"name" => "a_b.png"}} = parse(Map.put(base, "name", "a/b.png"))

      {:ok, parsed} = parse(Map.put(base, "name", "..."))
      refute Map.has_key?(parsed, "name")

      {:ok, parsed} = parse(Map.put(base, "name", 5))
      refute Map.has_key?(parsed, "name")
    end

    test "accepts an optional objectId" do
      message = %{
        "type" => "place_image",
        "cid" => @dag_pb_cid,
        "position" => [0, 0, 0],
        "yaw" => 0,
        "width" => 2,
        "height" => 1,
        "objectId" => @uuid
      }

      assert parse(message) == {:ok, message}
      assert parse(Map.put(message, "objectId", "nope")) == :error
    end

    test "rejects invalid cid, placement and dimensions" do
      valid = %{
        "type" => "place_image",
        "cid" => @dag_pb_cid,
        "position" => [1, 0, -2],
        "yaw" => 1.5,
        "width" => 2,
        "height" => 1.5
      }

      for patch <- [
            %{"cid" => "../etc/passwd"},
            %{"cid" => @uuid},
            %{"cid" => nil},
            %{"position" => [1, 0]},
            %{"position" => [5000, 0, 0]},
            %{"yaw" => "1"},
            %{"width" => 0},
            %{"width" => 0.09},
            %{"height" => 1000},
            %{"width" => nil}
          ] do
        assert parse(Map.merge(valid, patch)) == :error
      end
    end
  end

  describe "parse/1 place_file" do
    test "accepts a file and sanitizes the name" do
      message = %{
        "type" => "place_file",
        "cid" => @dag_pb_cid,
        "name" => "report.pdf",
        "position" => [1, 0.4, -2],
        "yaw" => 0.5
      }

      assert parse(message) == {:ok, message}

      assert {:ok, %{"name" => "_.._evilgpj.exe"}} =
               parse(Map.put(message, "name", "../../evil\u202Egpj.exe"))

      assert {:ok, %{"name" => "file"}} =
               parse(Map.delete(message, "name"))

      assert {:ok, %{"name" => "file"}} =
               parse(Map.put(message, "name", 5))
    end

    test "accepts an objectId and ignores client size/category" do
      message = %{
        "type" => "place_file",
        "cid" => @dag_pb_cid,
        "name" => "report.pdf",
        "position" => [1, 0.4, -2],
        "yaw" => 0.5,
        "objectId" => @uuid,
        "size" => 1,
        "category" => "video"
      }

      assert {:ok, parsed} = parse(message)
      assert parsed["objectId"] == @uuid
      refute Map.has_key?(parsed, "size")
      refute Map.has_key?(parsed, "category")
    end

    test "rejects invalid cid, placement and objectId" do
      valid = %{
        "type" => "place_file",
        "cid" => @dag_pb_cid,
        "name" => "report.pdf",
        "position" => [0, 0, 0],
        "yaw" => 0
      }

      for patch <- [
            %{"cid" => "nope"},
            %{"position" => [0, 0]},
            %{"position" => [9999, 0, 0]},
            %{"yaw" => "1"},
            %{"objectId" => "nope"}
          ] do
        assert parse(Map.merge(valid, patch)) == :error
      end
    end
  end

  describe "parse/1 place_url" do
    test "accepts http and https URLs" do
      https = %{
        "type" => "place_url",
        "url" => "https://example.com/a.png",
        "position" => [1, 0, 2],
        "yaw" => 0.5
      }

      assert parse(https) == {:ok, https}

      http = %{https | "url" => "http://example.com/"}
      assert parse(http) == {:ok, http}

      uppercase = %{https | "url" => "HTTPS://EXAMPLE.COM/a.png"}
      assert parse(uppercase) == {:ok, uppercase}
    end

    test "accepts objectId and pitch" do
      message = %{
        "type" => "place_url",
        "url" => "https://example.com/",
        "position" => [1, 0, 2],
        "yaw" => 0,
        "pitch" => 0.5,
        "objectId" => @uuid
      }

      assert parse(message) == {:ok, message}
    end

    test "rejects bad schemes, lengths, placement and objectId" do
      valid = %{
        "type" => "place_url",
        "url" => "https://example.com/a.png",
        "position" => [1, 0, 2],
        "yaw" => 0.5
      }

      max_url = "https://" <> String.duplicate("a", 2048 - 8)
      too_long = max_url <> "a"
      assert parse(Map.put(valid, "url", max_url)) != :error
      assert parse(Map.put(valid, "url", too_long)) == :error

      for patch <- [
            %{"url" => "ftp://example.com/x"},
            %{"url" => "javascript:alert(1)"},
            %{"url" => 5},
            %{"url" => ""},
            %{"position" => [1, 2]},
            %{"yaw" => "x"},
            %{"pitch" => "x"},
            %{"objectId" => "nope"}
          ] do
        assert parse(Map.merge(valid, patch)) == :error
      end
    end
  end

  describe "parse/1 ipfs_peer" do
    test "accepts a libp2p peer id" do
      message = %{"type" => "ipfs_peer", "peerId" => "12D3KooWAbCdEfGh"}
      assert parse(message) == {:ok, message}
    end

    test "rejects malformed peer ids" do
      for peer_id <- ["short", "has spaces", String.duplicate("a", 129), 5, nil] do
        assert parse(%{"type" => "ipfs_peer", "peerId" => peer_id}) == :error
      end
    end
  end

  describe "parse/1 set_avatar" do
    test "accepts file CIDs and null" do
      for cid <- [@v0_cid, @dag_pb_cid, @raw_cid] do
        assert parse(%{"type" => "set_avatar", "cid" => cid}) ==
                 {:ok, %{"type" => "set_avatar", "cid" => cid}}
      end

      assert parse(%{"type" => "set_avatar", "cid" => nil}) ==
               {:ok, %{"type" => "set_avatar", "cid" => nil}}
    end

    test "rejects missing, non-string and non-file CIDs" do
      for cid <- [5, "nope", "", @uuid, @bad_codec_cid, @bad_hash_cid] do
        assert parse(%{"type" => "set_avatar", "cid" => cid}) == :error
      end

      assert parse(%{"type" => "set_avatar"}) == :error
    end
  end

  describe "parse/1 malformed input" do
    test "rejects malformed JSON and unknown types" do
      assert Protocol.parse("not json") == :error
      assert Protocol.parse("123") == :error
      assert Protocol.parse("null") == :error
      assert Protocol.parse(~s({"type":"nope"})) == :error
      assert Protocol.parse(~s({"type":"pose","pose":{}})) == :error
      assert Protocol.parse(~s([])) == :error
      assert Protocol.parse(123) == :error
    end

    test "returns unsupported for removed crdt-v1 types" do
      for type <- ~w(sync_hello sync_update sync_part claim claim_release) do
        assert Protocol.parse(Jason.encode!(%{"type" => type})) == {:unsupported, type}
      end

      assert Protocol.parse(~s({"type":"sync_update","update":"AAAA"})) ==
               {:unsupported, "sync_update"}
    end

    test "encodes string-keyed maps" do
      assert Protocol.parse(Protocol.encode(%{"type" => "join", "name" => "bob"})) ==
               {:ok, %{"type" => "join", "name" => "bob"}}
    end
  end

  describe "normalize_cid/1" do
    test "accepts dag-pb, raw and CIDv0 file CIDs unchanged" do
      assert Protocol.normalize_cid(@dag_pb_cid) == @dag_pb_cid
      assert Protocol.normalize_cid(@raw_cid) == @raw_cid
      assert Protocol.normalize_cid(@v0_cid) == @v0_cid
      assert Protocol.normalize_cid(@raw_hello_cid) == @raw_hello_cid
      assert Protocol.normalize_cid(@dag_pb_hello_cid) == @dag_pb_hello_cid
    end

    test "re-encodes CIDv1 as canonical lowercase base32" do
      assert Protocol.normalize_cid(@raw_hello_z) == @raw_hello_cid

      uppercase =
        "B" <> String.upcase(binary_part(@dag_pb_hello_cid, 1, byte_size(@dag_pb_hello_cid) - 1))

      assert Protocol.normalize_cid(uppercase) == @dag_pb_hello_cid
    end

    test "rejects non-file CIDs and malformed values" do
      for value <- [
            "",
            "nope",
            "../etc/passwd",
            @uuid,
            String.duplicate("a", 129),
            123,
            nil,
            @bad_codec_cid,
            @bad_hash_cid,
            @bad_length_cid,
            @trailing_bytes_cid,
            @bad_version_cid
          ] do
        assert Protocol.normalize_cid(value) == :error
      end
    end
  end

  describe "sanitize_name/2" do
    test "trims, truncates and falls back" do
      assert Protocol.sanitize_name("  alice  ", "x") == "alice"
      assert String.length(Protocol.sanitize_name(String.duplicate("a", 100), "x")) == 24
      assert Protocol.sanitize_name("   ", "ab12") == "Guest-ab12"
      assert Protocol.sanitize_name(42, "ab12") == "Guest-ab12"
      assert Protocol.sanitize_name(nil, "ab12") == "Guest-ab12"
    end
  end

  describe "sanitize_file_name/2" do
    test "normalizes NFC and removes forbidden characters" do
      assert Protocol.sanitize_file_name("e\u0301.txt") == "é.txt"

      assert Protocol.sanitize_file_name("a\u0000b\u007Fc\u200Bd\u202Ee\u2060f\u2066g\uFEFF.txt") ==
               "abcdefg.txt"

      assert Protocol.sanitize_file_name("a\\b/c:d*e?f\"g<h>i|j.txt") ==
               "a_b_c_d_e_f_g_h_i_j.txt"
    end

    test "removes leading dots and trailing dots/spaces" do
      assert Protocol.sanitize_file_name("....secret.txt") == "secret.txt"
      assert Protocol.sanitize_file_name("name...  ") == "name"
      assert Protocol.sanitize_file_name("../../evil\u202Egpj.exe") == "_.._evilgpj.exe"
    end

    test "falls back for empty and non-string input" do
      assert Protocol.sanitize_file_name("...", "") == ""
      assert Protocol.sanitize_file_name("   ", "fallback") == "fallback"
      assert Protocol.sanitize_file_name(5) == "file"
      assert Protocol.sanitize_file_name(nil, "other") == "other"
    end

    test "truncates while preserving a known extension" do
      name = Protocol.sanitize_file_name(String.duplicate("a", 200) <> ".txt")

      assert String.length(name) == 120
      assert String.ends_with?(name, ".txt")
      assert String.length(String.trim_trailing(name, ".txt")) == 116

      upper = Protocol.sanitize_file_name(String.duplicate("a", 200) <> ".TXT")
      assert String.ends_with?(upper, ".txt")
      assert String.length(upper) == 120

      no_extension = Protocol.sanitize_file_name(String.duplicate("あ", 200))
      assert String.length(no_extension) == 120
    end

    test "ignores unusable extensions when truncating" do
      name = Protocol.sanitize_file_name(String.duplicate("a", 200) <> ".toolongextension")

      assert String.length(name) == 120
      refute String.ends_with?(name, ".toolongextension")
    end
  end
end
