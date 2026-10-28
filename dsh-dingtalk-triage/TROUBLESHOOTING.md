# 排障

## 群里 @ 了没反应

按顺序查：

1. `/dingtalk-triage/status` → `stream.connected` 必须为 `true`；`false` 看日志 `stream/connect-failed`
2. 日志是否有 `stream/inbound`：没有 = 消息没到（接收模式不是 Stream、或机器人不在群里）
3. 有 `inbound/mention-gate` = 没 @ 到（或 `isInAtList` 缺失且文本不含 @）
4. 有 `inbound/unrouted` = 该 `conversationId` 不在 `routes` 里

## 回了「这个群还没绑定项目」

`routes` 里没有这个 `conversationId`。去 `/status` 的 `recent[0].conversationId` 抄真实值填上。

## 回了「这轮排查没跑完：blocked」

那条会话被归档/删除了，`agent/pre-step` 门禁直接拦死（事件里会看到 `turn/start → turn/end blocked`，没有 `step/start`）。
v25 起会自动清绑定并重建一次；仍失败就发 `/new`。

## 回了「参数错误：session.create accepts workspaceId or cwd, not both」

建会话时同时给了 `workspaceId` 和 `cwd`。v25 起已改为二选一，升级即可。

## 收到「收到，开始排查」后没有下文

1. `/status` 看 `inflight`：持续为 1 说明这轮还在跑（大排查可能十几分钟）
2. `/inspect?session=<id>&tail=30` 看最后事件：有没有 `tool/call`、有没有 `turn/end`
3. 日志 `turn/failed` 会带 error 与 stack

## 回帖里的 @ 不显示 / 显示两个

钉钉 markdown 的原生 @ 要求正文带 `@+userId` 占位并同时给 `at.atUserIds`。插件已内置：发送前会剥掉模型自己写的前缀，再统一加一次。若还是两个，说明模型在正文中间又写了 @，检查 prompt 的「禁止称呼」规则。

## 取数数字不对

先分清口径：

| 口径 | 10-28 示例 |
| --- | --- |
| 链路库默认（排除取消/预占/预占取消/未完成） | 259（当时值） |
| 提问人指定「所有订单」 | 392 |

优先级：**提问人显式口径 > 链路库默认 > 自己推导**。若回复里的口径与提问人不符，直接说「按 X 口径」并要求重算。

## `dbquery` 报「缺 passwordFile」

密码只放文件，不进配置。建一个文件写好密码，把绝对路径填进 `databases.<项目>.passwordFile`。

## 改了代码不生效

Harness 按「行 id + 文件路径」缓存模块：改 `index.js` 内容不会重新 import。

- 正式做法：重启桌面端
- 开发期：同时换**新的行 id**和**新的文件名**（本插件就是这么滚到 v25 的）

## 多个实例抢消息（同一句话回了两次 / 回了旧配置的错误）

热重载没 dispose 旧实例，旧实例仍连着 Stream。v25 起用 `globalThis` 做进程级单例，新实例会先断开旧连接（日志 `stream/previous-closed`）。
历史遗留连接只能靠重启进程清掉。
