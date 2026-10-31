# Discord Bot connector for Regenic

[简体中文](README.zh-CN.md)

A local-first external connector for selected Discord server text channels, existing
threads and manually added existing user-initiated bot DMs. It runs as an official
Bot, polls Discord REST API v10, and sends text as that Bot. It is not a personal
account inbox. No Gateway connection, relay, telemetry or background service is
started by this package.

## Requirements

- Node.js **22.12 or newer**, npm, and a Regenic host supporting connector protocol
  `1.0` and the installation start/stop hooks in `@regenic/connector-contract@0.2.0`.
- A Discord application with an official Bot token and permission to access the
  conversations you select.
- A working OS credential store: macOS Keychain, Windows Credential Manager, or
  an unlocked Linux Secret Service session. Linux is explicitly pinned to Secret
  Service rather than a volatile kernel-keyring fallback. Unsupported/locked
  stores fail explicitly; there is no plaintext token fallback.

## Setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application, open **Bot**, and obtain its Bot token. Keep it private.
   For server history enable **Message Content Intent**; verified applications
   need Discord approval when required. REST access is also affected by this
   privileged intent. Members and Presence intents are not needed.
2. On **OAuth2 / URL Generator**, select the **bot** scope. Invite the Bot to
   servers you administer or where you have permission to install it. Grant only
   **View Channel**, **Read Message History**, **Send Messages**, and, for thread
   replies, **Send Messages in Threads**, restricted to intended channels. Do not
   grant Administrator or Manage Threads. The Bot must already be a member of
   private threads, and of any thread it will send to.
3. Enable Discord **Developer Mode** and copy the server/channel/thread IDs.
   For a DM, the human must first message this Bot in Discord; copy that existing
   one-to-one **channel ID**, not a user ID. The connector does not list or create
   DMs. Group DMs and DMs to other bots are rejected.

## Build and load

```sh
npm ci
npm run build
```

Set `REGENIC_CHANNEL_PLUGIN` to the **absolute path of this built package
directory** in the Regenic host's environment, then start/restart the host.
This path is supplied by the operator; no other checkout or monorepo is required.
The package has a synchronous CommonJS entry and declares
`regenic.contributes.drivers: ["discordDriver"]`.

Alternatively, make a local tarball with `npm pack`, extract its `package/`
contents into a child directory of `~/.regenic/plugins` (or
`REGENIC_PLUGIN_DIR`), and run `npm install --omit=dev` inside that extracted
directory. Its own `package.json` must be directly in that child directory, not
only nested under `node_modules`. Use the host's authenticated
`POST /v1/me/plugins/reload` or restart the host for discovery. A driver already
loaded in a running host is not hot-replaced; restart after code updates.

In **Engine**, add **Discord Bot**. Installation fields contain only IDs:

| Field | Meaning |
|---|---|
| `guild_ids` | Servers whose accessible text channels and active threads may appear in the directory. |
| `channel_ids` | Explicit allowlist of text channel / existing thread IDs to sync and send to. Their servers must be in `guild_ids`. |
| `dm_channel_ids` | Explicit existing user-initiated one-to-one DM channel IDs. |

Fields accept comma-separated decimal strings (or arrays when using the host
API). Never convert IDs to JavaScript numbers. An empty selection collects no
messages. The directory is metadata, not permission to collect: a directory item
must also be in the installation's explicit channel/DM allowlist before opening
or syncing it. Edit the installation to add an ID, then select/open that
conversation in Engine. Merely loading the package/catalog does not install or
connect the Bot.

After creating the installation, copy its installation ID and run:

```sh
node dist/cli.js token set INSTALLATION_ID
# With the package's bin installed, the equivalent is:
regenic-discord token set INSTALLATION_ID
```

Enter the token at the **hidden interactive prompt**. It is not accepted in
arguments, environment variables, ordinary installation config, stdin pipes or
logs. The entry uses service `regenic-discord`, account
`INSTALLATION_ID:bot_token`. It is read only for explicit runtime operations.
The connector deliberately does not rely on a host secret backend whose storage
guarantees may differ between platforms.

The install card/probe performs no network requests and makes no claim that a
credential is valid. Server, channel, thread and DM IDs are entered manually;
the connector does not use a user-account endpoint to enumerate guilds.

To rotate credentials, disable the installation, run `token set` again, then
re-enable. `regenic-discord token remove INSTALLATION_ID` removes the local entry;
it does not revoke the remote token. Stop/disable the installation before removal.

## Sync, sending and storage

- **Polling:** the host schedules selected streams, with a suggested 15-second
  idle pace. Each text page contains at most 100 messages. First open seeds a
  recent page; older history uses `before`. Incremental sync uses `after`; if a
  page is full, it freezes a recent ceiling and walks backwards before advancing
  the live checkpoint. Large bursts therefore do not skip messages based on an
  assumed `after` ordering. History and live positions are independent.
