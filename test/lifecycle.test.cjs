const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ChannelDriverError } = require("@regenic/connector-contract");
const { harness, C, T, G, json, message, sendIntent } = require("./fixtures.cjs");

test("concurrent activation, stream and egress binding share one registration", async (t) => {
  const h = await harness(t);
  await Promise.all([h.start(), h.start(), h.start()]);
  const streams = await Promise.all([h.stream(), h.stream(), h.stream()]);
  assert.equal(streams[0], streams[1]);
  assert.equal(streams[0], streams[2]);
  assert.equal(h.connectors.listStreams(h.installation.id).length, 1);
  const senders = await Promise.all([h.sender(), h.sender(), h.sender()]);
  assert.equal(senders[0], senders[1]);
  assert.equal(senders[0], senders[2]);
});

for (const reason of ["disable", "delete", "reconfigure", "clear", "shutdown"]) {
  test(`${reason} closes local streams/egress, fences old references and allows only explicit restart`, async (t) => {
    const h = await harness(t);
    await h.start();
    const stream = await h.stream();
    const sender = await h.sender();
    const directory = await h.driver.bindSyncSource(h.installation, h.runtime, {});
    await h.driver.stopInstallation(h.installation, h.runtime, { reason, signal: AbortSignal.timeout(1000) });
    assert.equal(h.connectors.get(h.installation.id, C), undefined);
    assert.equal(h.egress.get(h.installation.id, C), undefined);
    const before = h.fixture.calls.length;
    await assert.rejects(async () => stream.connector.poll(null));
    await assert.rejects(async () => sender.send(sendIntent()));
    await assert.rejects(async () => directory.listDirectory(null));
    await assert.rejects(h.stream(), (e) => e.reason === "disabled");
    assert.equal(h.fixture.calls.length, before);
    await h.start();
    const next = await h.stream();
    assert.notEqual(next, stream);
    await assert.rejects(async () => stream.connector.poll(null));
    assert.equal((await next.connector.poll(null)).batch.records.length, 0);
    assert.equal(h.fixture.calls.some((c) => c.method !== "GET"), false);
  });
}

test("stop aborts an in-flight poll; caller cancellation and request timeout are bounded", async (t) => {
  const h = await harness(t, { driver: { requestTimeoutMs: 40 } });
  h.fixture.hook = (call, init) => {
    if (!call.path.endsWith("/messages")) return;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted transport")), { once: true });
    });
  };
  await h.start();
  const stream = await h.stream();
  await assert.rejects(stream.connector.poll(null), (e) => e.reason === "transport");
  const controller = new AbortController();
  const p = stream.connector.poll(null, { signal: controller.signal });
  const rejected = assert.rejects(p);
  controller.abort();
  await rejected;
  const inFlight = stream.connector.poll(null);
  const cancelled = assert.rejects(inFlight);
  await h.driver.stopInstallation(h.installation, h.runtime, { reason: "disable", signal: AbortSignal.timeout(1000) });
  await cancelled;
  assert.equal(h.connectors.get(h.installation.id, C), undefined);
});

test("a late credential read after stop cannot mount or resurrect old registry entries", async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const h = await harness(t, { driver: { tokenStore: { read: () => { entered(); return new Promise((resolve) => { release = resolve; }); } } } });
  await h.start();
  const pending = h.stream();
  const rejected = assert.rejects(pending);
  await started;
  const stop = h.driver.stopInstallation(h.installation, h.runtime, { reason: "clear", signal: AbortSignal.timeout(500) });
  release("generated-local-test-value");
  await stop;
  await rejected;
  assert.equal(h.connectors.listStreams(h.installation.id).length, 0);
  assert.equal(h.fixture.calls.length, 0);
  await h.start();
  // Old rejected activation must not create registrations when a new one exists.
  assert.equal(h.connectors.listStreams(h.installation.id).length, 0);
});

test("stop deadline prevents restart until original pending work has actually drained", async (t) => {
  let release;
  let entered;
  const readStarted = new Promise((resolve) => { entered = resolve; });
  const h = await harness(t, { driver: { tokenStore: { read: () => { entered(); return new Promise((resolve) => { release = resolve; }); } } } });
  await h.start();
  const pending = h.stream();
  const rejected = assert.rejects(pending);
  await readStarted;
  await assert.rejects(h.driver.stopInstallation(h.installation, h.runtime, { reason: "disable", signal: AbortSignal.timeout(20) }), (e) => e.reason === "deadline_exceeded");
  await assert.rejects(h.start(), /not stopped successfully/);
  release("generated-local-test-value");
  await rejected;
  await h.driver.stopInstallation(h.installation, h.runtime, { reason: "disable", signal: AbortSignal.timeout(500) });
  await h.start();
});

test("stale config cannot reactivate without stop, install capabilities respect status", async (t) => {
  const h = await harness(t);
  await h.start();
  const changed = { ...h.installation, updated_at: "2026-10-30T12:01:00Z", config: { guild_ids: [G], channel_ids: [T] } };
  await assert.rejects(h.driver.startInstallation(changed, h.runtime), /Stop the old activation/);
  await assert.rejects(h.driver.resolveThreadStream(changed, { source: "discord", target: T }, h.runtime, {}), (e) => e.reason === "disabled");
  assert.equal(h.driver.capabilities({ ...h.installation, status: "disabled" }).sync, false);
});

test("unknown send during stop stays fenced after re-enable", async (t) => {
  const h = await harness(t);
  let postStarted;
  const entered = new Promise((resolve) => { postStarted = resolve; });
  h.fixture.postHook = (_call, init) => {
    postStarted();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  };
  await h.start();
  const sender = await h.sender();
  const intent = sendIntent();
  const sending = sender.send(intent);
  const rejected = assert.rejects(sending, (e) => e.reason === "delivery_unknown");
  await entered;
  await h.driver.stopInstallation(h.installation, h.runtime, { reason: "disable", signal: AbortSignal.timeout(1000) });
  await rejected;
  await h.start();
  await assert.rejects((await h.sender()).send(intent), (e) => e.reason === "delivery_unknown");
  assert.equal(h.fixture.postCount, 1);
});
