# Elixir/OTP backend contract

**Status: implemented (space v2).** The Elixir/OTP app in `apps/server` is the
backend for this project, and the Node.js server has been removed. This document
is the authoritative interface contract for that implementation.

## space v2 implementation

- **Store**: `ProtoServer.Space.Store` is a per-session GenServer. It holds
  entities (`id`, `version`, string-keyed `dimensions`), a monotonic version,
  and subscriptions. The default session is `main`. State is in memory.
- **Reader**: `ProtoServer.Space.Reader` is one process per WebSocket. It
  subscribes with a filter, sends `space_welcome` with the initial snapshot,
  and batches `space_delta` at 20 Hz. It owns the per-subscription `seq`.
- **Writer**: `ProtoServer.Space.Writer` is one process per WebSocket. It
  validates capabilities and schema, applies `space_mutate`, delegates content
  creation to `ProtoServer.Place`, and sends `space_ack` / `space_error`.
- **Schema**: `packages/protocol/space-schema.json` is the shared dimension
  schema. `ProtoServer.Space.Schema` embeds the release-local copy
  `apps/server/priv/space-schema.json` at compile time. A test enforces that the
  two files stay identical.
- **Capabilities**: `ProtoServer.Space.Scope` defines read/write dimensions,
  filters, create/delete flags and entity limits. The default member scope is
  not an authentication boundary; it is a structural constraint.
- **Content**: `Place.prepare_create` semantics are implemented through
  `Place.place_image/2`, `place_file/2`, `place_url/2`, `set_avatar/3` and
  `request_file/3`. `Content` reference counting is unchanged.
- **Media**: `ProtoServer.MediaHandler` resolves stored files through
  `Space.Store.find_stored_file/2` for the default session.

Removed: `ProtoServer.Room`, the legacy world protocol, `crdt-v1`, `sync_*`,
`claim` / `claim_release` messages, the Yjs client document and
`packages/world-sync`. A legacy message receives `space_error` with code
`protocol_mismatch`.

## Scope

The OTP backend serves the **space v2 protocol** plus:

- `/media/<cid>` HTTP streaming
- TURN credentials
- URL import (`space_import_url`)
- Kubo-backed content storage and retrieval

**Not implemented in this foundation:** WASM UGC, program Reader/Writer
processes, user-defined projection functions, dynamic space partitioning,
read replicas, persistence, authentication, multiple sessions.

Historical Node reference (the `.ts` sources were removed after parity was
verified; this table records what each Elixir module was ported from):

| Concern | Node reference |
| --- | --- |
| Startup, WS dispatch, TURN, placement | `apps/server/src/index.ts` (removed) |
| Room state / snapshots / objects | `apps/server/src/room.ts` (removed) |
| Message validation | `apps/server/src/validate.ts` (removed) |
| Range parsing and MIME | `apps/server/src/media.ts` (removed) |
| Content limits and reference counting | `apps/server/src/content.ts` (removed) |
| TURN REST credentials | `apps/server/src/turn.ts` (removed) |
| URL import and SSRF protection | `apps/server/src/urlFetch.ts` (removed) |
| Kubo operations | `apps/server/src/ipfs.ts` (removed) |
| Protocol shapes and constants | `packages/protocol/src/index.ts`, `files.ts` |

## Data representation

- **All protocol maps use string keys.** Examples:
  `%{"type" => "join", "name" => "bob"}`,
  `%{"id" => id, "kind" => "box", "position" => [0.0, 0.0, 0.0]}`.
- Internal options and process state may use atom keys
  (`%{max_bytes: 5_242_880}`).
- JSON is encoded/decoded with `Jason`. Never use atom keys for values that
  cross the WebSocket boundary.
- Vectors are lists of numbers. Quaternions are `[x, y, z, w]`.
- `nil` maps to JSON `null`; omitted optional fields must stay omitted (do not
  emit `"pitch" => nil`). Build maps conditionally.
- Sizes are bytes unless a field name says otherwise. Times are milliseconds
  since the Unix epoch unless a field is named `time` (video seconds).

## Networking

### One listener

HTTP and WebSocket share `PORT` (default `8080`) and bind `HOST` (default
`0.0.0.0`). The dispatch is:

```elixir
[
  {:_, [
    {"/media/[...]", ProtoServer.MediaHandler, []},
    {"/[...]", ProtoServer.WsHandler, []}
  ]}
]
```