- **Durability:** the opaque cursor returned by each poll belongs to the host;
  persist it only with successful ingestion. Restart resumes from that cursor.
  Source IDs are `channel_id:message_id`, using strings/BigInt. Replaying a page
  uses stable record identities for host deduplication. No private message inbox
  or message-body cache is written by the connector; ingested text lives in the
  host's normal local storage.
- **Directory:** one configured server per page, followed by an explicit-DM page.
  It lists readable text/announcement channels and active accessible threads.
  Known archived threads can be added manually by ID; there is no exhaustive
  archive crawl. No history is read while enumerating it.
- **Permissions/content:** effective role and channel overwrites are checked
  before history, including View Channel and Read Message History. Private
  threads require existing membership. Server polling verifies application
  Message Content flags before reading. An empty ordinary payload with no
  visible content is reported as unavailable without advancing the cursor, not
  automatically blamed on an intent. Attachment/embed/sticker/interactive-only
  and system messages get explicit text placeholders and a Discord link.
- **Sending:** only nonempty `text/plain` body parts, up to 2,000 UTF-16 code
  units in one message; no splitting or media upload. A programmatic
  `SendIntent.target.external_id = "channel_id:message_id"` produces a native
  same-channel reply. Whether Engine supplies that reference depends on the
  host UI; text quotations remain text. All sends explicitly disable everyone,
  here, role and user mention parsing, including automatic reply pings.
  Channel sends require Send Messages; thread sends require Send Messages in
  Threads and pre-existing Bot membership. Archived/locked threads are read-only
  here: sending never implicitly joins or unarchives them.
- **Delivery safety:** every send requires a stable `idempotency_key`. A durable
  reservation is flushed **before** the POST. A key-derived 25-character nonce
  and `enforce_nonce: true` also use Discord's deduplication for the **past few
  minutes only**. Local accepted receipts can be replayed across restart without
  another POST. Network failures, timeouts, malformed success responses and
  ambiguous server errors leave the operation **unknown**; the same operation
  is never automatically resent, even after Discord's nonce window expires.
  Inspect Discord before explicitly creating a different send operation.
  Definitively rejected sends are terminal for that key; fix the cause and
  create a new operation. This is not a permanent exactly-once guarantee.
- **Outbox:** safety metadata (hashed operation/content identities, nonce,
  acceptance state and remote message ID, but no text or token) is retained under
  `~/.regenic/connectors/discord/outbox/<hashed-installation>/`. Files are flushed
  and atomically replaced, with directories `0700` and files `0600` on POSIX.
  Windows uses the user-profile filesystem's ACLs; file data is flushed, but
  directory fsync is unavailable there. Back up the host's cursors and this
  metadata together. Removing it discards retry protection. It is retained
  across disable/delete/reconfigure/clear/shutdown and is not automatically
  pruned; inspect and remove only deliberately after reconciling sends.
- **Lifecycle/rate limits:** stop hooks cancel local in-flight requests, drain
  admitted work, dispose registries and fence stale references. They do not
  log out, revoke tokens or delete remote data. A failed/incomplete stop cannot
  be bypassed by restart. Requests have a ten-second deadline (including local
  queuing), honor caller cancellation, serialize per client and observe learned
  bucket/global cooldown headers and `Retry-After`. A 429 is explicit
  backpressure; no HTTP request, especially a message POST, is silently retried.

## Limits and verification

There is no full personal DM inbox, DM discovery, new conversation/thread
creation, automatic join, edit/delete tracking, reactions, read receipts, member
sync, media download/upload or Gateway real-time delivery. Deleted messages
cannot be recovered; later edits to already ingested messages are not refreshed.
Discord availability, permissions, policy and rate limits still apply; using a
Bot does not make an application risk-free.

```sh
npm run typecheck
npm test
npm pack --dry-run --json
```

The offline suite exercises the **published** contract conformance helpers and
plugin host, manifest-driven synchronous package loading, source identity,
permissions/directory pagination, history/live pagination in both possible
`after` page orders, restart/cursor replay, DM validation, native references,
mentions/nonce/unknown delivery, outbox persistence and lifecycle
fencing/cancellation/deadlines. HTTP fixtures never access Discord or an OS
credential entry. No real Discord account, Bot login, message history read,
message send or Gateway connection has been tested. OS credential interaction
and deployment on each target platform still require an operator-authorized
check.

API references:
[messages and nonce](https://discord.com/developers/docs/resources/message),
[channels and threads](https://discord.com/developers/docs/resources/channel),
[permissions](https://discord.com/developers/docs/topics/permissions),
[Message Content](https://discord.com/developers/docs/events/gateway#message-content-intent),
[rate limits](https://discord.com/developers/docs/topics/rate-limits).

License: [MIT](LICENSE). Dependency notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
