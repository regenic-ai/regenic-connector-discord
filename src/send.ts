import { createHash } from "node:crypto";
import {
  ChannelDriverError, SendNotAcceptedError,
  type RegisteredEgress, type SendIntent, type DeliveryReceipt,
} from "@regenic/connector-contract";
import type { APIMessage } from "discord-api-types/v10";
import type { DiscordApi } from "./api";
import { Access } from "./access";
import { externalId, SOURCE, snowflake, type Config } from "./model";
import type { Outbox } from "./outbox";

export function egress(
  api: DiscordApi, cfg: Config, installationId: string, channel: string, outbox: Outbox, lifetime: AbortSignal,
): RegisteredEgress {
  const access = new Access(api, cfg);
  return {
    source: SOURCE,
    capabilities: () => ({ reply: true, edit: false, tombstone: false }),
    async send(intent: SendIntent): Promise<DeliveryReceipt> {
      lifetime.throwIfAborted();
      if (intent.installation_id !== installationId || intent.target?.scope_id && intent.target.scope_id !== channel) {
        throw new SendNotAcceptedError("invalid_config", "Send target does not belong to this Discord installation/channel.");
      }
      if (!intent.idempotency_key || intent.idempotency_key.length > 512) {
        throw new SendNotAcceptedError("invalid_config", "A stable idempotency_key is required for every Discord send.");
      }
      if (!intent.content.length || intent.content.some((part) => part.role !== "body" || part.media_type !== "text/plain" || typeof part.text !== "string")) {
        throw new SendNotAcceptedError("invalid_config", "Only text/plain body parts can be sent to Discord.");
      }
      const text = intent.content.map((part) => part.text).join("\n");
      if (!text.trim() || text.length > 2000) throw new SendNotAcceptedError("invalid_config", "Discord text must contain 1-2000 characters; messages are not split.");
      let reply: string | undefined;
      if (intent.target?.external_id) {
        const parts = intent.target.external_id.split(":");
        if (parts.length !== 2 || parts[0] !== channel || !snowflake(parts[1])) {
          throw new SendNotAcceptedError("invalid_config", "Native replies must reference a Discord message in this channel.");
        }
        reply = parts[1];
      }
      const fingerprint = createHash("sha256").update(JSON.stringify([channel, text, reply])).digest("hex");
      const { entry, fresh } = await outbox.reserve(intent.idempotency_key, fingerprint);
      if (entry.fingerprint !== fingerprint) throw new SendNotAcceptedError("invalid_config", "Idempotency key was already used for a different message.");
      if (!fresh) {
        if (entry.state === "accepted" && entry.message_id) return receipt(entry.message_id);
        if (entry.state === "rejected") throw new SendNotAcceptedError("send_failed", "This send was rejected. Correct the cause and create a new send operation.");
        throw new ChannelDriverError("send_failed", "Previous delivery is unknown or still in progress. Inspect Discord; automatic retry is blocked.", "delivery_unknown");
      }
      let remote: APIMessage;
      try {
        try {
          await access.channel(channel, lifetime, true);
        } catch (error) {
          if (error instanceof ChannelDriverError) throw new SendNotAcceptedError(error.code, error.message, error.reason);
          throw error;
        }
        lifetime.throwIfAborted();
        remote = await api.request<APIMessage>(`/channels/${channel}/messages`, lifetime, {
          content: text, nonce: entry.nonce, enforce_nonce: true,
          allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
          ...(reply ? { message_reference: { message_id: reply, channel_id: channel, fail_if_not_exists: true } } : {}),
        });
      } catch (error) {
        if (error instanceof SendNotAcceptedError) {
          await outbox.update(intent.idempotency_key, { ...entry, state: "rejected" });
        }
        throw error;
      }
      if (!snowflake(remote.id) || remote.channel_id !== channel) {
        throw new ChannelDriverError("send_failed", "Discord delivery response is invalid. Inspect Discord before resending.", "delivery_unknown");
      }
      await outbox.update(intent.idempotency_key, { ...entry, state: "accepted", message_id: remote.id });
      return receipt(remote.id);
    },
  };
}

function receipt(id: string): DeliveryReceipt {
  return { accepted: true, rpc_id: id, channel_message_ids: [id] };
}

export function outbound(channel: string, result: DeliveryReceipt): string {
  if (!result.accepted || !snowflake(result.rpc_id)) throw new ChannelDriverError("send_failed", "Discord did not provide an accepted message ID.");
  return externalId(channel, result.rpc_id);
}
