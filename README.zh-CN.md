# Regenic Discord Bot 连接器

[English](README.md)

本地优先的 Regenic 外部连接器，以官方 Bot 身份轮询 Discord REST API v10，
同步明确选定的服务器文本频道、已有线程，以及手动添加的、用户已主动发起的
Bot 私信，并以 Bot 身份发送文本。它不是个人账号完整收件箱。
本包不启动 Gateway、云中继、遥测或常驻后台服务。

## 运行条件

- Node.js **22.12 或更新版本**、npm，以及支持连接器协议 `1.0` 和
  `@regenic/connector-contract@0.2.0` 安装生命周期钩子的 Regenic 宿主。
- Discord 应用的官方 Bot token，以及访问所选会话的权限。
- 可用的系统凭据库：macOS Keychain、Windows Credential Manager，
  或已解锁的 Linux Secret Service 会话。Linux 明确固定使用 Secret Service，
  不退回易失的内核 keyring。系统凭据服务不可用或被锁定时明确报错，
  不降级为明文 token 文件。

## 创建和授权 Bot

1. 在 [Discord Developer Portal](https://discord.com/developers/applications)
   创建应用，进入 **Bot** 获取 token 并妥善保管。服务器历史需要开启
   **Message Content Intent**；需验证的应用还必须按 Discord 要求获得批准。
   REST 数据同样受此特权 intent 限制，不需要 Members 或 Presence intent。
2. 在 **OAuth2 / URL Generator** 选择 **bot** scope，邀请到你有权安装应用的
   服务器。仅在目标频道授予 **View Channel**、**Read Message History**、
   **Send Messages**，线程回复另需 **Send Messages in Threads**。
   不授予 Administrator 或 Manage Threads。私有线程，以及任何需要发送的线程，
   都要求 Bot 已经是成员。
3. 在 Discord 开启 **Developer Mode**，复制服务器、频道、线程 ID。
   私信必须由用户先在 Discord 中主动发给此 Bot，再复制该已有一对一私信的
   **频道 ID**，不是用户 ID。本连接器不发现或创建私信，拒绝群私信和其他 Bot 的私信。

## 构建和加载

```sh
npm ci
npm run build
```

在 Regenic 宿主环境中把 `REGENIC_CHANNEL_PLUGIN` 设为**本包构建目录的绝对路径**，
然后启动或重启宿主。路径由操作者提供，不依赖其他仓库或 monorepo。
本包提供同步 CommonJS 入口，声明
`regenic.contributes.drivers: ["discordDriver"]`。

也可通过 `npm pack` 创建本地 tarball，将其中 `package/` 的内容解压到
`~/.regenic/plugins`（或 `REGENIC_PLUGIN_DIR`）的一个子目录，
在该解压目录内执行 `npm install --omit=dev`。子目录的顶层必须直接有本包
`package.json`，不能仅将它装进嵌套的 `node_modules`。
通过宿主已认证的 `POST /v1/me/plugins/reload` 或重启发现插件。
已加载的 driver 不会被热替换，修改代码后需重启。

在 **Engine** 添加 **Discord Bot**，配置仅包含 ID：

| 字段 | 含义 |
|---|---|
| `guild_ids` | 目录允许列出可读文本频道及活跃线程的服务器。 |
| `channel_ids` | 明确允许同步和发送的文本频道 / 已有线程 ID，其服务器必须在 `guild_ids` 中。 |
| `dm_channel_ids` | 用户已发起、已有的一对一私信频道 ID，手动添加。 |

表单接受逗号分隔的十进制字符串，宿主 API 也可传字符串数组。
Discord ID 不可转为 JavaScript Number。空选择不采集消息。
目录只提供元数据，不等于允许采集；打开或同步目录项前，
该 ID 还须在安装的频道/私信允许列表内。编辑安装加入所需 ID，
再在 Engine 中选定并打开会话。仅加载插件或查看目录卡片不会安装或连接 Bot。

创建安装后复制安装 ID，在交互式终端运行：

```sh
node dist/cli.js token set INSTALLATION_ID
# 安装本包 bin 后也可以使用：
regenic-discord token set INSTALLATION_ID
```

在**隐藏输入提示**中输入 token。命令不从 argv、环境变量、普通配置、
stdin 管道或日志接收 token。系统凭据项使用 service `regenic-discord`、
account `INSTALLATION_ID:bot_token`，只在明确的运行操作中读取。
连接器不依赖可能在不同平台采用不同存储保证的宿主 secret 后端。

安装卡片和 probe 不访问网络，也不宣称凭据已验证。服务器、频道、线程和私信 ID
均由用户手动填写；连接器不会借用需要用户账号授权的接口枚举服务器。

更换 token 时先禁用安装，再运行 `token set`，然后重新启用。
`regenic-discord token remove INSTALLATION_ID` 仅删除本地凭据项，
不撤销远端 token；删除前也应先停止或禁用安装。

## 同步、发送与本地存储

- **轮询：** 宿主调度选定 stream，建议空闲间隔为 15 秒，每页最多 100 条。
  首次打开获取最近一页；历史使用 `before`；增量使用 `after`。
  `after` 满页时固定最近页上界，再向前翻页，全部到达旧下界后才推进实时检查点，
  不依赖 `after` 满页结果的排序假设。历史与实时位置独立。
- **持久化：** poll 返回的不透明游标由宿主与成功入库一起保存，重启后按游标恢复。
  来源 ID 为 `channel_id:message_id`，仅使用字符串/BigInt，
  重放依靠稳定来源身份去重。本连接器不保存私信 inbox 或正文缓存，
  已导入文本保存在宿主正常的本地存储中。
- **目录：** 每页一个配置的服务器，最后一页为明确添加的 DM。
  包含可读文本/公告频道和可访问的活跃线程。已知归档线程可手动加 ID，
  不全面抓取归档，不在目录枚举时读取聊天历史。
- **权限与正文：** 读历史前计算角色及频道覆盖权限，
  检查 View Channel、Read Message History；私有线程检查已有成员关系；
  服务器同步前验证应用的 Message Content 标志。
  没有任何可见载荷的普通空消息会明确报正文不可用，不推进游标，
  不单凭空正文断言缺 intent。合法的附件、嵌入、贴纸、交互内容消息，
  以及系统消息以明确占位文本和 Discord 链接呈现。
- **发送：** 仅发送非空 `text/plain` 正文，一条最多 2,000 个 UTF-16 code unit，
  不自动拆分或上传媒体。程序调用时设置
  `SendIntent.target.external_id = "channel_id:message_id"`
  可发送同频道原生回复；Engine 是否传递该引用取决于宿主 UI，
  文本引用仍是文本。所有发送明确禁用 everyone、here、角色、用户 mention
  解析及回复自动提醒。频道发送检查 Send Messages；线程检查
  Send Messages in Threads 和 Bot 已有成员关系。归档或锁定线程在此只读，
  不通过发送自动加入或取消归档。
- **发送结果安全：** 每次发送必须提供稳定 `idempotency_key`，
  在 POST **之前**刷盘持久化预留状态。由 key 派生的 25 字符 nonce 加
  `enforce_nonce: true` 还可使用 Discord 对**过去数分钟**的去重。
  本地已确认 receipt 可跨重启重放而不再 POST。网络错误、超时、不可解析的成功响应、
  结果不明确的服务器错误均保留为 **unknown**，不会自动重发同一操作，
  即使远端 nonce 窗口已过期。先检查 Discord，再明确创建新的发送操作。
  已确定拒绝的 key 也是终态，修正原因后创建新操作。
  这不构成永久 exactly-once 保证。
- **Outbox：** 安全元数据（操作/正文摘要、nonce、接受状态、远端消息 ID，
  不含正文或 token）保存在
  `~/.regenic/connectors/discord/outbox/<安装ID摘要>/`。
  POSIX 目录 `0700`、文件 `0600`，刷盘并原子替换。
  Windows 依赖用户目录文件系统 ACL；文件会刷盘，但不支持目录 fsync。
  应将宿主游标和这些元数据一起备份；删除元数据会失去重试保护。
  disable/delete/reconfigure/clear/shutdown 均保留此状态，不自动清理，
  仅在核对发送结果后由操作者有意删除。
- **生命周期和限流：** stop 取消本地在途请求、等待已接纳工作、
  释放 registry 并封锁旧引用，不登出、不撤销 token、不删远端数据。
  未完成或失败的 stop 不能被重新启用绕过。HTTP 含本地排队的期限为十秒，
  尊重调用方取消，每个客户端串行请求，按已学习的 bucket/global 头及
  `Retry-After` 冷却。429 明确背压，不静默重试任何 HTTP 请求，尤其是发送 POST。

## 限制与验证

不提供个人完整 DM 收件箱、DM 发现、创建会话/线程、自动加入、
编辑/删除跟踪、reaction、已读回执、成员同步、媒体下载/上传或 Gateway 实时投递。
已删除消息无法恢复，已导入消息之后的编辑不会刷新。
Discord 可用性、权限、平台政策和限流仍然适用，Bot 身份不代表零风险。

```sh
npm run typecheck
npm test
npm pack --dry-run --json
```

离线套件调用真实 **published** contract conformance helpers 和 plugin-host，
覆盖 manifest 同步加载、来源身份、目录/权限/分页、两种 `after` 满页顺序下的
历史与增量同步、重启/游标重放、DM 校验、原生引用、mention/nonce/unknown、
outbox 持久化和生命周期 fencing/取消/deadline。HTTP fixture 不访问 Discord
或真实系统凭据项。未使用真实 Discord 账号，未登录 Bot、读取真实历史、
发消息或连接 Gateway。各目标平台的系统凭据交互及实际部署仍需操作者授权验证。

官方接口参考：
[消息与 nonce](https://discord.com/developers/docs/resources/message)、
[频道与线程](https://discord.com/developers/docs/resources/channel)、
[权限](https://discord.com/developers/docs/topics/permissions)、
[Message Content](https://discord.com/developers/docs/events/gateway#message-content-intent)、
[限流](https://discord.com/developers/docs/topics/rate-limits)。

许可证：[MIT](LICENSE)。依赖声明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
