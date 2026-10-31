import type { SyncDirectoryPage } from "@regenic/connector-contract";
import type { APIChannel, APIThreadList, APIGuildMember, APIRole } from "discord-api-types/v10";
import type { DiscordApi } from "./api";
import { Access, permissions, P, isThread } from "./access";
import { fail, threadId, type Config } from "./model";

export function directory(api: DiscordApi, cfg: Config, signal: AbortSignal) {
  const access = new Access(api, cfg);
  return {
    async listDirectory(cursor: string | null): Promise<SyncDirectoryPage> {
      signal.throwIfAborted();
      const page = cursor === null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(page) || page < 0 || (cursor !== null && String(page) !== cursor)
        || page > cfg.guild_ids.length) return fail("Invalid Discord directory cursor.");
      const members: SyncDirectoryPage["members"] = [];
      const guild = cfg.guild_ids[page];
      if (guild) {
        const me = await access.identity(signal);
        const roles = await api.request<APIRole[]>(`/guilds/${guild}/roles`, signal);
        const member = await api.request<APIGuildMember>(`/guilds/${guild}/members/${me.id}`, signal);
        const channels = await api.request<APIChannel[]>(`/guilds/${guild}/channels`, signal);
        const active = await api.request<APIThreadList>(`/guilds/${guild}/threads/active`, signal);
        const all = new Map([...channels, ...active.threads].map((channel) => [channel.id, channel]));
        // Archived threads are opt-in by ID; directory enumeration never unarchives or joins.
        for (const id of cfg.channel_ids) {
          if (!all.has(id)) {
            const channel = await api.request<APIChannel>(`/channels/${id}`, signal);
            if ("guild_id" in channel && channel.guild_id === guild) all.set(id, channel);
          }
        }
        for (const channel of all.values()) {
          if (![0, 5, 10, 11, 12].includes(channel.type) || !("guild_id" in channel) || channel.guild_id !== guild) continue;
          const parent = isThread(channel) && "parent_id" in channel ? all.get(channel.parent_id ?? "") : channel;
          if (!parent) continue;
          const mask = permissions(guild, me.id, member, roles, "permission_overwrites" in parent ? parent.permission_overwrites ?? [] : []);
          if ((mask & (P.view | P.history)) !== (P.view | P.history)) continue;
          if (channel.type === 12) {
            const membership = active.members.find((item) => item.id === channel.id && (item.user_id === undefined || item.user_id === me.id));
            if (!membership && !cfg.channel_ids.includes(channel.id)) continue;
            if (!membership) await access.channel(channel.id, signal);
          }
          const id = channel.id;
          members.push({
            stream_key: channel.id,
            thread_id: threadId(channel.id),
            label: channel.name ?? id,
            kind: isThread(channel) ? "thread" : "channel",
          });
        }
      } else {
        for (const id of cfg.dm_channel_ids) {
          const channel = await access.channel(id, signal);
          members.push({
            stream_key: id, thread_id: threadId(id), kind: "dm",
            label: "recipients" in channel ? channel.recipients?.[0]?.global_name ?? channel.recipients?.[0]?.username ?? id : id,
          });
        }
      }
      signal.throwIfAborted();
      return { members, complete: page === cfg.guild_ids.length, ...(page < cfg.guild_ids.length ? { next_cursor: String(page + 1) } : {}) };
    },
  };
}
