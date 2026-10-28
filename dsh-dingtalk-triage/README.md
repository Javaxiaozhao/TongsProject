# dsh-dingtalk-triage

钉钉群/单聊 @机器人 → 按项目目录开主会话排查 → 回复并 @提问人。

## 它做什么

- 钉钉 Stream 模式接入（WebSocket，**不需要公网 IP**）
- 一个群/一个单聊绑定一个项目目录，会话 cwd 就是该目录，并在侧边栏归到该项目的工作区
- **话题判定**：与上一条问题相似度高就续聊（追问带上下文），低就另开会话
- **链路库**：首次启动自动生成空索引，每次排查结束由会话自己沉淀；下次先匹配，命中走最短路径
- **取数执行器**：链路里写好的模板 SQL 由插件执行，模型不碰口径；提问人显式指定口径时以提问人为准
- 图片入站、`/new` 换话题、超时兜底、会话被删/归档后自愈、单实例防抢占

## 前置条件

- DeepSeek Harness `0.2.x`（桌面端 0.11.x 自带）
- Node `>=22`
- 钉钉**企业内部应用**，且机器人接收模式 = Stream

## 一、安装

```bash
# 1. 放到任意目录，装依赖（只为一个 SDK）
npm install
```

2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加一段（照 `example/cordis.patch.yml` 改）：

```yaml
- insert:
    - id: dingtalk-triage
      name: 'file:///C:/你的路径/dsh-dingtalk-triage/index.js'
      config:
        enabled: true
        clientId: '钉钉 Client ID'
        clientSecret: '钉钉 Client Secret'
        dataDir: 'C:\你的数据目录\dingtalk-triage'
        selfBaseUrl: 'http://127.0.0.1:你的web端口'
```

3. 重启一次桌面端（首装需要；之后改配置热生效）。

## 二、钉钉侧（最容易卡在这里）

1. <https://open-dev.dingtalk.com/> → 应用开发 → **企业内部应用** → 创建应用
2. 添加应用能力 → **机器人** → 接收模式选 **Stream 模式**（不是 HTTP 回调）
3. 权限管理：开机器人消息相关权限
4. 版本管理与发布 → 创建版本 → **可见范围必须包含要拉群的同事** → 发布 → 管理员审批
5. 凭证与基础信息 → 复制 **Client ID / Client Secret**
6. 钉钉客户端 → 群设置 → 群机器人 → 添加该应用机器人
7. 群里 @机器人 发一句话，到 `/dingtalk-triage/status` 的 `recent` 里复制 `conversationId`，填进 `routes`

> 第 4 步没做，机器人就搜不到；改了能力/权限必须**重新创建版本并发布**。

## 三、配置字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `enabled` | 是 | 关着完全不启动 |
| `clientId` / `clientSecret` | 是 | 钉钉应用凭据 |
| `dataDir` | 是 | 放 `bindings.json`、日志、`playbooks/` |
| `selfBaseUrl` | 是 | 本机 web 地址，`/dbquery`、`/playbook` 都用它 |
| `projectRoots` | 二选一 | 扫描根；根下每个非点号子目录 = 一个项目（目录名=项目名） |
| `projects` | 二选一 | 手工补充/覆盖，同名优先 |
| `routes` | 是 | `conversationId`（群）/ `senderStaffId` 或 `senderNick`（单聊）→ `project` |
| `excludedProjects` | 否 | 按目录名排除，如 `315` |
| `envSkills` | 否 | 项目 → 环境 skill 名列表，如 `[xxx-production, xxx-test-connect]` |
| `databases` | 否 | 项目 → `{host, port, user, database, passwordFile}`，`passwordFile` 存密码，**不要写进配置** |
| `pythonPath` | 否 | 默认 `python`；用于只读查询 |
| `topicThreshold` | 否 | 话题切换阈值，默认 0.5；切太碎就调低 |
| `replyFormat` / `ackText` / `atReplier` / `turnTimeoutMs` | 否 | 回复形态 |

## 四、首次验证

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 连接 | `GET /dingtalk-triage/status` | `stream.connected=true`，路由数量正确 |
| 管道 | `GET /dingtalk-triage/selftest?text=只回复好&conversationId=selftest-group` | `lastTurn.ok=true`（需先在 routes 里绑 `selftest-group`） |
| 数据库 | `GET /dingtalk-triage/dbquery?project=xxx&op=ping` | `reachable=true` |
| 数据库 | `GET /dingtalk-triage/dbquery?project=xxx&op=select&sql=SELECT 1 LIMIT 1` | 返回 rows |
| 链路库 | `GET /dingtalk-triage/playbook?op=list` | 列出条目，带 `hasSql` 标记 |
| 会话事件 | `GET /dingtalk-triage/inspect?session=<id>&tail=20` | 排查卡住时用，能看到进了哪一步 |

## 五、链路库（插件最有价值的部分）

- 位置：`<dataDir>/playbooks/`，首次启动生成 `INDEX.md` + `TEMPLATE.md`
- 每条是一个 `.md`，结构固定；**可选的机器可读段**放在文件最前面：

```yaml
symptom: 今天多少单、有效订单数量、某天订单量
sql: SELECT COUNT(*) FROM db.`order` WHERE create_time >= {{date}} AND is_deleted=0 LIMIT 5
params: date
```

- 带 `sql` 的条目：命中后由插件**逐字执行**，模型只负责措辞，口径改不了
- 只有文字的条目：注入「最短路径 / 判读规则 / 不要走的路」，模型按步骤排查
- 命中多条（症状相近）时只给候选，不预执行，避免「跑错 SQL 给出像真的数字」
- 从空开始，第一次排查结束自动写第一条；沉淀越多越快，**单次成本不变**（只注入命中的那一条）

## 六、会话与话题

| 情形 | 行为 |
| --- | --- |
| 与上一条问题相似度 ≥ `topicThreshold` | 留在同一会话（带上下文，这叫追问） |
| 相似度低且不是指代式短句 | **另开会话**（同一项目、同一工作区） |
| 带「那/这/它/还有/再/继续…」且 ≤30 字 | 视为追问 |
| 发 `/new` | 强制清绑定，下一条开新会话 |

判定结果写进日志（`topic/new-session` / `topic/continue` 带 score 和前后两句原文），阈值可调。

## 七、已知限制

- 只支持文字与图片；文件/视频回「暂不支持」
- 一个应用一个机器人，不支持多账号
- 同一入口串行处理；不同入口并行
- 回复取本轮最后一条 assistant 文本
- 热重载会中断正在跑的那一轮（会回「本轮没跑完：aborted」，重发即可）

## 排障

见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。
