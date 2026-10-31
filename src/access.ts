import { ChannelDriverError } from "@regenic/connector-contract";
import type {
  APIApplication, APIChannel, APIGuildMember, APIRole, APIThreadMember, APIUser,
  APIOverwrite,
} from "discord-api-types/v10";
import type { DiscordApi } from "./api";
import type { Config } from "./model";
import { snowflake } from "./model";

export const P = {
  admin: 1n << 3n,
  view: 1n << 10n,
  send: 1n << 11n,
  history: 1n << 16n,
  threadSend: 1n << 38n,
};
export const isThread = (channel: APIChannel): boolean => [10, 11, 12].includes(channel.type);

export function permissions(
  guild: string, user: string, member: APIGuildMember, roles: APIRole[], overwrites: APIOverwrite[],
): bigint {
  if (!roles.some((role) => role.id === guild)) {
    throw new ChannelDriverError("sync_failed", "Discord did not return the guild base role.");
  }
  let value = roles.filter((role) => role.id === guild || member.roles.includes(role.id))
    .reduce((mask, role) => mask | BigInt(role.permissions), 0n);
  if (value & P.admin) return (1n << 64n) - 1n;
  const everyone = overwrites.find((item) => item.type === 0 && item.id === guild);
  if (everyone) value = (value & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  const roleOverwrites = overwrites.filter((item) => item.type === 0 && member.roles.includes(item.id));
  const deny = roleOverwrites.reduce((mask, item) => mask | BigInt(item.deny), 0n);
  const allow = roleOverwrites.reduce((mask, item) => mask | BigInt(item.allow), 0n);
  value = (value & ~deny) | allow;
  const personal = overwrites.find((item) => item.type === 1 && item.id === user);
  if (personal) value = (value & ~BigInt(personal.deny)) | BigInt(personal.allow);
  return value;
}

export class Access {
  constructor(private readonly api: DiscordApi, private readonly cfg: Config) {}

  async identity(signal?: AbortSignal): Promise<APIUser> {
    const me = await this.api.request<APIUser>("/users/@me", signal);
    if (!me.bot || !snowflake(me.id)) {
      throw new ChannelDriverError("missing_credentials", "This connector requires an official Discord bot identity.");
    }
    return me;
  }

  async requireContentIntent(signal?: AbortSignal): Promise<void> {
    const app = await this.api.request<APIApplication>("/applications/@me", signal);
    if (typeof app.flags !== "number" || !(app.flags & (262144 | 524288))) {
      throw new ChannelDriverError("sync_failed", "Enable the Message Content privileged intent in the Developer Portal (and obtain approval when required) before syncing guild messages.", "message_content_intent");
    }
  }

  async channel(id: string, signal?: AbortSignal, write = false): Promise<APIChannel> {
    const me = await this.identity(signal);
    const channel = await this.api.request<APIChannel>(`/channels/${id}`, signal);
    if (channel.id !== id) {
      throw new ChannelDriverError("sync_failed", "Discord returned the wrong channel.");
    }
    if (this.cfg.dm_channel_ids.includes(id)) {
      if (channel.type !== 1 || !("recipients" in channel) || channel.recipients?.length !== 1
        || !snowflake(channel.recipients[0]?.id) || channel.recipients[0]?.id === me.id
        || channel.recipients[0]?.bot) {
        throw new ChannelDriverError("unsupported_channel", "DM ID must identify an existing one-to-one user DM accessible to this bot.");
      }
      return channel;
    }
    if (![0, 5, 10, 11, 12].includes(channel.type) || !("guild_id" in channel)
      || !channel.guild_id || !this.cfg.guild_ids.includes(channel.guild_id)) {
      throw new ChannelDriverError("unsupported_channel", "Select an accessible guild text channel or existing thread in the configured guilds.");
    }
    const guild = channel.guild_id;
    const roles = await this.api.request<APIRole[]>(`/guilds/${guild}/roles`, signal);
    const member = await this.api.request<APIGuildMember>(`/guilds/${guild}/members/${me.id}`, signal);
    let parent: APIChannel = channel;
    if (isThread(channel)) {
      if (!("parent_id" in channel) || !channel.parent_id) {
        throw new ChannelDriverError("sync_failed", "Thread parent is missing.");
      }
      parent = await this.api.request<APIChannel>(`/channels/${channel.parent_id}`, signal);
      if (!("guild_id" in parent) || parent.guild_id !== guild || ![0, 5, 15, 16].includes(parent.type)) {
        throw new ChannelDriverError("sync_failed", "Discord returned an invalid thread parent.");
      }
    }
    const mask = permissions(guild, me.id, member, roles, "permission_overwrites" in parent ? parent.permission_overwrites ?? [] : []);
    let required = P.view | P.history;
    if (write) required |= isThread(channel) ? P.threadSend : P.send;
    if ((mask & required) !== required) {
      throw new ChannelDriverError(write ? "send_failed" : "sync_failed",
        `Missing VIEW_CHANNEL/READ_MESSAGE_HISTORY${write ? isThread(channel) ? "/SEND_MESSAGES_IN_THREADS" : "/SEND_MESSAGES" : ""}.`,
        "missing_permissions");
    }
    if (write && member.communication_disabled_until && Date.parse(member.communication_disabled_until) > Date.now()) {
      throw new ChannelDriverError("send_failed", "The bot is timed out in this guild.", "missing_permissions");
    }
    if (isThread(channel)) {
      if (write && "thread_metadata" in channel && (channel.thread_metadata?.archived || channel.thread_metadata?.locked)) {
        throw new ChannelDriverError("send_failed", "Archived or locked threads are read-only here. Reopen them in Discord explicitly.");
      }
      // Requiring membership avoids Discord's implicit join on send.
      if (channel.type === 12 || write) {
        const membership = await this.api.request<APIThreadMember>(`/channels/${id}/thread-members/@me`, signal);
        if (membership.user_id !== undefined && membership.user_id !== me.id
          || membership.id !== undefined && membership.id !== id
          || typeof membership.join_timestamp !== "string") {
          throw new ChannelDriverError("sync_failed", "The bot must already be a member of this thread.");
        }
      }
    }
    return channel;
  }
}
