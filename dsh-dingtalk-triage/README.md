# dsh-dingtalk-triage

钉钉群 @机器人 → 项目绑定主会话 → 按 `project-ops-triage` 流程排查 → 回复发回群。

自研最小实现，只做一件事：把钉钉的「群 + @ + 文字」搬进一个绑定到项目目录的常驻 Harness 主会话，再把这一轮的最终回答搬回群。

## 它做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 接收钉钉 Stream 模式机器人消息（WebSocket，不需要公网 IP） | 不实现拆证据面、开子会话、判断根因——那是主会话按 skill 自己干的活 |
| 一个群固定绑定一个项目目录，会话 cwd 就是那个目录 | 不做工单读写、不连数据库、不发 DING、不做审批 |
| 群里只处理 `@机器人` 的消息 | 不支持图片/文件（会直接回「只处理文字提问」） |
| 主会话这一轮的最终 assistant 文本原样发回群 | 不转发中间过程、不发工具调用细节 |

## 数据流

```
钉钉群 @机器人
   └─ Stream WebSocket（dingtalk-stream 2.1.5）
        └─ 本插件：去重 / @ 门禁 / 群→项目解析
             └─ sessionController.create(cwd=项目目录)   ← 首次
             └─ sessionController.prompt(角色指令 + 群消息)
                  └─ 主会话按 project-ops-triage 拆子会话排查
             └─ sessionController.follow(...) 收集本轮 turn/end 前的最后一条 assistant 文本
        └─ POST sessionWebhook（markdown / text）
   └─ 群里看到回复
```

## 一、钉钉侧准备（一次性）

> 控制台措辞会随平台版本变化，以你看到的实际界面为准；下面是必经的五个环节。

1. **建应用**：用企业管理员账号打开 <https://open-dev.dingtalk.com/>，「应用开发 → 企业内部应用 → 创建应用」。
2. **加机器人能力**：进入应用 →「添加应用能力 → 机器人」，机器人**消息接收模式选「Stream 模式」**（选 HTTP 回调就需要公网地址，本插件不支持）。
3. **开权限**：在「权限管理」里按控制台提示开通机器人消息相关权限即可；回复走 `sessionWebhook`，不需要额外的主动发消息权限。
4. **发布版本**：「版本管理与发布 → 创建版本」，**可见范围必须包含要拉群的成员/部门**，提交后由管理员审批通过。未发布或不在可见范围内的机器人加不进群。
5. **取凭据**：「凭证与基础信息」里拿 **Client ID（AppKey）** 和 **Client Secret（AppSecret）**。

然后：

6. 在目标群的「群设置 → 群机器人 → 添加机器人」里选中这个自建应用机器人。
7. 群里 @机器人 发一句任意文字，看插件日志里的 `stream/inbound` 行，拿到这个群的 `conversationId`，填进下面的 `groups`。

## 二、DSH 侧配置

配置写在 profile 的补丁层 `$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: dingtalk-triage-bridge
      name: 'file:///C:/Users/you/.dsh/plugins/dsh-dingtalk-triage/index.js'
      config:
        enabled: true
        clientId: 'ding你的ClientID'
        clientSecret: '你的ClientSecret'
        dataDir: 'C:\Users\you\.dsh\data\dingtalk-triage'
        requireMention: true
        replyFormat: markdown
        # 项目不写死：扫这些根目录，每个非点号子目录就是一个项目（目录名=项目名）
        projectRoots:
          - 'D:\code'
        excludedProjects:
          - '315'
        routes:
          # 群：按 conversationId
          - conversationId: 'cid金地运营群=='
            project: jindi
            label: 金地运营群
          # 单聊：按 senderStaffId（最稳）或 senderNick
          - senderNick: 乐君兰
            project: jindi
            label: 乐君兰单聊
          - senderNick: 周贝
            project: jindi
            label: 周贝单聊
          - senderNick: 谭圆圆
            project: jindi
            label: 谭圆圆单聊
```

**怎么把真实的 id 抄出来**：把人拉进群/先给机器人发一条消息，然后打开 `http://127.0.0.1:43129/dingtalk-triage/status`，看 `recent` 数组——每条都带 `conversationId`、`senderStaffId`、`senderNick`、`matchedBy`，复制进 `routes` 即可。日志 `stream/inbound` 行里也有同样的字段。

**匹配顺序**：群只认 `conversationId`（不兜底，避免串项目）；单聊依次认 `senderStaffId` → `senderNick` → `conversationId` → `defaultProject`。昵称会改的话尽量用 `senderStaffId`。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 关着就完全不启动，连路由都不注册 |
| `clientId` / `clientSecret` | 空 | 钉钉应用凭据；任一为空则跳过连接，只保留自检路由 |
| `dataDir` | 必须显式给 | 放 `bindings.json`（群→会话）和 `dingtalk-triage.log` |
| `requireMention` | `true` | 群里必须 @机器人。字段缺失时会退回「文本里带 @」的判定 |
| `replyFormat` | `markdown` | `markdown` 或 `text`；群不支持 markdown 时改 `text` |
| `ackText` | `收到，开始排查。` | 收到后立刻回的一句；留空则不回 |
| `atReplier` | `true` | 回复时 @提问人 |
| `turnTimeoutMs` | 15 分钟 | 一轮超过就取消并回报超时 |
| `maxReplyChars` | 3800 | 单条上限，超长按段落切分多条发 |
| `projects` | `[]` | `name` + `cwd`（+ 可选 `agentPreset`） |
| `projectRoots` | `[]` | 扫描根；根下每个非点号子目录自动成为一个项目（目录名=项目名，cwd=该目录） |
| `excludedProjects` | `[]` | 按目录名精确排除，如 `['315']` |
| `projectMarkers` | `[]` | 非空时只保留含这些标记文件的目录，如 `['.git','pom.xml']` |
| `projects` | `[]` | 手工补充/覆盖，同名优先于扫描结果 |
| `routes` | `[]` | 入口 → 项目：`conversationId`（群）/ `senderStaffId` / `senderNick`（单聊），配 `project` 和 `label` |
| `defaultProject` | 空 | 只给单聊兜底用；群里不生效，避免消息串项目 |
| `newCommand` | `/new` | 清掉当前会话、下一条开新会话（换话题用） |
| `allowedStaffIds` | `[]` | 非空时只处理这些人的消息 |
| `selftest` | `true` | 注册 `/dingtalk-triage/*` 自检路由 |

