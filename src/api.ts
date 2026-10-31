import { ChannelDriverError, SendNotAcceptedError } from "@regenic/connector-contract";

export type RequestMethod = "GET" | "POST";
export interface DiscordApi {
  request<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T>;
}
export type Fetch = typeof globalThis.fetch;

export class DiscordHttp implements DiscordApi {
  private blockedUntil = 0;
  private readonly bucketUntil = new Map<string, number>();
  private readonly routeBuckets = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = globalThis.fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async request<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    this.queue = previous.then(() => slot);
    const combined = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    try {
      await cancelable(previous, combined);
      return await cancelable(this.perform<T>(path, combined, body), combined);
    } catch (error) {
      if (error instanceof ChannelDriverError) throw error;
      throw new ChannelDriverError(body === undefined ? "sync_failed" : "send_failed",
        body === undefined ? "Discord request cancelled, timed out or failed." : "Discord delivery is unknown; inspect Discord before any manual resend.",
        body === undefined ? "transport" : "delivery_unknown");
    } finally { release(); }
  }

  private async perform<T>(path: string, combined: AbortSignal, body?: unknown): Promise<T> {
    const method: RequestMethod = body === undefined ? "GET" : "POST";
    const route = `${method}:${path.split("?")[0]}`;
    const major = /^\/(channels|guilds)\/(\d+)/.exec(path)?.[0] ?? "";
    const bucket = this.routeBuckets.get(route) ?? route;
    if (Date.now() < Math.max(this.blockedUntil, this.bucketUntil.get(bucket) ?? 0)) {
      const ErrorType = body === undefined ? ChannelDriverError : SendNotAcceptedError;
      throw new ErrorType("throttled", "Discord rate limit is active. Wait before requesting again.");
    }
    if (!path.startsWith("/") || path.includes("..") || path.includes("://")) {
      throw new ChannelDriverError("invalid_config", "Invalid Discord API route.");
    }
    combined.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetcher(`https://discord.com/api/v10${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": "DiscordBot (https://github.com/regenic-ai/regenic-connector-discord, 0.1.0)",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
        redirect: "error",
      });
    } catch {
      throw new ChannelDriverError(
        body === undefined ? "sync_failed" : "send_failed",
        body === undefined ? "Discord request cancelled, timed out or failed." : "Discord delivery is unknown; inspect Discord before any manual resend.",
        body === undefined ? "transport" : "delivery_unknown",
      );
    }
    const hash = response.headers.get("x-ratelimit-bucket");
    const nextBucket = hash ? `${major}:${hash}` : route;
    this.routeBuckets.set(route, nextBucket);
    const reset = Number(response.headers.get("x-ratelimit-reset-after"));
    if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
      this.bucketUntil.set(nextBucket, Date.now() + reset * 1000);
    }
    if (!response.ok) {
      if (response.status === 429) {
        const retryHeader = response.headers.get("retry-after");
        let retry = retryHeader ? Number(retryHeader) : 5;
        if (!Number.isFinite(retry) || retry < 0) retry = 5;
        let global = response.headers.get("x-ratelimit-global") === "true";
        try {
          const data: unknown = await response.json();
          if (data && typeof data === "object" && "retry_after" in data && typeof data.retry_after === "number") {
            if (Number.isFinite(data.retry_after)) retry = Math.max(retry, data.retry_after, 0.1);
          }
          if (data && typeof data === "object" && "global" in data && data.global === true) global = true;
        } catch { /* A missing rate-limit body still imposes a cooldown. */ }
        const until = Date.now() + Math.max(retry, 0.1) * 1000;
        if (global) this.blockedUntil = until;
        else this.bucketUntil.set(nextBucket, until);
      } else {
        await response.body?.cancel();
      }
      const knownRejected = [400, 401, 403, 404, 405, 413, 429].includes(response.status);
      const ErrorType = body !== undefined && knownRejected ? SendNotAcceptedError : ChannelDriverError;
      const code = response.status === 429 ? "throttled" : body === undefined ? "sync_failed" : "send_failed";
      const message = response.status === 401 ? "Discord rejected the bot token."
        : response.status === 403 ? "Discord denied access. Check channel permissions and thread membership."
        : response.status === 404 ? "Discord channel, thread or referenced message is unavailable."
        : response.status === 429 ? `Discord rate limit active; retry after at least ${retrySeconds(Math.max(this.blockedUntil, this.bucketUntil.get(nextBucket) ?? 0))} seconds.`
        : `Discord HTTP ${response.status}${body !== undefined && !knownRejected ? "; delivery is unknown, do not automatically resend" : ""}.`;
      throw new ErrorType(code, message, body !== undefined && !knownRejected ? "delivery_unknown" : `http_${response.status}`);
    }
    try {
      return await response.json() as T;
    } catch {
      throw new ChannelDriverError(body === undefined ? "sync_failed" : "send_failed", "Discord returned an unreadable response.", body === undefined ? "invalid_response" : "delivery_unknown");
    }
  }
}

function cancelable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function retrySeconds(until: number): number {
  return Math.max(1, Math.ceil((until - Date.now()) / 1000));
}
