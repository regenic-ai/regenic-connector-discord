const { test } = require("node:test");
const assert = require("node:assert/strict");
const { verifyChannelDriverConformance, verifyPollConnectorConformance, verifyConnectorSourceMode } = require("@regenic/connector-test-utils");
const { ChannelDriverError, validateIngestBatch, surfaceFromParts } = require("@regenic/connector-contract");
const { harness, message, mid, G, C, T, DM, BOT, USER } = require("./fixtures.cjs");
const cur = (result) => ({ value: result.next_cursor });

test("published contract conformance, source mode, plugin-host registration and surface metadata", async (t) => {
  const h = await harness(t);
  h.fixture.messages = [message(1), message(2, C, { message_reference: { message_id: mid(1) } })];
  await h.start();
  const stream = await h.stream();
  assert.equal(h.connectors.get(h.installation.id, C), stream.connector);
  verifyChannelDriverConformance({ driver: h.driver, enabled: h.installation, disabled: { ...h.installation, status: "disabled" } });
  verifyConnectorSourceMode(stream.connector);
  const report = await verifyPollConnectorConformance({ connector: stream.connector, cursor: null, connector_id: h.installation.id, source: "discord" });
  assert.equal(report.record_count, 2);
  const page = await stream.connector.poll(null);
  assert.equal(validateIngestBatch(page.batch).success, true);
  assert.equal(page.batch.records[1].parent_external_id, `${C}:${mid(1)}`);
  assert.equal(page.batch.records[1].type, "thread_reply");
  assert.equal(surfaceFromParts(page.batch.records[0].content).conversation_label, "selected");
  assert.equal(page.batch.records[0].external_id, `${C}:${mid(1)}`);
});

test("history pagination and independent live cursor survive a new driver process", async (t) => {
  const h = await harness(t);
  h.fixture.messages = Array.from({ length: 250 }, (_, i) => message(i + 1));
  await h.start();
  const poll = (await h.stream()).connector.poll;
  const first = await poll(null);
  assert.deepEqual(first.batch.records.map((r) => r.external_id), Array.from({ length: 100 }, (_, i) => `${C}:${mid(151 + i)}`));
  assert.equal(first.poll_hint.history_pending, true);
  const older = await poll(cur(first), { older: true });
  assert.equal(older.batch.records[0].external_id, `${C}:${mid(51)}`);
  assert.equal(JSON.parse(older.next_cursor).live, mid(250));
  const oldest = await poll(cur(older), { older: true });
  assert.equal(oldest.batch.records.length, 50);
  assert.equal(oldest.poll_hint.history_pending, false);
  await h.driver.stopInstallation(h.installation, h.runtime, { reason: "shutdown", signal: AbortSignal.timeout(1000) });
  const restarted = await harness(t, { root: h.root, fixture: h.fixture });
  await restarted.start();
  h.fixture.messages.push(message(251));
  const live = await (await restarted.stream()).connector.poll(cur(oldest));
  assert.deepEqual(live.batch.records.map((r) => r.external_id), [`${C}:${mid(251)}`]);
  assert.equal(JSON.parse(live.next_cursor).history, mid(1));
});

for (const mode of ["oldest", "newest"]) {
  test(`full after pages (${mode}-first) never skip a burst, retain pending scan across restart`, async (t) => {
    const h = await harness(t);
    h.fixture.afterMode = mode;
    h.fixture.messages = [message(1)];
    await h.start();
    const poll = (await h.stream()).connector.poll;
    let page = await poll(null);
    const original = cur(page);
    h.fixture.messages = Array.from({ length: 351 }, (_, i) => message(i + 1));
    page = await poll(original);
    assert.equal(page.has_more, true);
    assert.equal(JSON.parse(page.next_cursor).live, mid(1));
    const seen = new Set(page.batch.records.map((r) => r.external_id));
    const replay = await poll(original);
    assert.deepEqual(replay, page);
    await h.driver.stopInstallation(h.installation, h.runtime, { reason: "reconfigure", signal: AbortSignal.timeout(1000) });
    const h2 = await harness(t, { root: h.root, fixture: h.fixture });
    await h2.start();
    const resumed = (await h2.stream()).connector.poll;
    h.fixture.messages.push(message(352));
    for (let n = 0; page.has_more && n < 10; n++) {
      page = await resumed(cur(page));
      for (const row of page.batch.records) {
        assert.equal(seen.has(row.external_id), false);
        seen.add(row.external_id);
      }
    }
    assert.equal(seen.size, 350);
    assert.equal(JSON.parse(page.next_cursor).live, mid(351));
    page = await resumed(cur(page));
    assert.deepEqual(page.batch.records.map((r) => r.external_id), [`${C}:${mid(352)}`]);
  });
}

test("history can interleave with live scan and explicit ID boundary excludes boundary row", async (t) => {
  const h = await harness(t);
  h.fixture.messages = Array.from({ length: 150 }, (_, i) => message(i + 1));
  await h.start();
  const poll = (await h.stream()).connector.poll;
  const first = await poll(null);
  h.fixture.messages.push(...Array.from({ length: 250 }, (_, i) => message(i + 151)));
  const live = await poll(cur(first));
  const history = await poll(cur(live), { older: true, before_external_id: `${C}:${mid(51)}` });
  assert.equal(history.batch.records.length, 50);
  assert.deepEqual(JSON.parse(history.next_cursor).scan, JSON.parse(live.next_cursor).scan);
  let page = history;
  const seen = new Set(live.batch.records.map((r) => r.external_id));
  for (let i = 0; i < 10 && JSON.parse(page.next_cursor).scan; i++) {
    page = await poll(cur(page));
    page.batch.records.forEach((r) => seen.add(r.external_id));
  }
  assert.equal(seen.size, 250);
});

