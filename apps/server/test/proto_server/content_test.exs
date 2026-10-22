defmodule ProtoServer.ContentTest do
  use ExUnit.Case, async: false

  alias ProtoServer.{Content, Media}

  @png <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0::32, "IHDR", 1::32, 1::32>>
  @jpeg <<0xFF, 0xD8, 0xFF, 0xE0>>
  @gif "GIF89a"
  @webp <<"RIFF", 0::32, "WEBP">>

  @mebibyte 1024 * 1024

  setup do
    previous = Application.get_env(:proto_server, :content_max_total_mb)
    Application.put_env(:proto_server, :content_max_total_mb, 1)

    on_exit(fn ->
      if is_nil(previous) do
        Application.delete_env(:proto_server, :content_max_total_mb)
      else
        Application.put_env(:proto_server, :content_max_total_mb, previous)
      end
    end)

    start_supervised!(ProtoServer.Content)
    :ok
  end

  describe "limits/1" do
    test "uses the documented limits and messages" do
      image = Content.limits(:image)
      assert image.max_bytes == 24 * @mebibyte
      assert image.too_large_message == "画像が大きすぎます (上限 24 MB)"

      file = Content.limits(:file)
      assert file.max_bytes == 2 * 1024 * @mebibyte
      assert file.too_large_message == "ファイルが大きすぎます (上限 2.0 GB)"

      avatar = Content.limits(:avatar)
      assert avatar.max_bytes == 64 * @mebibyte

      assert avatar.too_large_message ==
               "アバターが大きすぎます (上限 #{Media.format_bytes(64 * @mebibyte)})"
    end
  end

  describe "check/3" do
    test "accepts supported image magic bytes" do
      assert :ok == Content.check(:image, 128, @png)
      assert :ok == Content.check(:image, 128, @jpeg)
      assert :ok == Content.check(:image, 128, @gif)
      assert :ok == Content.check(:image, 128, @webp)
    end

    test "rejects images that do not sniff" do
      for head <- ["", "not an image", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"] do
        assert {:error, "対応していない画像形式です (PNG / JPEG / GIF / WebP)"} ==
                 Content.check(:image, 128, head)
      end
    end

    test "rejects sizes over the limit for each kind" do
      assert {:error, "画像が大きすぎます (上限 24 MB)"} ==
               Content.check(:image, 24 * @mebibyte + 1, @png)

      assert {:error, "ファイルが大きすぎます (上限 2.0 GB)"} ==
               Content.check(:file, 2 * 1024 * @mebibyte + 1, "")

      assert {:error, avatar_message} =
               Content.check(:avatar, 64 * @mebibyte + 1, "")

      assert avatar_message ==
               "アバターが大きすぎます (上限 #{Media.format_bytes(64 * @mebibyte)})"
    end

    test "does not require image magic for files or avatars" do
      assert :ok == Content.check(:file, 128, "anything")
      assert :ok == Content.check(:avatar, 128, "anything")
    end
  end

  describe "reserve/1 and unreserve/1" do
    test "books capacity, including outstanding reservations" do
      assert {:ok, first} = Content.reserve(600_000)
      assert {:ok, second} = Content.reserve(400_000)

      assert {:error, message} = Content.reserve(100_000)
      assert message =~ "サーバーの保存容量の上限に達しました"
      assert message =~ Media.format_bytes(@mebibyte)
      assert message =~ "不要なものを削除してください"

      assert :ok == Content.unreserve(first)
      assert {:ok, third} = Content.reserve(500_000)

      assert :ok == Content.unreserve(second)
      assert :ok == Content.unreserve(third)
    end

    test "rejects invalid sizes" do
      assert {:error, _message} = Content.reserve(-1)
    end
  end

  describe "acquire/5" do
    test "inserts a new entry and tracks total bytes" do
      assert {:ok, %{size: 1234, head: @png}} =
               Content.acquire("cid-new", :image, 1234, @png, nil)

      assert Content.count() == 1
      assert Content.total_bytes() == 1234

      assert {:ok, %{size: 1234, head: @png}} = Content.known("cid-new")
    end

    test "increments references for an already-known CID" do
      assert {:ok, %{size: 100}} = Content.acquire("cid-existing", :image, 100, @png, nil)
      assert Content.count() == 1
      assert Content.total_bytes() == 100

      assert {:ok, %{size: 100}} = Content.acquire("cid-existing", :image, 100, @png, nil)
      assert Content.count() == 1
      assert Content.total_bytes() == 100

      assert :ok == Content.retain("cid-existing")
      assert :ok == Content.release("cid-existing")
      assert Content.count() == 1

      assert :ok == Content.release("cid-existing")
      assert Content.count() == 1

      assert :ok == Content.release("cid-existing")
      assert Content.count() == 0
      assert Content.total_bytes() == 0
      assert Content.known("cid-existing") == :error
    end

    test "enforces capacity for new entries" do
      assert {:ok, _info} = Content.acquire("cid-big-1", :file, 700_000, "", nil)
      assert Content.total_bytes() == 700_000

      assert {:error, message} = Content.acquire("cid-big-2", :file, 700_000, "", nil)
      assert message =~ "サーバーの保存容量の上限に達しました"
      assert Content.count() == 1
      assert Content.total_bytes() == 700_000
    end

    test "consumes a reservation and checks final capacity" do
      assert {:ok, ref} = Content.reserve(500_000)
      assert {:ok, _info} = Content.acquire("cid-reserved", :file, 500_000, "", ref)

      assert Content.total_bytes() == 500_000
      assert {:error, _message} = Content.acquire("cid-other", :file, 600_000, "", nil)
    end

    test "unreserves the reference when the check fails" do
      assert {:ok, ref} = Content.reserve(200_000)

      assert {:error, "対応していない画像形式です (PNG / JPEG / GIF / WebP)"} =
               Content.acquire("cid-invalid-image", :image, 100, "not an image", ref)

      # If the failed acquire had kept the reservation, this would exceed 1 MiB.
      assert {:ok, ref2} = Content.reserve(@mebibyte)
      assert :ok == Content.unreserve(ref2)
    end

    test "release of an unknown CID is a no-op" do
      assert :ok == Content.release("missing")
      assert Content.count() == 0
    end
  end

  describe "settle/0" do
    test "returns ok and flushes a pending GC" do
      assert {:ok, _info} = Content.acquire("cid-settle", :file, 100, "", nil)
      assert :ok == Content.release("cid-settle")
      assert :ok == Content.settle()
      assert Content.count() == 0
      assert Content.total_bytes() == 0
    end
  end
end
