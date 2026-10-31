const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { DiscordHttp } = require("../dist/api.js");
const { SendNotAcceptedError } = require("@regenic/connector-contract");
const { json, C, G } = require("./fixtures.cjs");

test("HTTP transport uses Bot auth/v10, redirects forbidden, errors never contain response or token", async () => {
  const token = randomUUID();
  let requests = 0;
  const api = new DiscordHttp(token, async (url, init) => {
    requests++;
    assert.equal(url, "https://discord.com/api/v10/users/@me");
    assert.equal(init.headers.Authorization, `Bot ${token}`);
    assert.equal(init.redirect, "error");
    return json({ message: token }, 401);
  });
  await assert.rejects(api.request("/users/@me"), (e) => !e.message.includes(token) && e.reason === "http_401");
  assert.equal(requests, 1);
});

test("global 429 Retry-After blocks all routes and POST is known not accepted", async () => {
  let calls = 0;
  const api = new DiscordHttp(randomUUID(), async () => {
    calls++;
    return json({ global: true, retry_after: 60 }, 429, { "Retry-After": "65", "X-RateLimit-Global": "true" });
  });
  await assert.rejects(api.request(`/channels/${C}/messages`, undefined, { content: "x" }), (e) => e instanceof SendNotAcceptedError && /65/.test(e.message));
  await assert.rejects(api.request("/users/@me"), (e) => e.code === "throttled");
  assert.equal(calls, 1);
});

test("bucket reset headers and learned shared buckets prevent further requests, local 429 is not global", async () => {
  let calls = 0;
  const api = new DiscordHttp(randomUUID(), async () => {
    calls++;
    return json({}, 200, { "X-RateLimit-Bucket": "same", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "60" });
  });
  await api.request(`/channels/${C}/messages`);
  await assert.rejects(api.request(`/channels/${C}/messages?limit=100`), (e) => e.code === "throttled");
  assert.equal(calls, 1);
  const local = new DiscordHttp(randomUUID(), async (url) => url.includes("/messages")
    ? json({ retry_after: 60, global: false }, 429) : json({}));
  await assert.rejects(local.request(`/channels/${C}/messages`), /rate limit/);
  await local.request("/users/@me");
});

test("timeout and pre-abort are bounded even for a noncooperative fetch, with no automatic POST retries", async () => {
  let calls = 0;
  const api = new DiscordHttp(randomUUID(), () => { calls++; return new Promise(() => {}); }, 20);
  // AbortSignal.timeout does not keep the event loop alive by itself.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(api.request(`/channels/${C}/messages`, undefined, { content: "x" }), (e) => e.reason === "delivery_unknown");
    assert.equal(calls, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(api.request("/users/@me", controller.signal));
    assert.equal(calls, 1);
  } finally { clearInterval(keepAlive); }
});
