import { ChannelDriverError } from "@regenic/connector-contract";

export const TYPE = "discord";
export const SOURCE = "discord";
export const PAGE_SIZE = 100;
export const snowflake = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
export const compare = (a: string, b: string): number => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
export const externalId = (channel: string, message: string): string => `${channel}:${message}`;
export const threadId = (channel: string): string => `${SOURCE}:${channel}`;

export function fail(message: string): never {
  throw new ChannelDriverError("invalid_config", message);
}

export function idList(value: unknown, field: string): string[] {
  const values = value === undefined || value === "" ? [] : typeof value === "string"
    ? value.split(",").map((id) => id.trim()) : value;
  if (!Array.isArray(values) || values.length > 200 || !values.every(snowflake)) {
    return fail(`${field} must contain at most 200 comma-separated Discord IDs.`);
  }
  return [...new Set(values)];
}

export interface Config {
  guild_ids: string[];
  channel_ids: string[];
  dm_channel_ids: string[];
}

export function config(input: Record<string, unknown>): Config {
  const keys = new Set(["guild_ids", "channel_ids", "dm_channel_ids"]);
  if (Object.keys(input).some((key) => !keys.has(key))) {
    return fail("Only guild_ids, channel_ids and dm_channel_ids are supported. Store tokens in the system credential store.");
  }
  const result = {
    guild_ids: idList(input.guild_ids, "guild_ids"),
    channel_ids: idList(input.channel_ids, "channel_ids"),
    dm_channel_ids: idList(input.dm_channel_ids, "dm_channel_ids"),
  };
  if (result.channel_ids.some((id) => result.dm_channel_ids.includes(id))) {
    return fail("A channel cannot be selected as both a guild channel and a DM.");
  }
  if (result.channel_ids.length && !result.guild_ids.length) {
    return fail("Select the guild_ids containing the selected channels.");
  }
  return result;
}

export function selected(value: Config, id: string): boolean {
  return value.channel_ids.includes(id) || value.dm_channel_ids.includes(id);
}

export function targetId(target: string): string {
  if (!snowflake(target)) return fail("Thread target must be a Discord channel ID.");
  return target;
}
