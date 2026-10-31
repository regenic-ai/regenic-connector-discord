const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtemp, rm, mkdir, symlink, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");
const { ChannelDriverError, isSupportedConnectorProtocol } = require("@regenic/connector-contract");
const { systemTokens } = require("../dist/secrets.js");
const { harness, message, sendIntent } = require("./fixtures.cjs");

test("real packed archive has only distributable files and is synchronously loadable by manifest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "regenic-discord-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], { encoding: "utf8" }))[0];
  const paths = result.files.map((file) => file.path);
  for (const required of ["package.json", "dist/index.js", "dist/index.d.ts", "dist/cli.js", "README.md", "README.zh-CN.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.equal(paths.includes(required), true, required);
  }
  assert.equal(paths.some((path) => /^(src|test|node_modules|\.inspect)\//.test(path)), false);
  execFileSync("tar", ["-xzf", join(root, result.filename), "-C", root]);
  // Use the actually installed published dependencies, not copied contract/host doubles.
  await symlink(join(process.cwd(), "node_modules"), join(root, "package", "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const manifest = JSON.parse(await readFile(join(root, "package/package.json"), "utf8"));
  const nodeRequire = createRequire(__filename);
  const entry = nodeRequire(join(root, "package"));
  assert.equal(manifest.regenic.plugin, true);
  assert.deepEqual(manifest.regenic.contributes.drivers, ["discordDriver"]);
  const driver = entry[manifest.regenic.contributes.drivers[0]];
  assert.equal(driver.connector_type, "discord");
  assert.equal(typeof driver.install, "function");
  assert.equal(isSupportedConnectorProtocol(driver.connector_protocol), true);
  assert.equal(driver.listCatalogFieldOptions, undefined);
  assert.equal(typeof driver.startInstallation, "function");
  assert.equal(typeof driver.stopInstallation, "function");
  assert.equal(entry instanceof Promise, false);
  const h = await harness(t, { createDriver: entry.createDiscordDriver });
  assert.equal(h.installation.connector_type, "discord");
  assert.equal((await h.driver.probeCatalog({ env: {} })).services.credentials.ready, false);
  assert.equal(h.fixture.calls.length, 0);
  await h.start();
  h.fixture.messages = [message(1)];
  const stream = await h.stream();
  assert.equal((await stream.connector.poll(null)).batch.records.length, 1);
  assert.equal((await (await h.sender()).send(sendIntent())).accepted, true);
});

test("published helper and driver use one contract instance for typed errors", () => {
  const utilsRequire = createRequire(require.resolve("@regenic/connector-test-utils"));
  assert.equal(utilsRequire("@regenic/connector-contract").ChannelDriverError, ChannelDriverError);
});

test("credential CLI does not echo invalid arguments or accept noninteractive tokens", () => {
  const marker = randomUUID();
  const invalid = spawnSync(process.execPath, ["dist/cli.js", "token", "set", "test-install", marker], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal((invalid.stdout + invalid.stderr).includes(marker), false);
  const piped = spawnSync(process.execPath, ["dist/cli.js", "token", "set", "test-install"], { input: marker, encoding: "utf8" });
  assert.equal(piped.status, 1);
  assert.equal((piped.stdout + piped.stderr).includes(marker), false);
  assert.match(piped.stderr, /interactive terminal/);
});

test("credential module exposes async OS backend and explicitly pins Linux Secret Service", async () => {
  const keyring = await import("@napi-rs/keyring");
  assert.equal(typeof keyring.AsyncEntry, "function");
  const source = await readFile(join(process.cwd(), "dist/secrets.js"), "utf8");
  assert.match(source, /store: "secret-service"/);
  assert.equal(source.includes("process.env"), false);
  // Invalid IDs fail before any keychain entry is opened.
  await assert.rejects(systemTokens.read("../invalid"), ChannelDriverError);
});
