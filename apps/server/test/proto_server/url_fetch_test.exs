defmodule ProtoServer.UrlFetchTest do
  use ExUnit.Case, async: true

  alias ProtoServer.UrlFetch

  describe "is_private_address/1" do
    test "rejects private, reserved and link-local IPv4 ranges" do
      for address <- [
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "10.255.255.255",
            "127.0.0.1",
            "127.255.255.255",
            "169.254.1.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "192.0.0.1",
            "192.0.1.1",
            "192.0.2.1",
            "192.0.255.255",
            "198.18.0.1",
            "198.19.255.255",
            "224.0.0.1",
            "239.255.255.255",
            "255.255.255.255"
          ] do
        assert UrlFetch.is_private_address(address), "expected #{address} to be private"
      end
    end

    test "accepts public IPv4 addresses" do
      for address <- [
            "1.1.1.1",
            "8.8.8.8",
            "172.15.255.255",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "198.17.255.255",
            "198.20.0.1",
            "223.255.255.255"
          ] do
        refute UrlFetch.is_private_address(address),
               "expected #{address} to be public"
      end
    end

    test "rejects private and reserved IPv6 ranges" do
      for address <- [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fe90::1",
            "fea0::1",
            "febf::1",
            "2001:db8::1",
            "ff02::1"
          ] do
        assert UrlFetch.is_private_address(address), "expected #{address} to be private"
      end
    end

    test "accepts public IPv6 addresses" do
      for address <- [
            "2001:4860:4860::8888",
            "2606:4700:4700::1111",
            "::2",
            "fec0::1"
          ] do
        refute UrlFetch.is_private_address(address),
               "expected #{address} to be public"
      end
    end

    test "treats unparsable values as private" do
      for address <- ["example.com", "999.1.1.1", "not an ip", ""] do
        assert UrlFetch.is_private_address(address)
      end
    end
  end

  describe "file_name_from_url/2" do
    test "uses the last decoded path segment" do
      assert UrlFetch.file_name_from_url("https://example.com/a/b/photo.png", "image/png") ==
               "photo.png"

      assert UrlFetch.file_name_from_url(
               "https://example.com/My%20File.txt?download=1",
               ""
             ) ==
               "My File.txt"
    end

    test "falls back to the hostname and appends an extension" do
      assert UrlFetch.file_name_from_url("https://example.com/", "video/mp4") ==
               "example.com.mp4"

      assert UrlFetch.file_name_from_url("https://example.com/path", "image/jpeg") ==
               "path.jpg"
    end

    test "sanitizes illegal characters after decoding" do
      assert UrlFetch.file_name_from_url(
               "https://example.com/a%3Ab%3Fc.txt",
               ""
             ) == "a_b_c.txt"

      assert UrlFetch.file_name_from_url("https://example.com/a%2Fb.txt", "") == "a_b.txt"
    end

    test "does not append an extension that is already present" do
      assert UrlFetch.file_name_from_url("https://example.com/clip.MP4", "video/mp4") ==
               "clip.MP4"

      assert UrlFetch.file_name_from_url("https://example.com/clip.verylongext", "image/png") ==
               "clip.verylongext.png"
    end

    test "truncates long names to 80 characters" do
      long = String.duplicate("a", 120) <> ".txt"
      name = UrlFetch.file_name_from_url("https://example.com/" <> long, "")
      assert String.length(name) == 80
    end

    test "uses the hostname with unsafe characters replaced" do
      assert UrlFetch.file_name_from_url("https://exa_mple.com/", "") == "exa_mple.com"
    end
  end

  describe "fetch/1 pre-network validation" do
    test "rejects URLs that are too long" do
      url = "https://example.com/" <> String.duplicate("a", 2_048)

      assert {:error, "URL が長すぎます"} = UrlFetch.fetch(url)
    end

    test "rejects malformed URLs" do
      assert {:error, "URL が正しくありません"} = UrlFetch.fetch("not a url")
      assert {:error, "URL が正しくありません"} = UrlFetch.fetch("example.com/path")
      assert {:error, "URL が正しくありません"} = UrlFetch.fetch("http://")
      assert {:error, "URL が正しくありません"} = UrlFetch.fetch("http://exa mple.com/x")
    end

    test "only allows http and https" do
      assert {:error, "http(s) の URL だけを貼れます"} =
               UrlFetch.fetch("ftp://example.com/file")

      assert {:error, "http(s) の URL だけを貼れます"} =
               UrlFetch.fetch("file:///etc/passwd")
    end

    test "rejects credentials in the URL" do
      assert {:error, "認証情報を含む URL は使えません"} =
               UrlFetch.fetch("http://user:pass@example.com/")

      assert {:error, "認証情報を含む URL は使えません"} =
               UrlFetch.fetch("https://user@example.com/")
    end

    test "rejects local hostnames without resolving them" do
      for host <- ["localhost", "thing.local", "thing.internal", "thing.home.arpa"] do
        assert {:error, "この URL は取得できません"} =
                 UrlFetch.fetch("http://#{host}/x")
      end
    end

    test "rejects private literal addresses without resolving them" do
      for url <- [
            "http://127.0.0.1/x",
            "http://10.0.0.1/x",
            "http://192.168.1.1/x",
            "http://169.254.1.1/x",
            "http://[::1]/x",
            "http://[fe80::1]/x",
            "http://[fd00::1]/x"
          ] do
        assert {:error, "この URL は取得できません"} = UrlFetch.fetch(url)
      end
    end
  end
end
