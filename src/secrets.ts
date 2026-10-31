import { ChannelDriverError, installSecretRef } from "@regenic/connector-contract";
import { TYPE } from "./model";

export interface TokenStore {
  read(installationId: string, signal?: AbortSignal): Promise<string>;
}

function validId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new ChannelDriverError("invalid_config", "Installation ID must contain 1-128 letters, digits, underscores or hyphens.");
  }
}

async function entry(id: string) {
  validId(id);
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const ref = installSecretRef(TYPE, id, "bot_token");
    return new AsyncEntry(ref.service, ref.account, { linux: { store: "secret-service" } });
  } catch {
    throw new ChannelDriverError("missing_credentials", "System credential store is unavailable. Unlock or configure the OS credential service; no plaintext fallback is used.");
  }
}

export const systemTokens: TokenStore = {
  async read(id, signal) {
    const item = await entry(id);
    try {
      const token = await item.getPassword(AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]));
      if (!token || /[\s\r\n]/.test(token)) throw new Error();
      return token;
    } catch {
      throw new ChannelDriverError("missing_credentials", "Bot token is missing or inaccessible in the system credential store. Run regenic-discord token set INSTALLATION_ID.");
    }
  },
};

export async function saveToken(id: string, token: string): Promise<void> {
  if (!token || token.length > 512 || /\s/.test(token)) {
    throw new ChannelDriverError("invalid_config", "Token must be a single nonempty value.");
  }
  const item = await entry(id);
  try {
    await item.setPassword(token, AbortSignal.timeout(10_000));
  } catch {
    throw new ChannelDriverError("missing_credentials", "Could not save token in the system credential store. No file was written.");
  }
}

export async function removeToken(id: string): Promise<void> {
  const item = await entry(id);
  try {
    await item.deletePassword(AbortSignal.timeout(10_000));
  } catch {
    throw new ChannelDriverError("missing_credentials", "Could not remove token from the system credential store.");
  }
}