### 项目自动发现

`projectRoots` 下每个非点号子目录就是一个项目，**目录名就是 `routes` 里要写的项目名**：

```
D:\code
├─ jindi      → 项目 jindi（单仓，有 .git）
├─ fesco      → 项目 fesco（多仓集合目录，照样当一个项目用，主会话自己进去找）
└─ 315        → 在 excludedProjects 里排掉
```

不用再维护 `projects` 列表。加新仓库只要目录在扫描根下，`/dingtalk-triage/status?refresh=1` 就能看到（启动时也会自动扫一次）。
手工 `projects` 仍然保留，用来给扫描根之外的目录起别名，或覆盖同名项。

### 改完配置怎么生效

profile 补丁层是热加载的：保存 `cordis.patch.yml` 后几秒内自动重载，**改配置不用重启**。

改 `index.js` 里的**代码**则需要重启桌面端——Harness 的模块缓存按「行 id + 文件路径」固化，只改文件内容不会重新 import。想不重启迭代，得同时换一个新的行 id 和新的文件名（本插件开发期就是从 v2 一路滚到 v6 的）。

## 三、自检与排障

不需要钉钉凭据也能验证整条链路：

```powershell
# 状态：连没连上、群映射、群→会话绑定、上一轮结果
curl http://127.0.0.1:43129/dingtalk-triage/status

# 干跑一轮：建会话 → prompt → 收集回答（走本地日志，不发钉钉）
curl "http://127.0.0.1:43129/dingtalk-triage/selftest?plain=1&conversationId=selftest-group&text=只回复两个字：通过"

# plain=0 走真实 triage 角色指令（会加载 skill）
```

- `plain=1` 只验证管道，`plain=0` 验证角色与 skill。
- 日志：`<dataDir>/dingtalk-triage.log`，每行一个事件（`boot` / `stream/inbound` / `session/created` / `turn/done` / `turn/failed` / `sink/local`）。
- 绑定：`<dataDir>/bindings.json`，删掉某个群那一行就等于让它下次重新开会话。

常见现象：

| 现象 | 原因 |
|---|---|
| 群里 @ 了没反应 | `enabled` 为 false、凭据空、群没进 `groups`、或没 @（看日志 `inbound/mention-gate` / `inbound/unbound-group`） |
| 回了「这个群还没绑定项目」 | 该 `conversationId` 不在 `groups` 里 |
| 回了「单轮排查没跑完」 | 看同时间 `turn/failed` 行的 error 与 stack |
| 网页端看不到会话 | 会话 cwd 是项目目录，按目录分组在侧边栏，可能被折叠 |

## 四、追问与记忆

追问要有记忆，靠两层，少一层都会出问题：

**第一层：会话复用（插件负责）**

- 绑定键：群 `g:<conversationId>`，单聊 `d:<senderStaffId|senderNick>`。
- 同一个键永远复用同一个 Harness 会话，追问直接进原会话，上下文天然连续；绑定写在 `<dataDir>/bindings.json`，重启桌面端也不丢。
- 一个人无论从手机还是电脑私聊，`senderStaffId` 不变 → 还是同一个主会话。
- 想换话题：发 `/new`，绑定被清掉，下一条消息开新会话（项目绑定不变）。

**第二层：案子续查（prompt 约束）**

光有会话上下文不够——模型很容易把追问当成新问题、从头再查一遍。所以非首轮 prompt 里明确写了：

- 对已有问题的追问/补充 → 沿用之前为该案子开的子会话（continuable id 续聊），只补缺口，不重开一套；
- 换了问题 → 按新案子处理；
- 拿不准是追问还是新问题 → 先一句话向提问人确认，不自行假设。

**会话丢了怎么办**

主会话被人在网页端删掉时，插件会检测到 not-found，清掉绑定重建一次，并在 prompt 里明确告诉模型「上文已不在，若是追问先向提问人确认上次结论」——不假装记得，也不静默重开。

**边界**

一个群只有一个主会话，所以多人同时问不同问题时，上下文是共享的：主会话靠提问人身份 + 消息内容区分案子。如果哪天出现「A 的追问被 B 的问题串了」，正确的解法是给不同主题拆群，而不是给同一个群加多个会话。

## 五、已知限制

- 只处理 `text`；图片、文件、富文本一律回「只处理文字提问」。
- 一个应用一个机器人；不支持多账号。
- 群里串行处理（同一个群同一时刻只跑一轮），不同群之间并行。
- 主会话回答用最后一条 assistant 文本；如果模型把结论拆成多条消息，只发最后一条。
- 不做审批门禁：插件本身只读消息、只发文字，真正的变更审批仍由主会话按 skill 走 DING + 邮件。
