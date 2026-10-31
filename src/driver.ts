import { homedir } from "node:os";
import { join } from "node:path";
import {
  ChannelDriverError, defineLocaleTables, keychainCredentialsRef,
  type ChannelDriver, type ConnectorHost, type ConnectorInstallation, type ConnectorStream,
  type RegisteredEgress, type SyncSource, type ConnectorCatalogProbe,
} from "@regenic/connector-contract";
import { definePlugin } from "@regenic/plugin-host";
import { DiscordHttp, type DiscordApi, type Fetch } from "./api";
import { config, fail, selected, SOURCE, targetId, threadId, TYPE, type Config } from "./model";
import { directory } from "./directory";
import { pollConnector } from "./poll";
import { egress, outbound } from "./send";
import { Outbox } from "./outbox";
import { systemTokens, type TokenStore } from "./secrets";

export interface DiscordDriverOptions {
  stateDirectory?: string;
  tokenStore?: TokenStore;
  fetch?: Fetch;
  requestTimeoutMs?: number;
}

interface Activation {
  installation: ConnectorInstallation;
  cfg: Config;
  abort: AbortController;
  pending: Set<Promise<unknown>>;
  disposers: Array<() => void | Promise<void>>;
  streams: Map<string, Promise<ConnectorStream>>;
  senders: Map<string, Promise<RegisteredEgress>>;
  api?: Promise<DiscordApi>;
  ready: Promise<void>;
  stopped: boolean;
  stop?: Promise<void>;
  outbox: Outbox;
}

function stamp(installation: ConnectorInstallation): string {
  return JSON.stringify([installation.id, installation.org_id, installation.config, installation.updated_at]);
}

