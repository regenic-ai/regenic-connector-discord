# Third-party notices

Dependencies are installed as separate npm packages, not copied into this source
tree or bundled into `dist`. Their licenses, copyright notices and native
dependency notices remain applicable. Retain the notices shipped with each
installed package when redistributing an installation.

| Package | Version | License | Source / notices |
|---|---|---|---|
| `@regenic/connector-contract` | 0.2.0 | MIT | https://github.com/regenic-ai/regenic/tree/main/packages/connector-contract |
| `@regenic/plugin-host` | 0.1.0 | MIT | https://github.com/regenic-ai/regenic/tree/main/packages/plugin-host |
| `@napi-rs/keyring` and platform binary packages | 2.1.2 | MIT | https://github.com/Brooooooklyn/keyring-node |
| `discord-api-types` | 0.38.49 | MIT | https://github.com/discordjs/discord-api-types |
| `zod` (contract dependency) | See lockfile | MIT | https://github.com/colinhacks/zod |
| `cordis` (host dependency) | See lockfile | MIT | https://github.com/cordiverse/cordis |
| `cosmokit` (host dependency) | See lockfile | MIT | https://github.com/shigma/cosmokit |
| `@standard-schema/spec` (host dependency) | See lockfile | MIT | https://github.com/standard-schema/standard-schema |

The keyring native binaries incorporate Rust dependencies and OS credential
interfaces. Consult the upstream keyring-node and
[keyring-rs](https://github.com/hwchen/keyring-rs) distributions for their full
native dependency/license notices; platform packages and their licenses must
remain alongside redistributed binaries.

Development tools: `@regenic/connector-test-utils` 0.1.0 (MIT), TypeScript 5.7.2
(Apache-2.0), `@types/node` 22.10.2 (MIT) and its `undici-types` dependency (MIT).
These tools are not bundled in the runtime package. Resolved dependency versions
and integrity values are recorded in `package-lock.json`.

Discord is a trademark of Discord Inc. This independently distributed connector
uses the Discord HTTP API; platform terms and developer policies apply.
