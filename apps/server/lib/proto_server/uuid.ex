defmodule ProtoServer.Uuid do
  @moduledoc false

  import Bitwise

  @doc "Returns a random RFC 4122 version 4 UUID in lowercase 8-4-4-4-12 form."
  @spec v4() :: binary()
  def v4 do
    <<a::32, b::16, c::16, d::16, e::48>> = :crypto.strong_rand_bytes(16)
    c = bor(band(c, 0x0FFF), 0x4000)
    d = bor(band(d, 0x3FFF), 0x8000)

    hex =
      Base.encode16(<<a::32, b::16, c::16, d::16, e::48>>, case: :lower)

    <<p1::binary-size(8), p2::binary-size(4), p3::binary-size(4), p4::binary-size(4),
      p5::binary-size(12)>> = hex

    Enum.join([p1, p2, p3, p4, p5], "-")
  end
end
