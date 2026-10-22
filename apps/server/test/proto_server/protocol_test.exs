defmodule ProtoServer.ProtocolTest do
  use ExUnit.Case, async: true

  alias ProtoServer.Protocol

  @uuid "123e4567-e89b-42d3-a456-426614174000"
  @uuid2 "223e4567-e89b-42d3-a456-426614174000"
  @dag_pb_cid "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
  @raw_cid "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy"
  @v0_cid "QmRN6wdp1S2A5EtjW9A3M1vKSBuQQGcgvuhoMUoEz4iiT5"
  @raw_hello_cid "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
  @dag_pb_hello_cid "bafybeibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
  @raw_hello_z "zb2rhZfjRh2FHHB2RkHVEvL2vJnCTcu7kwRqgVsf9gpkLgteo"
  @bad_codec_cid "bafyreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
  @bad_hash_cid "bafkrgibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"
  @bad_length_cid "bafkrehzm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4y"
  @trailing_bytes_cid "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeqaa"
  @bad_version_cid "bajkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq"

  defp parse(message), do: Protocol.parse(Jason.encode!(message))

  describe "parse/1 space_join" do
    test "accepts a v2 join and an optional session id" do
      base = %{
        "type" => "space_join",
        "name" => "alice",
        "templateId" => "vr-sns-3d",
        "schemaVersion" => 1
      }

      assert parse(base) == {:ok, base}

      with_session = Map.put(base, "sessionId", "main")
      assert parse(with_session) == {:ok, with_session}
    end

    test "rejects malformed joins" do
      valid = %{
        "type" => "space_join",
        "name" => "alice",
        "templateId" => "vr-sns-3d",
        "schemaVersion" => 1
      }

      for patch <- [
            %{"name" => 5},
            %{"templateId" => nil},
            %{"schemaVersion" => "1"},
            %{"sessionId" => 5}
          ] do
        assert parse(Map.merge(valid, patch)) == :error
      end
    end

    test "recognizes removed legacy messages" do
      for type <- ~w(join pose place_image place_file place_box place_url request_file ipfs_peer set_avatar video_control grab_object move_object release_object delete_object duplicate_object sync_hello sync_update sync_part claim claim_release) do
        assert parse(%{"type" => type}) == {:legacy, type}
      end
    end
  end

  describe "parse/1 space_mutate" do
    test "accepts a create mutation" do
      message = %{
        "type" => "space_mutate",
        "mutation" => %{
          "commandId" => @uuid,
          "op" => "create",
          "entityId" => @uuid2,
          "dimensions" => %{
            "entity.kind" => "box",
            "space.position" => [0, 0, 0],
            "space.yaw" => 0,
            "box.size" => 1,
            "box.color" => "#aabbcc"
          }
        }
      }

      assert {:ok, %{"type" => "space_mutate", "mutation" => mutation}} = parse(message)
      assert mutation["entityId"] == @uuid2
      assert mutation["dimensions"]["entity.kind"] == "box"
    end

    test "accepts a patch mutation with conditions" do
      mutation = %{
        "commandId" => @uuid,
        "op" => "patch",
        "entityId" => @uuid2,
        "set" => %{"space.position" => [1, 0, 2]},
        "unset" => ["space.scale"],
        "if" => [%{"dim" => "interaction.heldBy", "eq" => @uuid}],
        "ifVersion" => 3
      }

      assert {:ok, %{"mutation" => parsed}} = parse(%{"type" => "space_mutate", "mutation" => mutation})
      assert parsed["ifVersion"] == 3
      assert parsed["unset"] == ["space.scale"]
    end

    test "accepts claim, release, duplicate and delete mutations" do
      for mutation <- [
            %{"commandId" => @uuid, "op" => "claim", "entityId" => @uuid2},
            %{"commandId" => @uuid, "op" => "release", "entityId" => @uuid2},
            %{
              "commandId" => @uuid,
              "op" => "duplicate",
              "entityId" => @uuid2,
              "newEntityId" => "323e4567-e89b-42d3-a456-426614174000"
            },
            %{"commandId" => @uuid, "op" => "delete", "entityId" => @uuid2}
          ] do
        assert {:ok, _} = parse(%{"type" => "space_mutate", "mutation" => mutation})
      end
    end

    test "rejects malformed mutations" do
      for mutation <- [
            nil,
            %{},
            %{"commandId" => "nope", "op" => "claim", "entityId" => @uuid2},
            %{"commandId" => @uuid, "op" => "explode", "entityId" => @uuid2},
            %{"commandId" => @uuid, "op" => "create", "entityId" => "nope", "dimensions" => %{}},
            %{"commandId" => @uuid, "op" => "patch", "entityId" => @uuid2, "set" => []},
            %{"commandId" => @uuid, "op" => "patch", "entityId" => @uuid2, "unset" => "x"},
            %{"commandId" => @uuid, "op" => "duplicate", "entityId" => @uuid2, "newEntityId" => "nope"}
          ] do
        assert parse(%{"type" => "space_mutate", "mutation" => mutation}) == :error
      end
    end
  end

  describe "parse/1 read requests" do
    test "accepts query, subscribe and unsubscribe" do
      filter = %{"all" => [%{"dim" => "session.id", "eq" => "main"}]}

      assert parse(%{"type" => "space_query", "requestId" => "q1", "filter" => filter, "limit" => 10}) ==
               {:ok, %{"type" => "space_query", "requestId" => "q1", "filter" => filter, "limit" => 10}}

      assert parse(%{"type" => "space_subscribe", "subscriptionId" => "sub-1", "filter" => filter}) ==
               {:ok, %{"type" => "space_subscribe", "subscriptionId" => "sub-1", "filter" => filter}}

      assert parse(%{"type" => "space_unsubscribe", "subscriptionId" => "sub-1"}) ==
               {:ok, %{"type" => "space_unsubscribe", "subscriptionId" => "sub-1"}}
    end

    test "rejects malformed read requests" do
      assert parse(%{"type" => "space_query", "requestId" => 5, "filter" => %{}}) == :error
      assert parse(%{"type" => "space_subscribe", "subscriptionId" => "sub-1", "filter" => []}) == :error
      assert parse(%{"type" => "space_unsubscribe"}) == :error
    end
  end

  describe "parse/1 content commands" do
    test "accepts URL import" do
      message = %{
        "type" => "space_import_url",
        "commandId" => @uuid,
        "entityId" => @uuid2,
        "url" => "https://example.com/a.png",
        "position" => [1, 0, 2],
        "yaw" => 0.5
      }

      assert parse(message) == {:ok, message}
    end

    test "rejects unsafe URL import" do
      valid = %{
        "type" => "space_import_url",
        "commandId" => @uuid,
        "entityId" => @uuid2,
        "url" => "https://example.com/",
        "position" => [1, 0, 2],
        "yaw" => 0.5
      }

      for patch <- [
            %{"url" => "javascript:alert(1)"},
            %{"url" => "ftp://example.com/"},
            %{"url" => ""},
            %{"position" => [1, 2]},
            %{"position" => [5000, 0, 0]},
            %{"yaw" => "x"},
            %{"entityId" => "nope"}
          ] do
        assert parse(Map.merge(valid, patch)) == :error
      end
    end

    test "accepts avatar and file request commands" do
      assert parse(%{"type" => "space_set_avatar", "commandId" => @uuid, "cid" => @dag_pb_cid}) ==
               {:ok, %{"type" => "space_set_avatar", "commandId" => @uuid, "cid" => @dag_pb_cid}}

      assert parse(%{"type" => "space_set_avatar", "commandId" => @uuid, "cid" => nil}) ==
               {:ok, %{"type" => "space_set_avatar", "commandId" => @uuid, "cid" => nil}}

      assert parse(%{"type" => "file_request", "commandId" => @uuid, "entityId" => @uuid2}) ==
               {:ok, %{"type" => "file_request", "commandId" => @uuid, "entityId" => @uuid2}}
    end

    test "rejects malformed avatar and file requests" do
      assert parse(%{"type" => "space_set_avatar", "commandId" => @uuid, "cid" => "nope"}) == :error
      assert parse(%{"type" => "space_set_avatar", "commandId" => @uuid}) == :error
      assert parse(%{"type" => "file_request", "commandId" => "nope", "entityId" => @uuid2}) == :error
      assert parse(%{"type" => "file_request", "commandId" => @uuid}) == :error
    end
  end

  describe "parse/1 malformed input" do
    test "rejects malformed JSON and unknown types" do
      assert Protocol.parse("not json") == :error
      assert Protocol.parse("123") == :error
      assert Protocol.parse("null") == :error
      assert Protocol.parse(~s({"type":"nope"})) == :error
      assert Protocol.parse(~s([])) == :error
      assert Protocol.parse(123) == :error
    end

    test "encodes string-keyed maps" do
      message = %{
        "type" => "space_join",
        "name" => "bob",
        "templateId" => "vr-sns-3d",
        "schemaVersion" => 1
      }

      assert Protocol.parse(Protocol.encode(message)) == {:ok, message}
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
    end
  end
end
