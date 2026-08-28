# 只此一间

> 把两个人的日常存进同一个房间 —— 只此一间。

**「只此一间」**：两个人的日常记忆，存在同一间房里。你随时记下当下（一句话 / 一张图 / 一段语音），我打开就能看到，还能按人、按主题、按时间翻找。

> 名字是占位的，随时可改。
>
> 原则：不推送、不打扰，**只有打开时才在**。

---

## 架构：一个 DSH 插件 = 整个应用

没有独立后端进程、没有端口。整个应用是一个 **DSH Cordis 插件**，自包含：

```
┌─────────────────────────────────────────────────────────────┐
│  DSH 宿主进程（Node.js）                                       │
│                                                             │
│  ┌─────────────────────────── 插件（本仓库）────────────────┐ │
│  │  host half (index.js)                                     │ │
│  │  · node:sqlite 数据库（rooms/memories/settings/vectors）  │ │
│  │  · 业务逻辑（lib/repo/*）                                 │ │
│  │  · AI 网关（lib/ai/gateway.js：chat/embed/transcribe）    │ │
│  │  · 向量库（lib/ai/vector.js：余弦相似）                   │ │
│  │  · 媒体存储（<dataDir>/media/<room>/…）                  │ │
│  │                                                          │ │
│  │  暴露两条受信任路由：                                      │ │
│  │   · POST /only-room/api      （RPC：全部数据操作）         │ │
│  │   · GET  /only-room/media/*  （媒体文件）                 │ │
│  └──────────────────────────────────────────────────────────┘ │
│                          ▲                                   │
│  ┌────────────────────────┴─────────────────────────────────┐ │
│  │  client half (client/client.js)                          │ │
│  │  settings → "只此一间" 面板：                              │ │
│  │  快速记录 / 最近记忆 / 房间与绑定 / AI 配置 / 主题 / 导出  │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
        │  浏览器（DSH 设置页）通过同源 fetch 调 RPC
        │  任意客户端（Web/小程序/App）也可按同一 RPC 契约接入
```

- **插件即应用**：数据层（`node:sqlite`）、业务逻辑、AI 网关、媒体存储全在 host half 里，进程内运行，零外部依赖（仅 `schemastery` 做配置校验）。
- **AI 按需调用**：AI 网关不常驻；聊天/嵌入/转写在调用时才连本地（Ollama / LM Studio）或远端（任意 OpenAI 兼容 `/v1`）。**没配 AI 也能用**——纯存储 + 时间线 + 全文搜索。
- **客户端可插拔**：DSH 面板是当前的客户端；Web/小程序/App 可按同一 RPC 契约接入，**后端与接口保持稳定**。

> 设计目标：把"后端进程 + 端口 + 隧道"这一整套运维负担，收敛成一个 DSH 插件。打开 DSH 就在，关 DSH 就停，数据落在稳定目录。

---

## 安装

```powershell
dsh plugin --profile web add github:spicycorn/Only-this-one-room
```

一条命令完成拉取 + 安装 + 依赖解析。安装后重启 DSH，进入 **设置 → 只此一间** 即可使用。

> 插件加载即"启动"——没有后端要 spawn，没有端口要等。

### 首次使用

1. 在「房间与绑定」里点「创建房间」，生成一个房间 Token（`api_token`）。
2. 把 Token 发给你的另一半，在 TA 的设备上填入（同一界面），即绑定进房。
3. 在「快速记录」里记一条；在「AI 配置」里填 provider（可选，不填则纯存储）。

### 从本地目录安装（开发 / 调试）

```powershell
dsh plugin --profile web add <path-to-plugin-dir>
```

### 卸载

```powershell
dsh plugin --profile web remove only-room-admin
```

> 卸载只移除插件本身；数据目录（`~/.dsh/only-room/`：SQLite + 媒体）不受影响，重装即恢复。

---

## RPC 接口（客户端契约）

所有数据操作都走一条 RPC 路由 `POST /only-room/api`，请求体 `{action, params}`，响应统一 `{ok, value}` 或 `{ok:false, error:{status,message}}`。**这是给客户端的唯一契约**——DSH 面板、Web 站、小程序都按它接入。

| 请求头 | 含义 |
| --- | --- |
| `host`（loopback）+ 非 cross-site | 信任栅栏：只接受 DSH 同源请求，其余 403 |
| `params.token` | 房间 Token（`rooms.create` 生成，房主发给成员）。数据读写都校验它。 |
| `params.client_id` | 客户端稳定匿名 ID（设备级，客户端生成并持久化）。首次 `rooms.bind` 进房成员。 |

### 房间与绑定

| action | 说明 |
| --- | --- |
| `rooms.create` | 创建房间，返回 `api_token`（一次性披露，供分享） |
| `rooms.my` | 当前 `client_id` 所在房间 |
| `rooms.bind` | 用 `token` 把 `client_id` 绑定为成员（自动建用户） |
| `rooms.members` | 成员列表（昵称/角色） |
| `rooms.get` / `rooms.update` | 房间信息 / 更新名称、纪念日 |

