const { test } = require("node:test");
const assert = require("node:assert/strict");
const { harness, G, G2, C, C2, T, DM, BOT, USER } = require("./fixtures.cjs");
const { permissions, P } = require("../dist/access.js");
const { ChannelDriverError } = require("@regenic/connector-contract");

test("directory pages configured guilds then manual DMs without reading messages or connecting Gateway", async (t) => {
  const h = await harness(t, { config: { guild_ids: [G, G2], channel_ids: [C], dm_channel_ids: [DM] } });
  await h.start();
  const source = await h.driver.bindSyncSource(h.installation, h.runtime, {});
  const first = await source.listDirectory(null);
  assert.equal(first.complete, false);
  assert.deepEqual(first.members.map((m) => m.stream_key).sort(), [C, T].sort());
  const second = await source.listDirectory(first.next_cursor);
  assert.equal(second.complete, false);
  assert.deepEqual(second.members.map((m) => m.stream_key), [C2]);
  const third = await source.listDirectory(second.next_cursor);
  assert.equal(third.complete, true);
  assert.equal(third.members[0].kind, "dm");
  assert.equal(h.fixture.calls.some((c) => c.path.endsWith("/messages") || /gateway/i.test(c.path)), false);
  const streams = await h.driver.resolveStreams(h.installation, h.runtime, {});
  assert.deepEqual(streams.map((s) => s.stream_key).sort(), [C, DM].sort());
  await assert.rejects(h.stream(T), /explicitly selected/);
  await assert.rejects(source.listDirectory("garbage"), /directory cursor/);
});

test("permission overwrite order uses BigInt and missing READ_MESSAGE_HISTORY never looks like empty history", async (t) => {
  const mask = String(P.view | P.history | P.send | P.threadSend);
  const base = [{ id: G, permissions: mask }, { id: "999", permissions: "0" }];
  const member = { roles: ["999"] };
  assert.equal(permissions(G, BOT, member, base, [
    { type: 0, id: G, deny: String(P.history), allow: "0" },
    { type: 0, id: "999", deny: "0", allow: String(P.history) },
    { type: 1, id: BOT, deny: String(P.history), allow: "0" },
  ]) & P.history, 0n);
  const h = await harness(t);
  h.fixture.channels.get(C).permission_overwrites = [{ type: 0, id: G, deny: String(P.history), allow: "0" }];
  await h.start();
  const source = await h.driver.bindSyncSource(h.installation, h.runtime, {});
  const page = await source.listDirectory(null);
  assert.equal(page.members.length, 0);
  await assert.rejects((await h.stream()).connector.poll(null), (e) => e.reason === "missing_permissions");
  assert.equal(h.fixture.calls.some((c) => c.path.endsWith("/messages")), false);
});

test("private thread must already have membership; archived threads remain read-only", async (t) => {
  const h = await harness(t, { config: { guild_ids: [G], channel_ids: [T] } });
  h.fixture.channels.get(T).type = 12;
  h.fixture.notMember = true;
  h.fixture.threadMembers = [];
  await h.start();
  const poll = (await h.stream(T)).connector.poll;
  await assert.rejects(poll(null), /unavailable/);
  h.fixture.notMember = false;
  assert.equal((await poll(null)).batch.records.length, 0);
  h.fixture.channels.get(T).thread_metadata.archived = true;
  const sender = await h.sender(T);
  await assert.rejects(sender.send(require("./fixtures.cjs").sendIntent()), /Archived/);
  assert.equal(h.fixture.postCount, 0);
  assert.equal(h.fixture.calls.some((c) => c.method === "PUT" || c.method === "PATCH"), false);
});

test("joined public threads check SEND_MESSAGES_IN_THREADS independently of SEND_MESSAGES", async (t) => {
  const h = await harness(t, { config: { guild_ids: [G], channel_ids: [T] } });
  await h.start();
  const sender = await h.sender(T);
  h.fixture.rolePermissions = String(P.view | P.history | P.send);
  await assert.rejects(sender.send(require("./fixtures.cjs").sendIntent()), /SEND_MESSAGES_IN_THREADS/);
  h.fixture.rolePermissions = String(P.view | P.history | P.threadSend);
  assert.equal((await sender.send(require("./fixtures.cjs").sendIntent())).accepted, true);
  h.fixture.notMember = true;
  await assert.rejects(sender.send(require("./fixtures.cjs").sendIntent()), /unavailable/);
  assert.equal(h.fixture.postCount, 1);
});

test("metadata probe and manual-ID catalog remain local-only", async (t) => {
  const h = await harness(t);
  await h.driver.probeCatalog({ env: {} });
  const manual = h.driver.installCatalog();
  assert.equal(manual.fields.every((field) => !field.multiple && field.options === undefined), true);
  assert.equal(h.driver.listCatalogFieldOptions, undefined);
  assert.equal(h.fixture.calls.length, 0);
  assert.equal(manual.fields.find((field) => field.key === "guild_ids").multiple, undefined);
});

test("Bot identity and channel type are validated, arbitrary install fields and numeric snowflakes rejected", async (t) => {
  const h = await harness(t);
  assert.throws(() => h.driver.install({ id: "test", org_id: "org", now: "", config: { bot_token: "do-not-store" } }), ChannelDriverError);
  assert.throws(() => h.driver.install({ id: "test", org_id: "org", now: "", config: { guild_ids: [Number(G)] } }), /Discord IDs/);
  await h.start();
  h.fixture.bot = false;
  await assert.rejects((await h.stream()).connector.poll(null), /official Discord bot/);
  h.fixture.bot = true;
  h.fixture.channels.get(C).type = 2;
  await assert.rejects((await h.stream()).connector.poll(null), /text channel/);
});
