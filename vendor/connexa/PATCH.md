# Local patch

`connexa` 0.5.3 builds the WebSocket transport on a plain
`TokioTcpTransport`. The WebSocket layer parses `/dns/.../tcp/.../tls/ws`
and keeps the hostname for TLS SNI, but then hands the `/dns` TCP address to
an inner transport that cannot resolve it, so secure libp2p WebSocket dials
fail.

This copy wraps that inner TCP transport with `libp2p::dns` when `enable_dns`
is set. The WebSocket layer still sees the original `/dns` address and uses
its hostname for SNI, while the inner TCP transport resolves it.

Remove this patch when a released `connexa` version (or the `rust-ipfs`
dependency graph) preserves DNS resolution for secure WebSocket dials.