Any path other than `/media/...` accepts a WebSocket upgrade, preserving the
old server's behavior. `/media/...` is HTTP only.

### WebSocket

- Client-to-server text/binary frame limit: **4096 bytes** (`max_frame_size`).
- Binary frames are ignored.
- Invalid JSON is ignored (optionally counted as activity); it must not crash
  the connection or the server.
- Ping every **30 s**. If no inbound activity is seen for **60 s**, close the
  connection with a normal close code. If Cowboy exposes pong frames, treat
  pongs as activity; otherwise update `last_seen` on every inbound frame.
- Server messages are JSON text frames. A `GenServer`/room may deliver a
  pre-encoded JSON binary to the socket process via
  `send(pid, {:proto_send, json})` or an equivalent internal message.
- The WS process owns the peer id after `join`; messages before `join` other
  than `join` are ignored. A second `join` on the same connection is ignored.

### `/media/<cid>`

`GET` and `HEAD` only; other methods return `405` with `Allow: GET, HEAD`.

Look up a **stored** file object by CID in the room.
If it is missing or has size `<= 0`, return `404` with
`text/plain; charset=utf-8` and body `not found`.

Parse one `Range: bytes=...` header exactly like `media.ts`:

- no header -> `200`, full body
- `bytes=start-end`, `bytes=start-`, `bytes=-suffix` -> `206`
- multiple ranges, malformed values, an empty header value, or an unsatisfiable
  start -> `416` with `Content-Range: bytes */<size>` and no body

Response headers:

```
Content-Type: <MIME by file name/extension>
Accept-Ranges: bytes
Content-Length: <end - start + 1>
Cache-Control: private, max-age=0
Content-Range: bytes <start>-<end>/<size>   # only for 206
```

`HEAD` sends headers and no body. The gateway is probed before headers are
sent; if Kubo is unreachable or rejects the CID, the response is `500` instead
of a truncated `200`. Stream only the requested range from the Kubo gateway; do
not buffer the whole file. Retain the content reference for the duration of the
response and release it in `after`/`terminate`.

## Configuration

`ProtoServer.Config` reads values dynamically:

```elixir
def get(key), do: Application.get_env(:proto_server, key, default(key))
```

`config/runtime.exs` populates them from environment variables. Empty strings
are treated as unset for strings; malformed integers fall back to the default.

| Key | Env var | Default |
| --- | --- | --- |
| `:host` | `HOST` | `"0.0.0.0"` |
| `:port` | `PORT` | `8080` |
| `:ipfs_port` | `IPFS_PORT` | `8081` |
| `:ipfs_public_port` | `IPFS_PUBLIC_PORT` | same as `IPFS_PORT` |
| `:ipfs_api_url` | `IPFS_API_URL` | `"http://127.0.0.1:5001"` |
| `:ipfs_gateway_url` | `IPFS_GATEWAY_URL` | `"http://127.0.0.1:8082"` |
| `:ipfs_peer_id` | `IPFS_PEER_ID` | `nil` |
| `:content_max_total_mb` | `CONTENT_MAX_TOTAL_MB` | `20480` |
| `:turn_host` | `TURN_HOST` | `nil` |
| `:turn_port` | `TURN_PORT` | `3478` |
| `:turn_secret` | `TURN_SECRET` | `nil` |
| `:turn_ttl_seconds` | `TURN_TTL_SECONDS` | `21600` |
| `:max_concurrent_verify` | `MAX_CONCURRENT_VERIFY` | `4` |
| `:max_pending_per_peer` | `MAX_PENDING_PER_PEER` | `16` |

Required accessors:

```elixir
ProtoServer.Config.get(atom) :: term
ProtoServer.Config.port() :: non_neg_integer
ProtoServer.Config.host() :: binary
ProtoServer.Config.ipfs_info() :: %{"peerId" => binary, "wsPort" => non_neg_integer}
```

`ipfs_info/0` prefers `:ipfs_peer_id`; otherwise it uses the peer id cached by
`ProtoServer.Ipfs` through `ProtoServer.Config.put_ipfs_peer_id/1`; if neither
exists it returns `"unavailable"`. `"wsPort"` is always `:ipfs_public_port`.
This fallback is implemented so the server starts without Kubo.

