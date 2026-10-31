import { createHash } from "node:crypto";
import {
  ChannelDriverError, channelRecord,
  type ChannelConnector, type ConnectorInstallation, type ConnectorCursor, type ConnectorPollOptions,
  type IngestRecord, type PollResult,
} from "@regenic/connector-contract";
import type { APIMessage } from "discord-api-types/v10";
import type { DiscordApi } from "./api";
import { Access } from "./access";
import { compare, externalId, fail, PAGE_SIZE, snowflake, SOURCE, type Config } from "./model";

interface Cursor {
  v: 1;
  channel: string;
  live?: string;
  history?: string;
  history_done: boolean;
  scan?: { ceiling: string; before: string };
}

function decode(cursor: ConnectorCursor | null, channel: string): Cursor {
  if (!cursor) return { v: 1, channel, history_done: false };
  try {
    if (cursor.value.length > 2000) throw new Error();
    const parsed: unknown = JSON.parse(cursor.value);
    if (!parsed || typeof parsed !== "object") throw new Error();
    const value = parsed as Partial<Cursor>;
    if (value.v !== 1 || value.channel !== channel || typeof value.history_done !== "boolean"
      || (value.live !== undefined && !snowflake(value.live))
      || (value.history !== undefined && !snowflake(value.history))
      || (value.scan !== undefined && (!value.live || !snowflake(value.scan.ceiling) || !snowflake(value.scan.before)
        || compare(value.scan.ceiling, value.live) <= 0 || compare(value.scan.before, value.scan.ceiling) > 0
        || compare(value.scan.before, value.live) <= 0))) throw new Error();
    return {
      v: 1, channel, history_done: value.history_done,
      ...(value.live ? { live: value.live } : {}), ...(value.history ? { history: value.history } : {}),
      ...(value.scan ? { scan: { ...value.scan } } : {}),
    };
  } catch {
    return fail("Invalid or incompatible Discord message cursor.");
  }
}

function messageRecord(message: APIMessage, channel: string, me: string, guild: string | undefined, label: string, kind: string): IngestRecord {
  if (!snowflake(message.id) || message.channel_id !== channel || !snowflake(message.author?.id)
    || !Number.isFinite(Date.parse(message.timestamp)) || typeof message.content !== "string"
    || !Array.isArray(message.attachments) || !Array.isArray(message.embeds)) {
    throw new ChannelDriverError("sync_failed", "Discord returned an invalid message; cursor was not advanced.");
  }
  const nonText = message.attachments.length > 0 || message.embeds.length > 0
    || (message.sticker_items?.length ?? 0) > 0 || (message.components?.length ?? 0) > 0
    || (message.message_snapshots?.length ?? 0) > 0 || !!message.poll;
  // Empty standard messages with no visible payload are not evidence of a particular intent failure.
  if ((message.type === 0 || message.type === 19) && !message.content && !nonText) {
    throw new ChannelDriverError("sync_failed", "Message payload is unavailable. Check Message Content access or inspect this message in Discord; cursor was not advanced.", "content_unavailable");
  }
  const text = message.content || (nonText
    ? "[Discord non-text message; view attachments, embeds, stickers or interactive content in Discord.]"
    : `[Discord system message type ${message.type}; view in Discord.]`);
  const reference = message.message_reference;
  const reply = reference?.type !== 1 && (!reference?.channel_id || reference.channel_id === channel) ? reference?.message_id : undefined;
  if (reply && !snowflake(reply)) throw new ChannelDriverError("sync_failed", "Discord returned an invalid reply reference.");
  return {
    ...channelRecord({
      channel: SOURCE, kind: message.author.id === me ? "assistant" : "user",
      direction: message.author.id === me ? "outbound" : "inbound",
      external_id: externalId(channel, message.id), occurred_at: message.timestamp,
      actor_id: message.author.id, actor_label: message.author.global_name ?? message.author.username,
      scope_id: channel, scope_name: label, thread_id: channel, conversation_kind: kind, thread_facet: "chat",
      type: reply ? "thread_reply" : "message", parent_external_id: reply ? externalId(channel, reply) : undefined, text,
    }),
    attrs: {
      discord_type: message.type,
      non_text: nonText,
      attachment_count: message.attachments.length,
      url: `https://discord.com/channels/${guild ?? "@me"}/${channel}/${message.id}`,
    },
  };
}