### 记忆

| action | 说明 |
| --- | --- |
| `memories.create` | 创建（`content_type`: text/voice/image，`text`/`transcript`/`media_path`） |
| `memories.list` | 列表（分页 + 按类型过滤） |
| `memories.get` | 详情 |
| `memories.update` | 更新（改文字/转写/类型） |
| `memories.delete` | 删除（连带媒体文件） |
| `memories.upload` | 上传媒体（base64），返回 `media_path` |

### 搜索

| action | 说明 |
| --- | --- |
| `search.text` | 全文搜索（LIKE，无需 AI） |
| `search.semantic` | 语义搜索（需配 embed；未配/不可用 → 502 "AI 服务不可用"） |
| `search.related` | 某条记忆的关联推荐 |

### AI 配置（DSH 格式）

| action | 说明 |
| --- | --- |
| `settings.get` | 取房间主题 + AI 开关 + AI 配置 |
| `settings.updateAi` | 更新 AI 配置（`providers.<name>.{baseURL,apiKey,api,models[]}` + `select.{chat,embed,transcribe}.{provider,model}`） |
| `settings.testChat` / `settings.testEmbed` | 测试连通（失败 → 502） |
| `settings.models` | 列出 provider 的可用模型 |
| `settings.toggleAi` | AI 总开关（关掉 = 纯存储 + 时间线） |
| `settings.updateTheme` | 房间主题（预设/主色/背景图/tabbar 图标） |

### 用户 / 素材 / 时刻 / 导出

| action | 说明 |
| --- | --- |
| `users.get` / `users.update` / `users.avatar` | 当前用户资料（昵称/头像） |
| `theme.upload` / `theme.delete` | 背景图 / tabbar 图标上传删除 |
| `moments.get` | AI 主动时刻（纪念日/生日/周年/沉默提醒，打开时算，不推送） |
| `export.json` / `export.zip` | 导出结构化 JSON / 完整备份（SQLite + 媒体） |

> 精确字段 shape 以 `lib/repo/*` 代码为准；上表是**能力面**速查。

---

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `config.dataDir`（插件 config） | `~/.dsh/only-room/` | 数据根（SQLite + 媒体）。 |
| `ONLY_ROOM_DATA_DIR` | — | 环境变量覆盖数据根。 |

> 无端口、无监听地址。数据落在稳定目录，换机器 = 拷这个目录。

---

## 安全模型

- **无端口**：没有 `127.0.0.1:8000`，没有外网暴露面。
- **信任栅栏**：`/only-room/api` 只接受 DSH 同源请求（loopback host + `sec-fetch-site` 非 cross-site），其余 403——见 `index.js` 的 `isTrustedApiRequest`。
- **房间级 Token**：数据读写都校验 `token`（`rooms.create` 生成）。
- **设备级身份**：`client_id` 是客户端生成并持久化的稳定匿名 ID（无需登录），经 `rooms.bind` 关联进房间成员。
- **路径安全**：媒体路径白名单（扩展名 + 目录遍历防护）。

---

## 目录结构

```
Only-this-one-room/           ← 仓库根 = 插件包（dsh plugin --profile web add github:spicycorn/Only-this-one-room）
├── index.js                  # host half：apply() + RPC 分发 + 媒体路由 + 信任栅栏
├── client/client.js          # client half：settings → 只此一间 面板
├── lib/
│   ├── db.js                 # node:sqlite 连接 + schema
│   ├── errors.js             # AppError（携带 HTTP 状态）
│   ├── ai/gateway.js         # AI 网关（chat/embed/transcribe）
│   ├── ai/vector.js          # 向量库（余弦相似）
│   └── repo/                 # 业务逻辑：rooms/memories/moments/search/settings/users/export
├── cordis.patch.yml          # dsh.bundle.patch 声明
├── package.json              # 插件清单
├── docs/产品设计.md           # 设计源
├── README.md
└── .gitignore
```

---

## 路线图

- [x] 业务逻辑全部移植到 host half（node:sqlite + 内存向量库）
- [x] AI 网关（DSH 配置形态，按需调用，未配可降级）
- [x] host 半端到端验证（31/31 全绿）
- [x] client 半重构（全 RPC + 独立 AI 配置窗口）
- [x] 删 Python 后端（`backend/` + `deploy/`）
- [ ] 语音输入（`memories.create` 已留 `voice` + `transcribe` 能力；客户端待接录音）
- [ ] 可选：Web 站 / 小程序客户端（按 RPC 契约接入，独立仓库或子目录）

> 客户端可插拔：DSH 面板是今天的客户端；Web/小程序是未来的可选客户端。应用与接口保持稳定。

---

## License

TBD（两人内部项目，默认私有）。