## Module APIs

The following signatures are the contract. All binaries are UTF-8 JSON/string
payloads; all maps crossing the wire have string keys.

```elixir
ProtoServer.Protocol
  parse(binary) :: {:ok, map} | {:unsupported, binary} | :error
  encode(map) :: binary
  sanitize_name(term, binary) :: binary
  sanitize_file_name(term) :: binary
  normalize_cid(term) :: binary | :error

ProtoServer.Media
  parse_range(nil | binary, non_neg_integer) :: :none | {:ok, non_neg_integer, non_neg_integer} | :invalid
  media_type(binary) :: binary
  classify_file(binary, binary) :: "audio" | "video" | "file"
  sniff_image_type(binary) :: :png | :jpeg | :gif | :webp | nil
  image_size(binary) :: {:ok, integer, integer} | :error
  format_bytes(number) :: binary

ProtoServer.Turn
  config() :: nil | %{host: binary, port: integer, secret: binary, ttl_seconds: integer}
  ice_servers(binary) :: nil | [map]

ProtoServer.Space.Store
  create_peer(session_id, ws_pid, name) :: {:ok, peer_id, self, ice_servers}
  subscribe(session_id, reader_pid, filter, requested_id) :: {:ok, sub_id, version, entities}
  unsubscribe(session_id, subscription_id) :: :ok
  query(session_id, filter, limit) :: {:ok, version, entities}
  mutate(session_id, actor, scope, mutation) :: {:ok, version, entity} | {:error, code}
  leave_peer(session_id, peer_id) :: :ok
  find_stored_file(session_id, cid) :: {:ok, map} | :error
  get_object(session_id, id) :: {:ok, map} | :error

ProtoServer.Space.Reader
  start_link(ws_pid:, session_id:, scope:, welcome:) :: GenServer.on_start()
  client(pid, message) :: :ok

ProtoServer.Space.Writer
  start_link(ws_pid:, session_id:, peer_id:, scope:) :: GenServer.on_start()
  client(pid, message) :: :ok
  leave(binary) :: :ok
  ipfs_peer_id(binary) :: binary | nil
  size() :: non_neg_integer

ProtoServer.Content
  known(binary) :: {:ok, %{size: integer, head: binary}} | :error
  limits(:image | :file | :avatar) :: %{max_bytes: integer, too_large_message: binary}
  check(:image | :file | :avatar, integer, binary) :: :ok | {:error, binary}
  reserve(integer) :: {:ok, reference} | {:error, binary}
  unreserve(reference) :: :ok
  acquire(binary, :image | :file | :avatar, integer, binary, reference | nil) ::
    {:ok, %{size: integer, head: binary}} | {:error, binary}
  retain(binary) :: :ok
  release(binary) :: :ok
  total_bytes() :: integer
  count() :: integer
  settle() :: :ok

ProtoServer.Ipfs
  peer_id() :: binary
  available?() :: boolean
  stat(binary) :: {:ok, integer} | {:error, term}
  head(binary, non_neg_integer) :: {:ok, binary, integer} | {:error, term}
  pin(binary) :: :ok | {:error, term}
  unpin(binary) :: :ok | {:error, term}
  has?(binary) :: boolean
  gc() :: :ok | {:error, term}
  add_bytes(binary) :: {:ok, binary, integer} | {:error, term}
  stream_range(binary, non_neg_integer, non_neg_integer, (binary -> :ok | {:error, term})) ::
    :ok | {:error, term}

ProtoServer.Queue
  enqueue(binary, (-> term), map) :: :ok | :full
  cancel_pending(binary) :: :ok

ProtoServer.Place
  place_image(binary, map) :: :ok
  place_file(binary, map) :: :ok
  place_url(binary, map) :: :ok
  set_avatar(binary, binary | nil) :: :ok
  request_file(binary, binary) :: :ok
  cancel_peer(binary) :: :ok
  release_avatars(binary) :: :ok

ProtoServer.UrlFetch
  fetch(binary) :: {:ok, map} | {:error, binary}

ProtoServer.HttpServer   # child spec starting Cowboy
ProtoServer.WsHandler    # :cowboy_websocket
ProtoServer.MediaHandler # :cowboy_handler
```