test("latest hydration returns a recent page without discarding a pending live scan", async (t) => {
  const h = await harness(t);
  h.fixture.messages = [message(1)];
  await h.start();
  const poll = (await h.stream()).connector.poll;
  const first = await poll(null);
  h.fixture.messages = Array.from({ length: 251 }, (_, i) => message(i + 1));
  const pending = await poll(cur(first));
  h.fixture.messages.push(message(252));
  const latest = await poll(cur(pending), { latest: true });
  assert.equal(latest.batch.records.at(-1).external_id, `${C}:${mid(252)}`);
  assert.equal(latest.next_cursor, pending.next_cursor);
  let page = latest;
  const seen = new Set(pending.batch.records.map((r) => r.external_id));
  while (JSON.parse(page.next_cursor).scan) {
    page = await poll(cur(page));
    page.batch.records.forEach((r) => seen.add(r.external_id));
  }
  assert.equal(seen.size, 250);
  page = await poll(cur(page));
  assert.equal(page.batch.records[0].external_id, `${C}:${mid(252)}`);
});

test("invalid cursors, cross-channel boundaries and cancelled polls fail without history reads", async (t) => {
  const h = await harness(t);
  await h.start();
  const poll = (await h.stream()).connector.poll;
  await assert.rejects(poll({ value: "{}" }), ChannelDriverError);
  await assert.rejects(poll({ value: "invalid" }), /cursor/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(poll(null, { signal: cancelled.signal }));
  await assert.rejects(poll(null, { older: true, before_external_id: `${T}:${mid(1)}` }), /boundary/);
  assert.equal(h.fixture.calls.filter((c) => c.path.endsWith("/messages")).length, 0);
});

test("timestamp history boundaries are exact millisecond snowflakes, invalid large boundaries rejected", async (t) => {
  const h = await harness(t);
  h.fixture.messages = [message(1), message(2), message(8388608, C, { timestamp: "2026-10-30T11:00:00.002Z" })];
  await h.start();
  const poll = (await h.stream()).connector.poll;
  const page = await poll(null, { older: true, before: "2026-10-30T11:00:00.001Z" });
  assert.deepEqual(page.batch.records.map((r) => r.external_id), [`${C}:${mid(1)}`, `${C}:${mid(2)}`]);
  const requested = h.fixture.calls.filter((c) => c.path.endsWith("/messages")).at(-1);
  assert.equal(requested.query.get("before"), mid(4194304));
  await assert.rejects(poll(null, { older: true, before: "9999-12-30T00:00:00Z" }), /snowflake range/);
});

test("guild Message Content is explicitly verified; empty attachments/system are not called intent failures", async (t) => {
  const h = await harness(t);
  await h.start();
  const poll = (await h.stream()).connector.poll;
  h.fixture.flags = 0;
  await assert.rejects(poll(null), (e) => e.reason === "message_content_intent");
  assert.equal(h.fixture.calls.some((c) => c.path.endsWith("/messages")), false);
  h.fixture.flags = 524288;
  h.fixture.messages = [
    message(1, C, { content: "", attachments: [{ id: mid(20), filename: "image.png" }] }),
    message(2, C, { content: "", embeds: [{ description: "embedded" }] }),
    message(3, C, { content: "", type: 7 }),
  ];
  const page = await poll(null);
  assert.equal(page.batch.records.length, 3);
  assert.equal(page.batch.records[0].attrs.non_text, true);
  h.fixture.messages.push(message(4, C, { content: "" }));
  await assert.rejects(poll(cur(page)), (e) => e.reason === "content_unavailable" && !e.message.includes("Enable"));
  h.fixture.messages[3].content = "now visible";
  const recovered = await poll(cur(page));
  assert.equal(recovered.batch.records[0].external_id, `${C}:${mid(4)}`);
});

test("explicit existing DM requires no guild content intent, rejects group DM and wrong recipient", async (t) => {
  const h = await harness(t, { config: { dm_channel_ids: [DM] } });
  h.fixture.flags = 0;
  h.fixture.messages = [message(1, DM), message(2, DM, { author: { id: BOT, username: "bot", bot: true } })];
  await h.start();
  await assert.rejects(h.stream(C), /explicitly selected/);
  const poll = (await h.stream(DM)).connector.poll;
  const result = await poll(null);
  assert.deepEqual(result.batch.records.map((r) => r.direction_tags), [["inbound"], ["outbound"]]);
  assert.equal(h.fixture.calls.some((c) => c.path === "/applications/@me"), false);
  h.fixture.channels.get(DM).type = 3;
  await assert.rejects(poll(null), /one-to-one/);
  h.fixture.channels.set(DM, { id: DM, type: 1, recipients: [{ id: BOT, username: "bot", bot: true }] });
  await assert.rejects(poll(null), /one-to-one/);
});