export function createDiscordDriver(options: DiscordDriverOptions = {}): ChannelDriver {
  const states = new Map<string, Activation>();
  const tokens = options.tokenStore ?? systemTokens;
  const root = options.stateDirectory ?? join(homedir(), ".regenic", "connectors", "discord", "outbox");

  function active(installation: ConnectorInstallation): Activation {
    const state = states.get(installation.id);
    if (installation.status !== "enabled" || !state || state.abort.signal.aborted
      || stamp(state.installation) !== stamp(installation)) {
      throw new ChannelDriverError("sync_failed", "Discord installation is stopped, stale or not started.", "disabled");
    }
    return state;
  }

  function admitted<T>(state: Activation, task: () => Promise<T>): Promise<T> {
    state.abort.signal.throwIfAborted();
    const work = task();
    state.pending.add(work);
    void work.finally(() => state.pending.delete(work)).catch(() => undefined);
    return work;
  }

  async function api(state: Activation): Promise<DiscordApi> {
    state.abort.signal.throwIfAborted();
    state.api ??= tokens.read(state.installation.id, state.abort.signal).then((token) => {
      state.abort.signal.throwIfAborted();
      return new DiscordHttp(token, options.fetch, options.requestTimeoutMs);
    });
    const result = await state.api;
    state.abort.signal.throwIfAborted();
    return result;
  }

  function channel(installation: ConnectorInstallation, target: string): Activation {
    const state = active(installation);
    if (!selected(state.cfg, targetId(target))) throw new ChannelDriverError("unsupported_channel", "This Discord channel has not been explicitly selected.");
    return state;
  }

  function stream(state: Activation, host: ConnectorHost, id: string): Promise<ConnectorStream> {
    const existing = state.streams.get(id);
    if (existing) return existing;
    const mounting = (async () => {
      const client = await api(state);
      state.abort.signal.throwIfAborted();
      const source = pollConnector(client, state.installation, state.cfg, id, state.abort.signal, () => host.now());
      const result: ConnectorStream = {
        stream_key: id, thread_id: threadId(id), pace: { idle_ms: 15_000, catch_up_pages: 1 },
        connector: {
          source: SOURCE, source_mode: "poll",
          poll: (cursor, opts) => admitted(state, () => source.poll(cursor, opts)),
        },
      };
      const handle = await host.plugin(definePlugin({
        name: `discord:${state.installation.id}:${id}`,
        inject: ["connectors"],
        apply(ctx) {
          state.abort.signal.throwIfAborted();
          const dispose = ctx.get("connectors").register(state.installation.id, result.connector, {
            stream_key: id, thread_id: result.thread_id, pace: result.pace,
          });
          return dispose;
        },
      }));
      if (state.abort.signal.aborted) {
        await handle.dispose();
        state.abort.signal.throwIfAborted();
      }
      state.disposers.push(() => handle.dispose());
      return result;
    })();
    state.streams.set(id, mounting);
    void mounting.catch(() => { if (state.streams.get(id) === mounting) state.streams.delete(id); });
    return mounting;
  }

  const driver: ChannelDriver = {
    connector_type: TYPE, source: SOURCE, source_mode: "poll", connector_protocol: "1.0",
    install(input) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) return fail("Installation ID must contain 1-128 letters, digits, underscores or hyphens.");
      const cfg = config(input.config);
      return {
        id: input.id, org_id: input.org_id, connector_type: TYPE, status: "enabled",
        config: { guild_ids: cfg.guild_ids, channel_ids: cfg.channel_ids, dm_channel_ids: cfg.dm_channel_ids },
        credentials_ref: keychainCredentialsRef("regenic-discord"), created_at: input.now,
      };
    },
    capabilities(installation) {
      const enabled = installation.status === "enabled";
      return { sync: enabled, reply: enabled, create: false, list_title: "conversation", hydrate_on_open: enabled };
    },
    matchesThread(installation, thread) {
      return thread.source === SOURCE && selected(config(installation.config), thread.target);
    },
    ownsThread(installation, thread) {
      return this.matchesThread(installation, thread);
    },
    async startInstallation(installation) {
      if (installation.status !== "enabled") throw new ChannelDriverError("sync_failed", "Discord installation is disabled.", "disabled");
      const previous = states.get(installation.id);
      if (previous && !previous.abort.signal.aborted) {
        if (stamp(previous.installation) !== stamp(installation)) throw new ChannelDriverError("invalid_config", "Stop the old activation before reconfiguring Discord.");
        return previous.ready;
      }
      if (previous && !previous.stopped) throw new ChannelDriverError("sync_failed", "The previous Discord activation has not stopped successfully.", "disabled");
      const state: Activation = {
        installation: structuredClone(installation), cfg: config(installation.config), abort: new AbortController(), pending: new Set(),
        disposers: [], streams: new Map(), senders: new Map(), outbox: new Outbox(root, installation.id),
        ready: Promise.resolve(), stopped: false,
      };
      states.set(installation.id, state);
      state.ready = admitted(state, () => state.outbox.initialize());
      try { await state.ready; }
      catch (error) {
        state.abort.abort(error);
        throw error;
      }
      state.abort.signal.throwIfAborted();
    },
    async stopInstallation(installation, _host, context) {
      const state = states.get(installation.id);
      if (!state) return;
      state.abort.abort(new ChannelDriverError("sync_failed", "Discord installation was stopped.", "disabled"));
      state.stop ??= Promise.allSettled([...state.pending]).then(async () => {
        const failures: unknown[] = [];
        for (const dispose of [...state.disposers].reverse()) {
          try {
            await dispose();
            state.disposers.splice(state.disposers.indexOf(dispose), 1);
          } catch (error) { failures.push(error); }
        }
        state.streams.clear();
        state.senders.clear();
        state.api = undefined;
        if (failures.length) throw new ChannelDriverError("sync_failed", "Discord local resource disposal failed.");
        state.stopped = true;
      });
      try { await bounded(state.stop, context.signal); }
      catch (error) {
        // A still-running stop stays shared; only a settled failure can be retried.
        void state.stop.catch(() => { state.stop = undefined; });
        throw error;
      }
    },
    async resolveStreams(installation, host, _env, requested) {
      const state = active(installation);
      return admitted(state, async () => {
        const ids = [...state.cfg.channel_ids, ...state.cfg.dm_channel_ids];
        const wanted = requested?.threads
          ? ids.filter((id) => requested.threads!.some((thread) => thread.source === SOURCE && thread.target === id)) : ids;
        const streams: ConnectorStream[] = [];
        for (const id of wanted) streams.push(await stream(state, host, id));
        return streams;
      });
    },
    async resolveThreadStream(installation, thread, host) {
      if (thread.source !== SOURCE) throw new ChannelDriverError("unsupported_channel", "Not a Discord thread.");
      const state = channel(installation, thread.target);
      return admitted(state, () => stream(state, host, thread.target));
    },
    async bindSyncSource(installation): Promise<SyncSource> {
      const state = active(installation);
      return {
        listDirectory: (cursor) => admitted(state, async () =>
          directory(await api(state), state.cfg, state.abort.signal).listDirectory(cursor)),
      };
    },
    async bindEgress(installation, thread, host) {
      if (thread.source !== SOURCE) throw new ChannelDriverError("unsupported_channel", "Not a Discord thread.");
      const state = channel(installation, thread.target);
      return admitted(state, async () => {
        const previous = state.senders.get(thread.target);
        if (previous) return previous;
        const mounting = (async () => {
          const adapter = egress(await api(state), state.cfg, installation.id, thread.target, state.outbox, state.abort.signal);
          state.abort.signal.throwIfAborted();
          const wrapped: RegisteredEgress = {
            source: SOURCE, capabilities: adapter.capabilities,
            send: (intent) => admitted(state, () => adapter.send(intent)),
          };
          const dispose = host.get("egress").register(installation.id, wrapped, thread.target);
          state.disposers.push(dispose);
          return wrapped;
        })();
        state.senders.set(thread.target, mounting);
        void mounting.catch(() => { if (state.senders.get(thread.target) === mounting) state.senders.delete(thread.target); });
        return mounting;
      });
    },
    outboundId(thread, receipt) { return outbound(targetId(thread.target), receipt); },
    installCatalog() {
      return {
        title: "discord.title", description: "discord.description", credential_hint: "discord.credentials",
        channel_label: "Discord",
        fields: [
          { key: "guild_ids", label: "discord.guilds" },
          { key: "channel_ids", label: "discord.channels" },
          { key: "dm_channel_ids", label: "discord.dms" },
        ],
        setup_steps: [
          { title: "discord.setup", href: { en: "https://github.com/regenic-ai/regenic-connector-discord#setup", zh: "https://github.com/regenic-ai/regenic-connector-discord/blob/main/README.zh-CN.md" } },
          { title: "discord.token", body: "discord.credentials", command: "regenic-discord token set INSTALLATION_ID" },
        ],
      };
    },
    async probeCatalog() {
      // Local-only: neither credential access nor Discord requests on an Engine catalog probe.
      return { services: { credentials: { ready: false, hint: "discord.probe" } } };
    },
    presentInstall() {
      return { label: "discord.title", detail: "discord.description" };
    },
    locales() {
      return defineLocaleTables({
        en: {
          "discord.title": "Discord Bot",
          "discord.description": "Poll selected server text channels, existing threads and manually added existing user-initiated DMs. No DM discovery.",
          "discord.credentials": "Save a Bot token to the OS credential store using regenic-discord token set INSTALLATION_ID. Never paste tokens into configuration.",
          "discord.guilds": "Server IDs (comma-separated)",
          "discord.channels": "Selected text channel / existing thread IDs (comma-separated)",
          "discord.dms": "Existing user-initiated DM channel IDs (manual; comma-separated)",
          "discord.setup": "Create a bot, grant minimum channel permissions and enable Message Content for guild history.",
          "discord.token": "Store the token after creating the installation.",
          "discord.probe": "Credential access is checked only on an explicit runtime operation. System credential service must be available.",
        },
        zh: {
          "discord.title": "Discord Bot",
          "discord.description": "轮询选定的服务器文本频道、已有线程及手动添加的用户已发起私信。不提供私信发现。",
          "discord.credentials": "运行 regenic-discord token set INSTALLATION_ID，将 Bot token 保存到系统凭据库；勿粘贴到配置中。",
          "discord.guilds": "服务器 ID（逗号分隔）",
          "discord.channels": "选定文本频道 / 已有线程 ID（逗号分隔）",
          "discord.dms": "用户已发起的已有私信频道 ID（手动添加，逗号分隔）",
          "discord.setup": "创建 Bot、授予频道最小权限并为服务器历史启用 Message Content。",
          "discord.token": "创建安装后保存 token。",
          "discord.probe": "仅在明确的运行操作中检查凭据；系统凭据服务必须可用。",
        },
      });
    },
  };
  return driver;
}

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ChannelDriverError("sync_failed", "Discord local shutdown deadline expired.", "deadline_exceeded"));
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export const discordDriver = createDiscordDriver();
