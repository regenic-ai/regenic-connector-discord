const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readdir, readFile, stat, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { ChannelDriverError, SendNotAcceptedError } = require("@regenic/connector-contract");
const { harness, sendIntent, G, C, T, mid, json, message } = require("./fixtures.cjs");
const { P } = require("../dist/access.js");

test("native reply, disabled mentions, durable accepted receipts and idempotent restart", async (t) => {
  const h = await harness(t);
  await h.start();
  const sender = await h.sender();
  assert.equal(h.egress.get(h.installation.id, C), sender);
  const intent = sendIntent({
    target: { external_id: `${C}:${mid(1)}`, scope_id: C },
    content: [{ role: "body", media_type: "text/plain", text: "@everyone @here <@123> <@&456>" }],
  });
  const result = await sender.send(intent);
  const body = h.fixture.calls.find((c) => c.method === "POST").body;
  assert.deepEqual(body.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
  assert.deepEqual(body.message_reference, { message_id: mid(1), channel_id: C, fail_if_not_exists: true });
  assert.equal(body.enforce_nonce, true);
  assert.equal(body.nonce.length, 25);
  assert.deepEqual(await sender.send(intent), result);
  assert.equal(h.fixture.postCount, 1);
  assert.equal(h.driver.outboundId({ source: "discord", target: C }, result), `${C}:${result.rpc_id}`);
  const pollEcho = message(10001, C);
  assert.equal(h.driver.outboundId({ source: "discord", target: C }, result), `${C}:${pollEcho.id}`);
  await h.driver.stopInstallation(h.installation, h.runtime, { reason: "shutdown", signal: AbortSignal.timeout(1000) });
  const h2 = await harness(t, { root: h.root, fixture: h.fixture });
  await h2.start();
  assert.deepEqual(await (await h2.sender()).send(intent), result);
  assert.equal(h.fixture.postCount, 1);
  const [dir] = await readdir(h.root);
  const [file] = await readdir(join(h.root, dir));
  const disk = await readFile(join(h.root, dir, file), "utf8");
  assert.equal(disk.includes(h.token), false);
  assert.equal(disk.includes(intent.content[0].text), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(h.root, dir))).mode & 0o777, 0o700);
    assert.equal((await stat(join(h.root, dir, file))).mode & 0o777, 0o600);
  }
});

for (const failure of ["network", "http500", "badjson", "badresponse"]) {
  test(`ambiguous ${failure} result is never retried, even across restart`, async (t) => {
    const h = await harness(t);
    h.fixture.postHook = () => {
      if (failure === "network") throw new Error(`sensitive response ${h.token}`);
      if (failure === "http500") return json({ content: h.token }, 500);
      if (failure === "badjson") return new Response("broken");
      return json({ id: 123, channel_id: C });
    };
    await h.start();
    const intent = sendIntent();
    const sender = await h.sender();
    await assert.rejects(sender.send(intent), (e) => e instanceof ChannelDriverError && !(e instanceof SendNotAcceptedError) && e.reason === "delivery_unknown" && !e.message.includes(h.token));
    await assert.rejects(sender.send(intent), (e) => e.reason === "delivery_unknown");
    assert.equal(h.fixture.postCount, 1);
    await h.driver.stopInstallation(h.installation, h.runtime, { reason: "shutdown", signal: AbortSignal.timeout(1000) });
    const h2 = await harness(t, { root: h.root, fixture: h.fixture });
    await h2.start();
    await assert.rejects((await h2.sender()).send(intent), (e) => e.reason === "delivery_unknown");
    assert.equal(h.fixture.postCount, 1);
  });
}

test("nonce stable per operation, concurrent sends reserve once, key cannot change content", async (t) => {
  const h = await harness(t);
  await h.start();
  const sender = await h.sender();
  const intent = sendIntent();
  const results = await Promise.allSettled([sender.send(intent), sender.send(intent)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length >= 1, true);
  assert.equal(h.fixture.postCount, 1);
  const sent = h.fixture.calls.find((c) => c.method === "POST").body.nonce;
  await assert.rejects(sender.send({ ...intent, content: [{ role: "body", media_type: "text/plain", text: "different" }] }), /different message/);
  await sender.send(sendIntent());
  assert.notEqual(h.fixture.calls.filter((c) => c.method === "POST")[1].body.nonce, sent);
});

test("HTTP rejected sends are typed not-accepted, no automatic retry, a new operation is explicit", async (t) => {
  const h = await harness(t);
  h.fixture.postHook = () => json({ message: "do not log response" }, 403);
  await h.start();
  const sender = await h.sender();
  const intent = sendIntent();
  await assert.rejects(sender.send(intent), SendNotAcceptedError);
  await assert.rejects(sender.send(intent), /new send operation/);
  assert.equal(h.fixture.postCount, 1);
  h.fixture.postHook = undefined;
  assert.equal((await sender.send(sendIntent())).accepted, true);
});

test("validation and missing permissions fail before message POST", async (t) => {
  const h = await harness(t);
  await h.start();
  const sender = await h.sender();
  for (const patch of [
    { installation_id: "another" },
    { idempotency_key: undefined },
    { content: [{ role: "body", media_type: "text/plain", text: "x".repeat(2001) }] },
    { content: [{ role: "attachment", media_type: "image/png", external_locator: "https://example.com/image" }] },
    { target: { external_id: `${T}:${mid(1)}` } },
    { target: { scope_id: T } },
  ]) await assert.rejects(sender.send(sendIntent(patch)), SendNotAcceptedError);
  h.fixture.rolePermissions = String(P.view | P.history);
  await assert.rejects(sender.send(sendIntent()), (e) => e instanceof SendNotAcceptedError && e.reason === "missing_permissions");
  assert.equal(h.fixture.postCount, 0);
});

test("unreadable reservation state fails closed and never sends", async (t) => {
  const h = await harness(t);
  await h.start();
  const sender = await h.sender();
  const intent = sendIntent();
  await sender.send(intent);
  const [dir] = await readdir(h.root);
  const [file] = await readdir(join(h.root, dir));
  await writeFile(join(h.root, dir, file), "{");
  await assert.rejects(sender.send(intent), (e) => e.reason === "delivery_unknown");
  assert.equal(h.fixture.postCount, 1);
});
