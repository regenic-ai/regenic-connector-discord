import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { ChannelDriverError } from "@regenic/connector-contract";
import { snowflake } from "./model";

export interface OutboxEntry {
  v: 1;
  state: "unknown" | "accepted" | "rejected";
  fingerprint: string;
  nonce: string;
  created_at: string;
  message_id?: string;
}

export class Outbox {
  constructor(private readonly root: string, private readonly installation: string) {}

  private get directory(): string {
    return join(this.root, createHash("sha256").update(this.installation).digest("hex"));
  }

  async initialize(): Promise<void> {
    const firstCreated = await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const dir of [this.root, this.directory]) {
      if (dir !== this.root) await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) {
        throw new ChannelDriverError("invalid_config", "Outbox directory must be owned by this user and must not be a symlink.");
      }
      await chmod(dir, 0o700);
    }
    if (process.platform !== "win32") {
      await this.syncDirectory();
      await syncPath(this.root);
      if (firstCreated) {
        const stop = dirname(resolve(firstCreated));
        for (let parent = dirname(resolve(this.root)); ; parent = dirname(parent)) {
          await syncPath(parent);
          if (parent === stop || dirname(parent) === parent) break;
        }
      }
    }
  }

  private file(key: string): string {
    return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  async reserve(key: string, fingerprint: string): Promise<{ entry: OutboxEntry; fresh: boolean }> {
    const entry: OutboxEntry = {
      v: 1, state: "unknown", fingerprint,
      nonce: createHash("sha256").update(`${this.installation}:${key}`).digest("hex").slice(0, 25),
      created_at: new Date().toISOString(),
    };
    const path = this.file(key);
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      return { entry: await this.read(path), fresh: false };
    }
    try {
      await handle.writeFile(JSON.stringify(entry));
      await handle.sync();
    } finally { await handle.close(); }
    await this.syncDirectory();
    return { entry, fresh: true };
  }

  private async read(path: string): Promise<OutboxEntry> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0
        || process.getuid && stat.uid !== process.getuid()) throw new Error();
      const data: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!data || typeof data !== "object") throw new Error();
      const value = data as Partial<OutboxEntry>;
      if (value.v !== 1 || !["unknown", "accepted", "rejected"].includes(value.state ?? "")
        || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
        || typeof value.nonce !== "string" || !/^[a-f0-9]{25}$/.test(value.nonce)
        || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))
        || (value.state === "accepted" && !snowflake(value.message_id))) throw new Error();
      return value as OutboxEntry;
    } catch {
      throw new ChannelDriverError("send_failed", "Outbox state is unreadable or unsafe; delivery may be unknown. Inspect local state and Discord before resending.", "delivery_unknown");
    } finally { await handle.close(); }
  }

  async update(key: string, entry: OutboxEntry): Promise<void> {
    const temp = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(entry));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temp, this.file(key));
      await this.syncDirectory();
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  private async syncDirectory(): Promise<void> {
    // Windows does not support opening a directory for fsync; file handles are still flushed.
    if (process.platform === "win32") return;
    await syncPath(this.directory);
  }
}

async function syncPath(path: string): Promise<void> {
  const dir = await open(path, "r");
  try { await dir.sync(); } finally { await dir.close(); }
}