`ProtoServer.Queue` callbacks are supplied as a map:
`%{on_start: fun, on_cancel: fun, queued: fun, done: fun(term)}`. `enqueue/3`
takes a peer key, a zero-arity job, and that callback map.

`ProtoServer.UrlFetch.fetch/1` returns a string-keyed map:

```elixir
%{
  "kind" => "image" | "video" | "audio" | "link",
  "url" => binary,
  "name" => binary,
  "contentType" => binary,
  "size" => integer,
  "bytes" => binary,        # present for image/video/audio
  "width" => number,        # present for image
  "height" => number        # present for image
}
```

Error strings are user-facing Japanese messages matching the Node behavior.

## Room behavior to preserve

- Peer id is a lowercase UUID v4 (`ProtoServer.Uuid.v4/0`). Name is sanitized
  to at most 24 characters; when empty use `"Guest-" <> first four chars of id`.
- Fixed 10-color palette, round-robin in join order:
  `#e6194b #3cb44b #ffe119 #4363d8 #f58231 #911eb4 #46f0f0 #f032e6 #bcf60c #fabebe`.
- Initial pose: position `[0,0,0]`, head `[0,0,0,1]`.
- `welcome` contains `self`, `peers` (existing peers only), `objects` (all
  objects), `videos` (object id -> state), `ipfs` info, `iceServers` only when
  TURN is configured, and `tickRate: 20`. No `sync` field.
- After welcome, broadcast `peer_joined` to everyone else.
- 20 Hz `snapshot` with `time` (epoch ms) and `poses` (peer id -> pose). Start
  the timer on the first join; stop it when the room becomes empty.
- Seed exactly five demo boxes at application startup:

  | position | yaw | size | color |
  | --- | --- | --- | --- |
  | `[0,0,0]` | 0 | 1 | `#d9534f` |
  | `[6,0,-4]` | 0 | 2 | `#5bc0de` |
  | `[-7,0,-6]` | 0 | 1.5 | `#5cb85c` |
  | `[10,0,8]` | 0 | 1 | `#f0ad4e` |
  | `[-10,0,7]` | 0 | 3 | `#9b59b6` |

- Maximum 100 objects. `add_*` returns `:full` instead of exceeding it.
- Grab exclusivity: if held by another peer, do not grab. Send that peer
  `error` (`"他の人がつかんでいます"`) and an `object_updated` with the current
  object so the optimistic client can roll back. A peer can hold only one
  object; grabbing another releases the previous held object (broadcast
  `object_updated` for it). Grab broadcasts `object_updated`.
- Only the holder may `move_object`; broadcast `object_updated` to everyone
  except the mover. `pitch`/`scale` are removed from the object when `nil`.
- `release_object` only works for the holder; broadcast `object_updated`.
- `delete_object`: missing -> `{:error, :not_found}` (Node returns null and
  sends no error). Held by another -> send `error` and return
  `{:error, :held}`. Otherwise remove, delete its video state, broadcast
  `object_removed`. A denial due to permission is `:forbidden` where the API
  distinguishes it; `:held` is used for the grab case.
- `duplicate_object`: missing -> `{:error, :not_found}`. Full -> send `error`
  (`"これ以上オブジェクトを置けません"`) and return `{:error, :full}`. Copy
  keeps content, orientation and scale, gets a new UUID, and clears `heldBy`.
  Offsets (`scale` defaults to 1, `yaw` is the source yaw):
  - box side: `size * scale + 0.2`
  - image side: `0.6 * scale`
  - link side: `0.6 * scale`
  - file side: `(0.9 + 0.15) * scale` (`FILE_ICON_WIDTH + 0.15`)
  - normal offset: `0.05`

  ```text
  x' = x + cos(yaw) * side + sin(yaw) * 0.05
  z' = z - sin(yaw) * side + cos(yaw) * 0.05
  y' = y
  ```

  Broadcast `object_added`.
- `set_video_state` only applies to stored objects with `kind == "file"` and
  `category == "video"`. Clamp `time` to `0..86400`, set `at` to server epoch
  ms, store it, and broadcast `video_state`.
- `leave`: remove the peer, broadcast `peer_left`, release all objects held by
  the peer (`object_updated`), mark that peer's unstored, owner-owned files
  `offline: true` (`object_updated`), and stop the snapshot timer if empty.