export function pollConnector(
  api: DiscordApi, installation: ConnectorInstallation, cfg: Config, channel: string,
  lifetime: AbortSignal, now: () => string,
): ChannelConnector & { poll: NonNullable<ChannelConnector["poll"]> } {
  const access = new Access(api, cfg);
  return {
    source: SOURCE, source_mode: "poll",
    async poll(input: ConnectorCursor | null, options: ConnectorPollOptions = {}): Promise<PollResult> {
      const signal = AbortSignal.any([lifetime, ...(options.signal ? [options.signal] : [])]);
      signal.throwIfAborted();
      const cursor = decode(input, channel);
      if (options.media === true) return finish([], cursor, false);
      if (options.older && options.latest) return fail("older and latest cannot be combined.");
      const info = await access.channel(channel, signal);
      if (info.type !== 1) await access.requireContentIntent(signal);
      const me = await access.identity(signal);
      const fetchPage = async (query = ""): Promise<APIMessage[]> => {
        const messages = await api.request<APIMessage[]>(`/channels/${channel}/messages?limit=${PAGE_SIZE}${query}`, signal);
        if (!Array.isArray(messages) || messages.length > PAGE_SIZE
          || messages.some((m) => !snowflake(m.id) || m.channel_id !== channel)
          || new Set(messages.map((m) => m.id)).size !== messages.length) {
          throw new ChannelDriverError("sync_failed", "Invalid Discord message page; cursor was not advanced.");
        }
        return [...messages].sort((a, b) => compare(a.id, b.id));
      };
      let messages: APIMessage[];
      let more = false;
      if (options.latest && cursor.live) {
        // Hydrate the visible recent page without skipping any unconsumed live scan.
        messages = await fetchPage();
      } else if (options.older) {
        let boundary = cursor.history;
        if (options.before_external_id) {
          const parts = options.before_external_id.split(":");
          if (parts.length !== 2 || parts[0] !== channel || !snowflake(parts[1])) return fail("History boundary must be a message in this channel.");
          boundary = parts[1];
        } else if (options.before) {
          const timestamp = Date.parse(options.before);
          if (!Number.isSafeInteger(timestamp) || timestamp <= 1420070400000) return fail("Invalid Discord history timestamp.");
          boundary = String(BigInt(timestamp - 1420070400000) << 22n);
          if (!snowflake(boundary)) return fail("Discord history timestamp is outside the snowflake range.");
        }
        messages = await fetchPage(boundary ? `&before=${boundary}` : "");
        if (boundary && messages.some((m) => compare(m.id, boundary) >= 0)) throw new ChannelDriverError("sync_failed", "Discord returned messages outside the history boundary.");
        const low = messages[0]?.id;
        if (low && (!cursor.history || compare(low, cursor.history) < 0)) cursor.history = low;
        more = messages.length === PAGE_SIZE;
        cursor.history_done = !more;
      } else if (!cursor.live) {
        messages = await fetchPage();
        cursor.live = messages.at(-1)?.id;
        cursor.history = messages[0]?.id;
        cursor.history_done = messages.length < PAGE_SIZE;
      } else if (cursor.scan) {
        const scan = cursor.scan;
        messages = await fetchPage(`&before=${scan.before}`);
        if (messages.some((m) => compare(m.id, scan.before) >= 0)) throw new ChannelDriverError("sync_failed", "Discord returned a non-advancing message page.");
        const reached = messages.length < PAGE_SIZE || !!messages[0] && compare(messages[0].id, cursor.live) <= 0;
        if (reached) {
          const floor = cursor.live;
          cursor.live = scan.ceiling;
          delete cursor.scan;
          messages = messages.filter((m) => compare(m.id, floor) > 0);
        } else {
          scan.before = messages[0]!.id;
          messages = messages.filter((m) => compare(m.id, cursor.live!) > 0);
          more = true;
        }
      } else {
        messages = await fetchPage(`&after=${cursor.live}`);
        if (messages.some((m) => compare(m.id, cursor.live!) <= 0)) throw new ChannelDriverError("sync_failed", "Discord returned messages outside the live boundary.");
        if (messages.length === PAGE_SIZE) {
          // A full `after` page alone cannot establish that the newest message was reached.
          // Freeze a latest-page ceiling, then walk backwards without advancing the live floor.
          messages = await fetchPage();
          const floor = cursor.live;
          const ceiling = messages.at(-1)?.id;
          const low = messages[0]?.id;
          if (ceiling && low && compare(ceiling, floor) > 0) {
            if (messages.length < PAGE_SIZE || compare(low, floor) <= 0) cursor.live = ceiling;
            else {
              cursor.scan = { ceiling, before: low };
              more = true;
            }
          }
          messages = messages.filter((m) => compare(m.id, floor) > 0);
        } else if (messages.length) {
          cursor.live = messages.at(-1)!.id;
        }
      }
      const guild = "guild_id" in info ? info.guild_id : undefined;
      const label = info.type === 1 ? info.recipients?.[0]?.global_name ?? info.recipients?.[0]?.username ?? channel
        : "name" in info ? info.name ?? channel : channel;
      const kind = info.type === 1 ? "dm" : [10, 11, 12].includes(info.type) ? "thread" : "channel";
      const records = messages.map((message) => messageRecord(message, channel, me.id, guild, label, kind));
      signal.throwIfAborted();
      return finish(records, cursor, more);

      function finish(records: IngestRecord[], next: Cursor, hasMore: boolean): PollResult {
        const value = JSON.stringify(next);
        const digest = createHash("sha256").update(JSON.stringify([installation.id, channel, input?.value, options.older ?? false, records, value])).digest("hex");
        return {
          batch: {
            schema_version: "1.0", connector_id: installation.id, org_id: installation.org_id,
            delivery_id: `${channel}:${digest}`, records, next_cursor: value, received_at: now(),
          },
          next_cursor: value, has_more: hasMore,
          poll_hint: { live_seeded: !!next.live, history_pending: !next.history_done },
        };
      }
    },
  };
}
