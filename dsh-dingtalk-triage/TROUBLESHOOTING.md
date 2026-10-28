# 排障（按新人实际会撞上的顺序排）

> 每节标题就是你在界面上看到的原文，`Ctrl+F` 搜症状即可。

---

## 1. 群里搜不到这个机器人 / 加不进群

**钉钉侧没发布好，和插件无关。** 依次核对：

- 「版本管理与发布」是否**创建并通过**了版本（只保存不提交不算）
- 「可见范围」是否包含你本人和要拉群的同事
- 改了机器人能力或权限后，是否**重新创建版本并发布**

搜不到时控制台不会有任何报错，这是最耗时的一步，先排除它。

---

## 2. 机器人加进群了，@ 它完全没反应

1. `/dingtalk-triage/status` → `stream.connected` 必须是 `true`
2. 日志里有没有 `stream/inbound`：
   - **没有** → 消息没到。多半是机器人接收模式选成了 **HTTP 回调**（必须 Stream），或机器人没在这个群
   - **有 `inbound/mention-gate`** → 没 @ 到（或 `isInAtList` 缺失且正文不含 @）
   - **有 `inbound/unrouted`** → 见下一条

---

## 3. 回了「这个群还没绑定项目…」

`routes` 里没有这个 `conversationId`。

去 `/dingtalk-triage/status?refresh=1` 的 `recent[0]` 抄真实 `conversationId`，填进 `routes`，保存即生效（不用重启），再 @ 一次。

---

## 4. 回复里出现两个 `@你`

钉钉 markdown 的原生提醒要求正文带 `@+userId` 占位**并且**给 `at.atUserIds`。插件发送前会剥掉模型自己写的前缀再统一加一次；出现两个说明模型在正文中间又写了称呼。

检查 prompt 是否包含「不要写提问人姓名或称呼」这条（v24 起内置）。

---

## 5. 回了「这轮排查没跑完：blocked」

那条会话被**归档或删除**了，`agent/pre-step` 门禁直接拦死。判别证据：`/inspect?session=<id>&tail=20` 里只有 `turn/start → turn/end{blocked}`，**没有 `step/start`**。

v25 起会自动清绑定并重建一次；仍失败就发 `/new`。

---

## 6. 回了「session.create accepts workspaceId or cwd, not both」

建会话时两个参数都给了。v25 起改为「有工作区只给 workspaceId，否则给 cwd」，升级即可。

---

## 7. 数字不对 / 口径不是我说的那个

先分清这一单用的是哪一级口径：

| 优先级 | 口径来源 | 判据 |
| --- | --- | --- |
| 1 | **提问人显式指定**（「所有订单」「不排除取消」「只要已确认」） | 回复里应注明「口径为提问人指定」 |
| 2 | 链路库默认（`jindi-order-count` 排除 取消/预占/预占取消/未完成） | 回复给出四段：结论/数据源/时点/口径 |
| 3 | 模型自己推导 | 应注明「口径为本次查证」，这种要警惕 |

如果它套用了链路库口径、而你明确要了别的口径 → 直接说「按 X 口径重算」。规则已写进 prompt（v25）：**提问人显式口径 > 链路库默认 > 自己推导**。

---

## 8. 收到「收到，开始排查」后很久没下文

1. `/status` 看 `inflight`：持续为 1 表示还在跑（大排查十几分钟正常，上限 `turnTimeoutMs`）
2. `/inspect?session=<id>&tail=30` 看最后事件：
   - 大量 `grep`/`read`/`pwsh` 且没有 `playbook` 调用 → 它在重新发明查询方式，说明链路库没命中
   - 卡在 `tool/call` 同一条上反复 → 工具或连接有问题
3. 日志 `turn/failed` 会带 error 与 stack

想让它快：把这条排查沉淀成带 `sql:` 的链路（见 README 第五节），下次直接命中。

---

## 9. 同一句话回了两次 / 回了旧配置的错误

热重载没 dispose 旧实例，旧实例仍连着同一条 Stream，消息被它抢走（它内存里是旧路由，于是回「未绑定」）。

v25 起用 `globalThis` 做进程级单例，新实例会先断开旧连接（日志出现 `stream/previous-closed`）。**历史遗留连接只能重启进程清掉。**

---

## 10. 改了 index.js 不生效

Harness 按「**行 id + 文件路径**」缓存模块，只改文件内容不会重新 import。

- 正式：重启桌面端
- 开发期：同时换**新行 id** 和**新文件名**（本插件就是这么滚到 v25 的）

---

## 11. `/dbquery` 报错

| 报错 | 原因 |
| --- | --- |
| `缺 passwordFile` | 密码只放文件：把绝对路径填进 `databases.<项目>.passwordFile` |
| `没有这个项目的数据库配置` | `databases` 里没这个 key |
| `只允许 SELECT / SHOW` / `SQL 必须自带 LIMIT` | 门禁生效，改写 SQL |
| `No module named pymysql` | 配置的 `pythonPath` 那个解释器没装 pymysql |
| `取 accessToken 失败` | 这条只影响图片下载；查凭据 `clientId/clientSecret` |

---

## 12. 网页端冒出一堆没见过的会话

多半是自检建的：`/selftest` 每调一次就是一轮真实会话（名称带「自检」）。直接删掉即可，不影响绑定以外的任何状态。