- `mark_stored(cid, size)`: for every file with that CID that is not stored,
  set `stored: true`, `size` to the measured value, remove `owner` and
  `offline`, broadcast `object_updated`, and return the updated objects.
- `remove_unstored(cid)`: remove non-stored, non-offline files with that CID,
  remove their video states, broadcast `object_removed`, and return the count.
  Offline objects are kept.
- `find_stored_file/1` and `find_unstored_file/1` return the first matching
  file object or `:error`. `get_object/1` returns any kind.
- `send_*_progress` and `send_prepare_failed` are addressed to the requesting
  peer only. Omit `"total"` and `"queued"` when `nil`/`false`.
- `announce_ipfs` records the peer's libp2p peer id and broadcasts
  `peer_ipfs` to everyone except that peer.
- `set_avatar` deletes `avatarCid` when `nil`; broadcasts `peer_avatar` to
  everyone except the peer.
- `send_error` sends `%{"type" => "error", "message" => message}` to one peer
  without closing the connection.

## Content and placement limits

Constants from `packages/protocol`:

| Constant | Value |
| --- | --- |
| `MAX_IMAGE_BYTES` | 5 MiB |
| `MAX_FILE_BYTES` | 2 GiB |
| `MAX_AVATAR_BYTES` | 64 MiB |
| `EAGER_FILE_MAX_BYTES` | 16 MiB |
| `MAX_OBJECTS` | 100 |
| `MAX_MESSAGE_BYTES` | 4096 |
| `MAX_NAME_LENGTH` | 24 |
| `MAX_FILE_NAME_LENGTH` | 120 |
| `MAX_URL_LENGTH` | 2048 |
| `MAX_ABS_POSITION` | 1000 |
| `MIN_OBJECT_SIZE` / `MAX_OBJECT_SIZE` | 0.1 / 20 m |
| `MIN_OBJECT_SCALE` / `MAX_OBJECT_SCALE` | 0.1 / 10 |

- Images must sniff as PNG/JPEG/GIF/WebP. The client-declared content type is
  not trusted. SVG is rejected.
- Files keep `stored: false` and `owner: peer_id` while the server downloads
  them; files at or below `EAGER_FILE_MAX_BYTES` may be fetched before
  placement, larger files are placed immediately and staged in the background.
- `Place` fetches, measures and pins before calling `Content.acquire/5`.
  `acquire/5` verifies the measured size and image magic, consumes any
  reservation, and records/reference-counts the CID; it does not perform network
  I/O or pinning. `retain/1` increments the reference count; `release/1`
  decrements it and unpins/GCs at zero. `reserve/1` + `unreserve/1` cover
  capacity booked before the measured size is known. `settle/0` flushes pending
  GC (tests/shutdown).
- Server total content is capped by `CONTENT_MAX_TOTAL_MB` (default 20 GiB).
- Avatars are pinned only while the peer is in the room; leaving releases the
  avatar references (`Place.release_avatars/1`).

## URL import

Port `urlFetch.ts` semantics:

- Only `http`/`https`; reject credentials in the URL, `localhost`, `.local`,
  `.internal`, `.home.arpa`, private/reserved IPv4 and IPv6, link-local,
  CGNAT, multicast and documentation ranges.
- Resolve DNS and reject if **any** resolved address is private. Follow at most
  three redirects manually, validating every hop.
- Timeout: 120 s total. Image limit 5 MiB; audio/video limit 128 MiB. Other
  content becomes a `link` without reading the body.
- Detect media from `Content-Type` or a known extension. Images must sniff and
  have readable dimensions; fit the long edge to 2.5 m (minimum side 0.1 m).
  Images that fail sniffing/dimensions become links.
- `name` comes from the final URL path, sanitized, with an extension added
  from the content type when missing.

## IPFS / Kubo

The server no longer embeds Helia/libp2p. Kubo owns the libp2p node, block
store, pinning and gateway; the OTP app talks HTTP to it.

Defaults:

- Kubo API: `http://127.0.0.1:5001`
- Kubo gateway: `http://127.0.0.1:8082`
- libp2p WebSocket swarm listener: `0.0.0.0:8081`
- Public advertised WS port: `IPFS_PUBLIC_PORT` (default 8081; `8443` behind
  Caddy in production)

Kubo must be configured with:

- a WebSocket swarm listener (`/ip4/0.0.0.0/tcp/8081/ws`)
- `Swarm.RelayService.Enabled = true`
- `Swarm.RelayClient.Enabled = true`
- Bitswap enabled (default)
- the gateway listening on `8082` and the API on `5001`

The server advertises the Kubo peer id and `IPFS_PUBLIC_PORT` in `welcome`
(`ipfs`). At startup, if `IPFS_PEER_ID` is unset, query `POST /api/v0/id` and
cache the result with `ProtoServer.Config.put_ipfs_peer_id/1`. If Kubo is
unavailable, log a warning and keep `"unavailable"`; the server still starts so
WebSocket-only tests can run. Do not crash the supervision tree on Kubo
absence.

Content operations map to Kubo:

| API | Kubo operation |
| --- | --- |
| `stat(cid)` | `/api/v0/files/stat` or gateway `HEAD` / `Content-Length` |
| `head(cid, n)` | gateway range request `bytes=0-(n-1)` |
| `pin` / `unpin` | `/api/v0/pin/add`, `/api/v0/pin/rm` |
| `has?` | `/api/v0/block/stat` or pin/gateway probe |
| `gc` | `/api/v0/repo/gc` |
| `add_bytes` | `/api/v0/add` (returns CID and size) |
| `stream_range` | gateway `GET` with `Range: bytes=start-end` |

The browser uploads to Kubo directly (or through the server's Kubo API in
development); the OTP server fetches, verifies, pins and serves content.
Media streaming goes through the gateway so that a range request does not
download the whole file. Kubo's HTTP client should use `ProtoServer.Finch`.
Legacy content is not persisted across server restarts (the world state is
in-memory); do not add a content ledger.

## Supervision tree

```text
ProtoServer.Supervisor (one_for_one)
  Finch (ProtoServer.Finch)
  Task.Supervisor (ProtoServer.TaskSupervisor)
  Registry (ProtoServer.Space.Registry)
  ProtoServer.Ipfs
  ProtoServer.Content
  ProtoServer.Space.Store (session_id: "main")
  ProtoServer.Queue
  ProtoServer.Place
  ProtoServer.HttpServer
```

Finch starts before Ipfs; `ProtoServer.HttpServer` always starts last. Reader and
Writer processes are started per WebSocket by `ProtoServer.WsHandler` and are
linked to the connection. There is no separate supervisor module.

`ProtoServer.HttpServer` starts the single Cowboy listener `:proto_http` with
`num_acceptors: 100`, `max_connections: 1000` and `idle_timeout: 60_000`.
The Space store, Content, Place, Queue and Ipfs processes are registered (named)
because the handlers call them directly. `ProtoServer.Ipfs` and
`ProtoServer.Content` may use `Task.Supervisor` for fetch jobs.

## Implementation notes

- Resolved dependencies: Cowboy 2.20.0, cowlib 2.21.0, Ranch 2.3.0, Finch
  0.24.0, Jason 1.4.5 (see `apps/server/mix.lock`). Hex reports
  `EEF-CVE-2026-43966` against cowlib 2.21.0 with no newer release available;
  do not reflect client-controlled strings into response headers, and re-check
  the advisory when upgrading.
- `Protocol`, `Media` (pure functions), `Turn`, `UrlFetch`, `Space.Store`,
  `Space.Reader` / `Space.Writer` and the `WsHandler` dispatch are implemented.
  The 4096-byte frame limit, heartbeat and `/media` routing are preserved.
  Legacy messages receive `space_error` with code `protocol_mismatch`.
- `Ipfs`, `Content`, `Queue`, `Place`, `MediaHandler` streaming and the seeded
  demo boxes are implemented and started before `HttpServer` in the
  supervision tree.
- Queue concurrency and pending limits come from `MAX_CONCURRENT_VERIFY`
  (default 4) and `MAX_PENDING_PER_PEER` (default 16). The queued-job
  heartbeat defaults to 10 seconds and can be overridden for tests with
  `Application.put_env(:proto_server, :queue_heartbeat_ms, ms)`.
- The Node `.ts` sources and TypeScript tests were removed after parity
  verification; `apps/server/src` no longer exists.
- `apps/server/package.json` invokes Mix so pnpm workspace scripts keep
  working (`pnpm --filter @proto/server dev|build|test`). Node dependencies
  for the old server are intentionally gone from that manifest.
