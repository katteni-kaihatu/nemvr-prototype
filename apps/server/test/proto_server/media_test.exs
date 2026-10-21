defmodule ProtoServer.MediaTest do
  use ExUnit.Case, async: true

  alias ProtoServer.Media

  @png <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0::32, "IHDR", 640::32, 480::32>>

  @gif "GIF89a" <> <<320::16-little, 200::16-little>>

  @jpeg <<0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x0B, 8, 480::16-big, 640::16-big, 1, 1, 0x11, 0>>

  @jpeg_with_app0 <<0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0, 0xFF, 0xC0, 0x00, 0x0B, 8,
                    100::16-big, 200::16-big, 1, 1, 0x11, 0>>

  @webp_vp8 <<"RIFF", 0::32, "WEBP", "VP8 ", 0::32, 0::48, 320::16-little, 240::16-little>>

  @webp_vp8l <<"RIFF", 0::32, "WEBP", "VP8L", 0::32, 0x2F, 0x01, 0x80, 0x00, 0x00, 0>>

  @webp_vp8x <<"RIFF", 0::32, "WEBP", "VP8X", 0::32, 0::32, 9::24-little, 4::24-little>>

  describe "parse_range/2" do
    test "returns :none without a header" do
      assert Media.parse_range(nil, 100) == :none
      assert Media.parse_range(nil, 0) == :none
    end

    test "parses start-end, start- and suffix forms" do
      assert Media.parse_range("bytes=0-99", 100) == {:ok, 0, 99}
      assert Media.parse_range("bytes=10-19", 100) == {:ok, 10, 19}
      assert Media.parse_range("bytes=90-", 100) == {:ok, 90, 99}
      assert Media.parse_range("bytes=-10", 100) == {:ok, 90, 99}
      assert Media.parse_range("bytes=-500", 100) == {:ok, 0, 99}
      assert Media.parse_range("bytes=0-0", 1) == {:ok, 0, 0}
    end

    test "trims surrounding whitespace" do
      assert Media.parse_range("  bytes=0-9  ", 10) == {:ok, 0, 9}
    end

    test "clamps an oversized end to the last byte" do
      assert Media.parse_range("bytes=50-999", 100) == {:ok, 50, 99}
    end

    test "accepts a suffix larger than the file" do
      assert Media.parse_range("bytes=-999999", 10) == {:ok, 0, 9}
    end

    test "rejects malformed headers" do
      for header <- [
            "",
            "bytes=0-1,3-4",
            "items=0-1",
            "bytes=a-b",
            "bytes=-0",
            "bytes=30-20",
            "bytes=100-",
            "bytes=200-300"
          ] do
        assert Media.parse_range(header, 100) == :invalid
      end
    end

    test "rejects ranges for empty or invalid sizes" do
      assert Media.parse_range("bytes=0-", 0) == :invalid
      assert Media.parse_range("bytes=-1", 0) == :invalid
      assert Media.parse_range("bytes=0-0", -1) == :invalid
      assert Media.parse_range("bytes=0-", 0) == :invalid
    end

    test "returns :invalid for non-binary headers" do
      assert Media.parse_range(123, 10) == :invalid
    end
  end

  describe "media_type/1" do
    test "maps known extensions case-insensitively" do
      expected = %{
        "mp4" => "video/mp4",
        "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac"
      }

      for {extension, type} <- expected do
        assert Media.media_type("clip." <> extension) == type
        assert Media.media_type("CLIP." <> String.upcase(extension)) == type
      end
    end

    test "falls back to application/octet-stream" do
      assert Media.media_type("no-extension") == "application/octet-stream"
      assert Media.media_type("weird.xyz") == "application/octet-stream"
      assert Media.media_type("name.") == "application/octet-stream"
      assert Media.media_type(".mp4") == "application/octet-stream"
      assert Media.media_type(5) == "application/octet-stream"
    end
  end

  describe "classify_file/2" do
    test "classifies every documented audio extension" do
      for extension <-
            ~w(mp3 wav ogg oga opus flac aac m4a m4b wma aif aiff mid midi weba amr ape) do
        assert Media.classify_file("clip." <> extension, <<>>) == "audio"
      end
    end

    test "classifies every documented video extension" do
      for extension <- ~w(mp4 m4v webm mkv mov avi wmv flv ogv mpg mpeg 3gp m2ts vob) do
        assert Media.classify_file("clip." <> extension, <<>>) == "video"
      end
    end

    test "uses the extension before sniffing" do
      assert Media.classify_file("clip.mp3", <<0x1A, 0x45, 0xDF, 0xA3>>) == "audio"
      assert Media.classify_file("clip.mp4", "ID3") == "video"
    end

    test "sniffs unknown extensions from the head" do
      assert Media.classify_file("clip.bin", <<0x1A, 0x45, 0xDF, 0xA3>>) == "video"
      assert Media.classify_file("clip.bin", "RIFF" <> <<0::32>> <> "AVI ") == "video"
      assert Media.classify_file("clip.bin", <<0::32, "ftypM4A ">>) == "audio"
      assert Media.classify_file("clip.bin", <<0::32, "ftypisom">>) == "video"
      assert Media.classify_file("clip.bin", "ID3") == "audio"
      assert Media.classify_file("clip.bin", <<0xFF, 0xFB>>) == "audio"
      assert Media.classify_file("clip.bin", <<0xFF, 0xFA>>) == "audio"
      assert Media.classify_file("clip.bin", <<0xFF, 0xF1>>) == "audio"
      assert Media.classify_file("clip.bin", "RIFF" <> <<0::32>> <> "WAVE") == "audio"
      assert Media.classify_file("clip.bin", "OggS") == "audio"
      assert Media.classify_file("clip.bin", "fLaC") == "audio"
      assert Media.classify_file("clip.bin", "FORM" <> <<0::32>> <> "AIFF") == "audio"
      assert Media.classify_file("clip.bin", "MThd") == "audio"
      assert Media.classify_file("clip.bin", "not media") == "file"
      assert Media.classify_file("clip.bin", "") == "file"
    end
  end

  describe "sniff_image_type/1" do
    test "recognizes the four supported formats" do
      assert Media.sniff_image_type(@png) == :png
      assert Media.sniff_image_type(<<0xFF, 0xD8, 0xFF, 0xE0>>) == :jpeg
      assert Media.sniff_image_type("GIF87a") == :gif
      assert Media.sniff_image_type(@gif) == :gif
      assert Media.sniff_image_type("RIFF" <> <<0::32>> <> "WEBP") == :webp
    end

    test "returns nil for unsupported or short data" do
      assert Media.sniff_image_type("") == nil
      assert Media.sniff_image_type("<svg></svg>") == nil
      assert Media.sniff_image_type(<<0x89, 0x50>>) == nil
      assert Media.sniff_image_type(5) == nil
    end
  end

  describe "image_size/1" do
    test "reads PNG, GIF and JPEG dimensions" do
      assert Media.image_size(@png) == {:ok, 640, 480}
      assert Media.image_size(@gif) == {:ok, 320, 200}
      assert Media.image_size(@jpeg) == {:ok, 640, 480}
      assert Media.image_size(@jpeg_with_app0) == {:ok, 200, 100}
    end

    test "reads WebP VP8, VP8L and VP8X dimensions" do
      assert Media.image_size(@webp_vp8) == {:ok, 320, 240}
      assert Media.image_size(@webp_vp8l) == {:ok, 2, 3}
      assert Media.image_size(@webp_vp8x) == {:ok, 10, 5}
    end

    test "returns :error for short or unknown headers" do
      assert Media.image_size(binary_part(@png, 0, 23)) == :error
      assert Media.image_size(binary_part(@gif, 0, 9)) == :error
      assert Media.image_size(<<0xFF, 0xD8, 0xFF, 0xE0, 0, 0>>) == :error
      assert Media.image_size(binary_part(@webp_vp8, 0, 29)) == :error
      assert Media.image_size(binary_part(@webp_vp8l, 0, 24)) == :error
      assert Media.image_size(binary_part(@webp_vp8x, 0, 29)) == :error
      assert Media.image_size("RIFF" <> <<0::32>> <> "WEBPXXXX" <> <<0::128>>) == :error
      assert Media.image_size("not an image") == :error
      assert Media.image_size(5) == :error
    end
  end

  describe "format_bytes/1" do
    test "formats byte-sized values" do
      assert Media.format_bytes(0) == "0 B"
      assert Media.format_bytes(1) == "1 B"
      assert Media.format_bytes(1023) == "1023 B"
      assert Media.format_bytes(5.5) == "6 B"
    end

    test "uses one decimal below 10 and rounds from 10 up" do
      assert Media.format_bytes(1024) == "1.0 KB"
      assert Media.format_bytes(1536) == "1.5 KB"
      assert Media.format_bytes(9.5 * 1024) == "9.5 KB"
      assert Media.format_bytes(10 * 1024) == "10 KB"
      assert Media.format_bytes(20 * 1024) == "20 KB"
    end

    test "scales through KB, MB and GB" do
      assert Media.format_bytes(1024 * 1024) == "1.0 MB"
      assert Media.format_bytes(1024 * 1024 * 1024) == "1.0 GB"
      assert Media.format_bytes(1024 * 1024 * 1024 * 1024) == "1024 GB"
    end

    test "returns ? for invalid values" do
      assert Media.format_bytes(-1) == "?"
      assert Media.format_bytes("12") == "?"
      assert Media.format_bytes(nil) == "?"
    end
  end
end
