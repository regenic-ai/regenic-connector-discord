const { randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHost } = require("@regenic/plugin-host");
const { MemoryConnectorRegistry, MemoryEgressRegistry } = require("@regenic/connector-test-utils");
const { createDiscordDriver } = require("../dist/index.js");
const { P } = require("../dist/access.js");

const G = "9007199254740993001";
const G2 = "9007199254740993002";
const C = "9007199254740993101";
const C2 = "9007199254740993102";
const T = "9007199254740993103";
const DM = "9007199254740993104";
const BOT = "9007199254740993201";
const USER = "9007199254740993202";
const BASE = BigInt(Date.parse("2026-10-30T11:00:00.000Z") - 1420070400000) << 22n;
const NOW = "2026-10-30T12:00:00.000Z";
const permissions = String(P.view | P.history | P.send | P.threadSend);
const mid = (i) => String(BASE + BigInt(i));
const message = (i, channel = C, overrides = {}) => ({
  id: mid(i), channel_id: channel, author: { id: USER, username: "participant", bot: false },
  content: `message ${i}`, timestamp: "2026-10-30T11:00:00.000Z",
  edited_timestamp: null, type: 0, attachments: [], embeds: [],
  ...overrides,
});

class Fixture {
  constructor() {
    this.calls = [];
    this.channels = new Map([
      [C, { id: C, type: 0, guild_id: G, name: "selected", permission_overwrites: [] }],
      [C2, { id: C2, type: 0, guild_id: G2, name: "second", permission_overwrites: [] }],
      [T, { id: T, type: 11, guild_id: G, parent_id: C, name: "thread", thread_metadata: { archived: false, locked: false } }],
      [DM, { id: DM, type: 1, recipients: [{ id: USER, username: "participant" }] }],
    ]);
    this.messages = [];
    this.flags = 524288;
    this.bot = true;
    this.member = { user: { id: BOT }, roles: [] };
    this.rolePermissions = permissions;
    this.afterMode = "oldest";
    this.postCount = 0;
    this.postHook = undefined;
    this.hook = undefined;
  }
  fetch = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace("/api/v10", "");
    const call = { path, query: parsed.searchParams, method: init.method, body: init.body && JSON.parse(init.body) };
    this.calls.push(call);
    if (this.hook) {
      const response = await this.hook(call, init);
      if (response) return response;
    }
    if (path === "/users/@me") return json({ id: BOT, bot: this.bot, username: "bot" });
    if (path === "/applications/@me") return json({ id: BOT, flags: this.flags });
    if (path === "/users/@me/guilds") return json(this.guildOptions ?? [{ id: G, name: "server" }]);
    if (/\/roles$/.test(path)) {
      const guild = path.split("/")[2];
      return json([{ id: guild, permissions: this.rolePermissions }, ...(this.extraRoles ?? [])]);
    }
    if (/\/guilds\/\d+\/members\/\d+$/.test(path)) return json(this.member);
    if (/\/guilds\/\d+\/channels$/.test(path)) {
      const guild = path.split("/")[2];
      return json([...this.channels.values()].filter((c) => c.guild_id === guild && ![10, 11, 12].includes(c.type)));
    }
    if (/\/guilds\/\d+\/threads\/active$/.test(path)) {
      const guild = path.split("/")[2];
      return json({
        threads: [...this.channels.values()].filter((c) => c.guild_id === guild && [10, 11, 12].includes(c.type) && !c.thread_metadata.archived),
        members: this.threadMembers ?? [{ id: T, user_id: BOT }], has_more: false,
      });
    }
    if (/\/thread-members\/@me$/.test(path)) {
      return this.notMember ? json({ code: 10007 }, 404) : json({ id: path.split("/")[2], user_id: BOT, join_timestamp: NOW, flags: 0 });
    }
    const match = /^\/channels\/(\d+)(\/messages)?$/.exec(path);
    if (!match) throw new Error(`Unexpected fixture request: ${path}`);
    const id = match[1];
    if (!match[2]) return json(this.channels.get(id) ?? { code: 10003 }, this.channels.has(id) ? 200 : 404);
    if (init.method === "POST") {
      this.postCount++;
      if (this.postHook) return this.postHook(call, init);
      return json(message(10000 + this.postCount, id, { author: { id: BOT, bot: true, username: "bot" }, content: call.body.content }));
    }
    let rows = this.messages.filter((m) => m.channel_id === id);
    const before = parsed.searchParams.get("before");
    const after = parsed.searchParams.get("after");
    if (before) rows = rows.filter((m) => BigInt(m.id) < BigInt(before));
    if (after) rows = rows.filter((m) => BigInt(m.id) > BigInt(after));
    rows.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    rows = after && this.afterMode === "oldest" ? rows.slice(0, 100) : rows.slice(-100);
    return json(rows.reverse());
  };
}
const json = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });

async function harness(t, opts = {}) {
  const fixture = opts.fixture ?? new Fixture();
  const root = opts.root ?? await mkdtemp(join(tmpdir(), "regenic-discord-test-"));
  const connectors = new MemoryConnectorRegistry();
  const egress = new MemoryEgressRegistry();
  const host = await createHost();
  host.provide("connectors", connectors);
  host.provide("egress", egress);
  const runtime = {
    get: (name) => host.get(name), plugin: (plugin, cfg) => host.plugin(plugin, cfg), now: () => NOW,
    secrets: { read: () => { throw new Error("Host secrets must not be used"); }, write: () => { throw new Error("Host secrets must not be used"); } },
  };
  const token = randomUUID();
  const driver = (opts.createDriver ?? createDiscordDriver)({
    fetch: fixture.fetch, stateDirectory: root, requestTimeoutMs: 2000,
    tokenStore: { read: async () => token }, ...opts.driver,
  });
  const created = driver.install({
    id: opts.id ?? "test-install", org_id: "org-test", now: NOW,
    config: opts.config ?? { guild_ids: [G], channel_ids: [C], dm_channel_ids: [] },
    secrets: runtime.secrets,
  });
  const installation = { ...created, updated_at: NOW };
  t.after(async () => {
    await driver.stopInstallation(installation, runtime, { reason: "shutdown", signal: AbortSignal.timeout(1000) });
    await host.dispose();
    if (!opts.root) await rm(root, { recursive: true, force: true });
  });
  const start = () => driver.startInstallation(installation, runtime);
  const stream = (id = C) => driver.resolveThreadStream(installation, { source: "discord", target: id }, runtime, {});
  const sender = (id = C) => driver.bindEgress(installation, { source: "discord", target: id }, runtime, {});
  return { fixture, root, token, driver, runtime, installation, connectors, egress, start, stream, sender };
}
const sendIntent = (overrides = {}) => ({
  installation_id: "test-install", idempotency_key: randomUUID(),
  content: [{ role: "body", media_type: "text/plain", text: "hello" }], ...overrides,
});

module.exports = { Fixture, harness, message, mid, G, G2, C, C2, T, DM, BOT, USER, NOW, json, sendIntent, permissions };
