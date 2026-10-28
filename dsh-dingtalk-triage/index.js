/**
 * dsh-dingtalk-triage
 *
 * 钉钉（Stream 模式）↔ DeepSeek Harness 的「运维排查主会话」桥。
 *
 * 路由模型（本次修订的重点）：
 * - 群：按 `conversationId` 绑定项目，一群一项目，显式配置，不做兜底。
 * - 单聊：优先按 `senderStaffId`，其次 `senderNick`，再兜底 `defaultProject`。
 *   同一个人无论从哪个入口私聊，都进同一个会话。
 * - 绑定键：群 `g:<conversationId>` / 单聊 `d:<staffId|nick>`。所以一个人
 *   换设备、换会话 ID 也还是同一个主会话。
 *
 * 追问记忆（两层，缺一不可）：
 * 1. 会话层：同键复用同一个 session，追问天然带上下文；绑定持久化到
 *    `<dataDir>/bindings.json`，重启不丢。
 * 2. 案子层：非首轮 prompt 明确要求「优先沿用之前为该案子开的子会话继续查，
 *    别重开一套；只有换了问题才新建案子」。只靠会话上下文不够——模型很容易
 *    把追问当成新问题重复排查。
 *
 * 兜底与逃生：
 * - `/new`：清掉当前键的绑定，下一条消息进新会话（换话题时用）。
 * - 会话被删/丢失：检测到 not-found 就重建一次，并在 prompt 里说明「上文的
 *   会话已不在，若是追问请先向提问人确认上次结论」，不假装记得。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dingtalk-triage'
/** 热更标记：日志 boot 行会带上，用来确认跑的是哪版代码。 */
const CODEREV = 'rev8'
/** 只依赖会话控制器；webServer 用可选查找，缺了也不影响钉钉主链路。 */
export const inject = ['sessionController']

// ───────────────────────────────────────────────────────────── config ──

const DEFAULTS = {
  enabled: false,
  clientId: '',
  clientSecret: '',
  dataDir: '',
  requireMention: true,
  replyFormat: 'markdown',
  markdownTitle: '排查结果',
  ackText: '收到，开始排查。',
  atReplier: true,
  turnTimeoutMs: 15 * 60 * 1000,
  maxReplyChars: 3800,
  selftest: true,
  newCommand: '/new',
}

const CONFIG_JSON_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    clientId: { type: 'string' },
    clientSecret: { type: 'string' },
    dataDir: { type: 'string' },
    requireMention: { type: 'boolean' },
    replyFormat: { enum: ['markdown', 'text'] },
    markdownTitle: { type: 'string' },
    ackText: { type: 'string' },
    atReplier: { type: 'boolean' },
    turnTimeoutMs: { type: 'number' },
    maxReplyChars: { type: 'number' },
    selftest: { type: 'boolean' },
    defaultProject: { type: 'string' },
    allowedStaffIds: { type: 'array', items: { type: 'string' } },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          cwd: { type: 'string' },
          agentPreset: { type: 'string' },
        },
      },
    },
    routes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          senderStaffId: { type: 'string' },
          senderNick: { type: 'string' },
          project: { type: 'string' },
          label: { type: 'string' },
        },
      },
    },
  },
}

function str(value, fallback) {
  return typeof value === 'string' ? value.trim() : fallback
}
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
function list(value) {
  return Array.isArray(value) ? value : []
}

function normalizeRoute(raw) {
  const item = raw && typeof raw === 'object' ? raw : {}
  return {
    conversationId: str(item.conversationId, ''),
    senderStaffId: str(item.senderStaffId, ''),
    senderNick: str(item.senderNick, ''),
    project: str(item.project, ''),
    label: str(item.label, ''),
  }
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const projects = list(source.projects)
    .map((item) => ({
      name: str(item?.name, ''),
      cwd: str(item?.cwd, ''),
      agentPreset: str(item?.agentPreset, ''),
    }))
    .filter((item) => item.name && item.cwd)
  const routes = list(source.routes)
    .map(normalizeRoute)
    .filter((route) => route.project && (route.conversationId || route.senderStaffId || route.senderNick))
  return {
    enabled: bool(source.enabled, DEFAULTS.enabled),
    clientId: str(source.clientId, DEFAULTS.clientId),
    clientSecret: str(source.clientSecret, DEFAULTS.clientSecret),
    dataDir: str(source.dataDir, DEFAULTS.dataDir),
    requireMention: bool(source.requireMention, DEFAULTS.requireMention),
    replyFormat: str(source.replyFormat, DEFAULTS.replyFormat) === 'text' ? 'text' : 'markdown',
    markdownTitle: str(source.markdownTitle, DEFAULTS.markdownTitle) || DEFAULTS.markdownTitle,
    ackText: str(source.ackText, DEFAULTS.ackText),
    atReplier: bool(source.atReplier, DEFAULTS.atReplier),
    turnTimeoutMs: num(source.turnTimeoutMs, DEFAULTS.turnTimeoutMs),
    maxReplyChars: num(source.maxReplyChars, DEFAULTS.maxReplyChars),
    selftest: bool(source.selftest, DEFAULTS.selftest),
    newCommand: str(source.newCommand, DEFAULTS.newCommand) || DEFAULTS.newCommand,
    defaultProject: str(source.defaultProject, ''),
    allowedStaffIds: list(source.allowedStaffIds).filter((id) => typeof id === 'string' && id.length > 0),
    projects,
    routes,
  }
}

export const Config = {
  ...CONFIG_JSON_SCHEMA,
  meta: { default: {} },
  toJSON() {
    return CONFIG_JSON_SCHEMA
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-dingtalk-triage',
    validate(value) {
      // 永不抛：一行配置写坏不应该让桌面端起不来。
      return { value: normalize(value) }
    },
  },
}

// ────────────────────────────────────────────────────────────── 工具 ──

function oneLine(value, limit = 400) {
  const text = typeof value === 'string' ? value : (() => {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  })()
  const flat = String(text ?? '').replace(/[\r\n]+/g, ' ⏎ ')
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function redact(value) {
  const text = String(value ?? '')
  if (text.length <= 8) return '***'
  return `${text.slice(0, 4)}…${text.slice(-2)}`
}

/** 钉钉群文本里剥掉 @机器人 前缀与零宽字符。 */
function stripMentions(text) {
  return String(text ?? '')
    .replace(/\u2005|\u200b|\u00a0/g, ' ')
    .replace(/^\s*(?:@[^\s@]{1,40}\s*)+/u, '')
    .trim()
}

function splitForDingTalk(text, limit) {
  const clean = String(text ?? '').trim()
  if (clean.length <= limit) return [clean]
  const chunks = []
  let rest = clean
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

// ─────────────────────────────────────────────────────────────── 主体 ──

export function apply(ctx, rawConfig) {
  const cfg = normalize(rawConfig)

  // dataDir 必须显式给，避免猜 DSH_HOME。
  const dataDir = cfg.dataDir || ''
  const logPath = dataDir ? join(dataDir, 'dingtalk-triage.log') : ''
  const bindingPath = dataDir ? join(dataDir, 'bindings.json') : ''

  const log = (event, detail) => {
    const line = `${new Date().toISOString()} ${event}${detail === undefined ? '' : ` ${oneLine(detail, 800)}`}\n`
    if (!logPath) return
    try {
      mkdirSync(dataDir, { recursive: true })
      appendFileSync(logPath, line, 'utf8')
    } catch {
      // 日志写不进去绝不能影响主流程
    }
  }

  log('boot', {
    rev: CODEREV,
    enabled: cfg.enabled,
    clientId: cfg.clientId ? redact(cfg.clientId) : '',
    hasSecret: cfg.clientSecret.length > 0,
    dataDir,
    selftest: cfg.selftest,
    projects: cfg.projects.map((p) => `${p.name} -> ${p.cwd}`),
    routes: cfg.routes.map((r) => describeRoute(r)),
  })

  if (!cfg.enabled) {
    log('disabled', 'enabled=false，插件不启动')
    return
  }
  if (!dataDir) {
    log('fatal', 'dataDir 未配置，拒绝启动（不猜 DSH_HOME）')
    return
  }

  function describeRoute(route) {
    const key = route.conversationId
      ? `conv=${route.conversationId}`
      : route.senderStaffId
        ? `staff=${route.senderStaffId}`
        : `nick=${route.senderNick}`
    return `${route.label || route.project}(${key}) -> ${route.project}`
  }

  // 运行时状态
  const state = {
    stream: { connected: false, lastError: '', since: 0 },
    seen: new Set(),
    bindings: Object.create(null),
    queues: new Map(),
    inflight: 0,
    lastTurn: { conversationId: '', at: 0, ok: false, chars: 0, error: '' },
    // 最近出现过的入口身份：留着给 /status 用，方便把 conversationId / staffId 抄进配置。
    recent: [],
  }

  // ── bindings 持久化 ──
  try {
    const parsed = JSON.parse(readFileSync(bindingPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state.bindings = parsed
  } catch {
    // 首次运行没有文件，正常
  }
  const saveBindings = () => {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(bindingPath, `${JSON.stringify(state.bindings, null, 2)}\n`, 'utf8')
    } catch (error) {
      log('bindings/save-failed', error?.message ?? error)
    }
  }

  // ── 会话控制器 ──
  const session = ctx.sessionController
  if (!session || typeof session.create !== 'function' || typeof session.prompt !== 'function') {
    log('fatal', 'sessionController 不可用或接口不符，拒绝启动')
    return
  }

  const projectByName = (label) => cfg.projects.find((p) => p.name === label)

  function remember(inbound) {
    const at = Date.now()
    const index = state.recent.findIndex((item) => item.key === inbound.key)
    const entry = { ...inbound, at, count: 1 }
    if (index >= 0) {
      entry.count = (state.recent[index].count ?? 0) + 1
      state.recent.splice(index, 1)
    }
    state.recent.unshift(entry)
    if (state.recent.length > 12) state.recent.length = 12
  }

  /**
   * 入口 → 项目。群只按 conversationId 精确匹配（不兜底，避免串项目）；
   * 单聊按 staffId → 昵称 → defaultProject 的顺序。
   */
  function resolveRoute({ conversationId, senderStaffId, senderNick, isGroup }) {
    if (isGroup) {
      const route = cfg.routes.find((r) => r.conversationId && r.conversationId === conversationId)
      if (!route) {
        return {
          error: '这个群还没绑定项目。把群加进机器人后 @我 一次，再到 /dingtalk-triage/status 的 recent 里复制 conversationId，填进配置的 routes。',
        }
      }
      return { route, source: 'conversationId' }
    }
    const byStaff = senderStaffId
      ? cfg.routes.find((r) => r.senderStaffId && r.senderStaffId === senderStaffId)
      : undefined
    if (byStaff) return { route: byStaff, source: 'senderStaffId' }
    const byNick = senderNick
      ? cfg.routes.find((r) => r.senderNick && r.senderNick === senderNick)
      : undefined
    if (byNick) return { route: byNick, source: 'senderNick' }
    const byConv = cfg.routes.find((r) => r.conversationId && r.conversationId === conversationId)
    if (byConv) return { route: byConv, source: 'conversationId' }
    if (cfg.defaultProject) {
      return { route: { project: cfg.defaultProject, label: 'defaultProject' }, source: 'defaultProject' }
    }
    return {
      error: '这个单聊还没绑定项目。先给我发一条消息，再到 /dingtalk-triage/status 的 recent 里复制 senderStaffId，填进配置的 routes（或配 defaultProject 兜底）。',
    }
  }

  function resolveProject(route) {
    const project = projectByName(route.project)
    if (!project) {
      return {
        error: `配置里的 routes 指向了不存在的项目「${route.project}」，请在 projects 里补上它的 name 和 cwd。`,
      }
    }
    return { project }
  }

  async function ensureSession(bindingKey, project) {
    const existing = state.bindings[bindingKey]
    if (existing?.sessionId && existing.project === project.name) {
      return { sessionId: existing.sessionId, fresh: false, turn: existing.turn ?? 1 }
    }
    const request = { cwd: project.cwd }
    if (project.agentPreset) request.agentPreset = project.agentPreset
    const created = await session.create(request)
    const sessionId = created?.sessionId
    if (!sessionId) throw new Error('session.create 没有返回 sessionId')
    state.bindings[bindingKey] = {
      sessionId,
      project: project.name,
      cwd: project.cwd,
      turn: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    saveBindings()
    log('session/created', { bindingKey, sessionId, project: project.name, cwd: project.cwd })
    return { sessionId, fresh: true, turn: 1 }
  }

  function bumpTurn(bindingKey) {
    const binding = state.bindings[bindingKey]
    if (!binding) return
    binding.turn = (binding.turn ?? 0) + 1
    binding.updatedAt = Date.now()
    saveBindings()
  }

  // ── 出站：sessionWebhook ──
  async function sendViaWebhook(webhook, text, { atStaffId } = {}) {
    const body = cfg.replyFormat === 'markdown'
      ? { msgtype: 'markdown', markdown: { title: cfg.markdownTitle, text } }
      : { msgtype: 'text', text: { content: text } }
    if (cfg.atReplier && atStaffId) {
      body.at = { atUserIds: [atStaffId], isAtAll: false }
    }
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (!response.ok) {
      throw new Error(`sessionWebhook HTTP ${response.status} ${oneLine(payload, 200)}`)
    }
    if (payload && typeof payload.errcode === 'number' && payload.errcode !== 0) {
      throw new Error(`sessionWebhook errcode=${payload.errcode} ${oneLine(payload.errmsg, 160)}`)
    }
    return payload
  }

  /** 出站抽象：钉钉走 webhook，自检走日志。 */
  function makeSink(raw) {
    const webhook = typeof raw?.sessionWebhook === 'string' ? raw.sessionWebhook : ''
    if (!webhook) {
      return async (text) => {
        log('sink/local', text)
      }
    }
    return async (text) => {
      for (const chunk of splitForDingTalk(text, cfg.maxReplyChars)) {
        await sendViaWebhook(webhook, chunk, { atStaffId: raw.senderStaffId })
      }
    }
  }

  // ── prompt 构造 ──
  function buildPrompt({ text, project, routeLabel, from, conversationId, first, turn, recreated, plain }) {
    if (plain) return text
    const header = [
      `【钉钉消息】项目：${project.name}　入口：${routeLabel || conversationId}　提问人：${from || '未知'}　本会话第 ${turn ?? 1} 轮`,
      `内容：${text}`,
      '',
    ]
    if (recreated) {
      header.push(
        '注意：这个入口之前的会话已经不在了，你没有上文。如果这条是追问，先向提问人确认上一次的结论与环境，再继续排查；不要把推断当已知。',
        '',
      )
    }
    if (first) {
      header.push(
        '你现在是这个入口的「运维排查主会话」，负责把问题查清并回一条能直接发出去的消息。请先调用 skill 工具加载 project-ops-triage，严格按它的流程工作：',
        '1. 先判定问题是否属于本项目；不属于就用一两句话说明并停手，不要发散。',
        '2. 需要查证的部分按证据面拆开，用 subagent 开子会话并行查（数据库 / 日志 / 代码 / 工单 / 对端），每个子会话只查一条面。',
        '3. 各面事实回到你这里汇总后再判断；只有单面证据的结论标成待核，不写成已确认。',
        '4. 缺关键信息（环境、分支、目录、单号、账号）就停下来把问题列给我，由我转给提问人，不要猜。',
        '',
        '输出要求：',
        '- 本轮只输出一条可以直接发出去的消息，不要输出过程流水账。',
        '- 先结论（是否已解决 / 卡在哪），再说原因与处理，再说需要业务配合的下一步。',
        '- 不要出现表名、字段名、堆栈、服务器路径、内部工单链接。',
        '- 简体中文，不要寒暄，不要表情符号。',
      )
    } else {
      header.push(
        '这是同一个入口的后续消息，可能是在追问上一个问题。处理规则：',
        '- 如果是对已有问题的追问或补充：沿用你之前为那个案子开的子会话继续查（用它的 continuable id 续聊），不要重开一套、不要重复已经查过的面；只补查缺口。',
        '- 如果是新问题：按第 1 条起的新案子处理，先判定是否属于本项目，再拆证据面。',
        '- 拿不准是追问还是新问题时，先用一句话向提问人确认，不要自行假设。',
        '',
        '输出要求同上：只输出一条可直接发出的消息，先结论后原因。',
      )
    }
    return header.join('\n')
  }

  // ── 收集一轮输出 ──
  function assistantTextFromEvent(event) {
    if (event?.type !== 'assistant/message') return ''
    const blocks = event?.data?.message?.content
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim()
  }

  async function runTurn({ sessionId, promptText, onAck }) {
    const requestId = `dt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.turnTimeoutMs)

    const promptPromise = session.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
    }, controller.signal)

    let afterSeq = -1
    const texts = []
    let ended = false
    let endReason = ''
    try {
      // follow 从会话开头给快照，之后是增量事件；只认快照游标之后的事件，
      // 否则续聊会把历史回答再发一遍。
      for await (const frame of session.follow(
        { address: { kind: 'session', sessionId }, assistantStream: false },
        controller.signal,
      )) {
        if (frame?.type === 'snapshot') {
          afterSeq = typeof frame.cursor === 'number' ? frame.cursor : -1
          if (onAck) onAck()
          continue
        }
        if (frame?.type !== 'event') continue
        const event = frame.event
        const seq = typeof event?.seq === 'number' ? event.seq : -1
        if (seq <= afterSeq) continue
        if (event.type === 'assistant/message') {
          const text = assistantTextFromEvent(event)
          if (text) texts.push(text)
        }
        if (event.type === 'turn/end') {
          ended = true
          endReason = event?.data?.reason?.kind ?? 'unknown'
          break
        }
      }
    } finally {
      clearTimeout(timer)
      try {
        await promptPromise
      } catch (error) {
        if (!ended) throw error
        log('prompt/late-error', error?.message ?? error)
      }
    }

    if (!ended) {
      try {
        session.cancel({ sessionId })
      } catch {
        // 尽力而为
      }
      throw new Error(`等待本轮结束超时（${cfg.turnTimeoutMs}ms），已请求取消`)
    }
    if (endReason !== 'completed' && endReason !== 'max-tokens') {
      throw new Error(`本轮没有正常完成：${endReason}`)
    }
    return { answer: texts.length > 0 ? texts[texts.length - 1] : '' }
  }

  // ── 单条入站处理 ──
  function enqueue(bindingKey, task) {
    const prev = state.queues.get(bindingKey) ?? Promise.resolve()
    const next = prev.then(task, task)
    state.queues.set(bindingKey, next.catch(() => {}))
    return next
  }

  async function handleInbound(raw, options = {}) {
    const conversationId = String(raw?.conversationId ?? '')
    const senderStaffId = String(raw?.senderStaffId ?? raw?.senderId ?? '')
    const senderNick = String(raw?.senderNick ?? '')
    const isGroup = String(raw?.conversationType ?? '') === '2'
    if (!conversationId) {
      log('inbound/drop', '缺少 conversationId')
      return
    }

    const msgId = String(raw?.msgId ?? '')
    if (msgId) {
      if (state.seen.has(msgId)) {
        log('inbound/dedupe', msgId)
        return
      }
      state.seen.add(msgId)
      if (state.seen.size > 500) {
        const first = state.seen.values().next().value
        state.seen.delete(first)
      }
    }

    if (cfg.allowedStaffIds.length > 0 && !cfg.allowedStaffIds.includes(senderStaffId)) {
      log('inbound/deny', { conversationId, senderStaffId })
      return
    }

    // 官方事实优先：群消息里机器人是否被 @。字段缺失时才退回文本启发式，
    // 避免钉钉某个版本不带 isInAtList 就整条链路静默丢弃。
    const mentionFact = typeof raw?.isInAtList === 'boolean'
      ? raw.isInAtList
      : /@/.test(String(raw?.text?.content ?? ''))
    if (isGroup && cfg.requireMention && mentionFact !== true) {
      log('inbound/mention-gate', { conversationId, msgId, isInAtList: raw?.isInAtList })
      return
    }

    const sink = makeSink(raw)
    const msgtype = String(raw?.msgtype ?? 'text')
    if (msgtype !== 'text') {
      await sink(`目前只处理文字提问（收到的是 ${msgtype}）。请把问题用文字再发一次。`)
      return
    }

    const text = stripMentions(raw?.text?.content ?? '')
    if (!text) {
      await sink('消息里没有可处理的文字内容。')
      return
    }

    const bindingKey = isGroup
      ? `g:${conversationId}`
      : `d:${senderStaffId || senderNick || conversationId}`

    // /new：换话题时开新会话（上下文清零，但项目绑定不变）。
    if (text === cfg.newCommand) {
      const had = state.bindings[bindingKey]
      delete state.bindings[bindingKey]
      saveBindings()
      log('command/new', { bindingKey, previousSession: had?.sessionId ?? '' })
      await sink(
        had
          ? '已开新会话，之前那个问题的上下文我不再带上了。下一条消息直接说新问题。'
          : '当前本来就没有进行中的会话，下一条消息会新开一个。',
      )
      return
    }

    const resolved = resolveRoute({ conversationId, senderStaffId, senderNick, isGroup })
    if (resolved.error) {
      await sink(resolved.error)
      log('inbound/unrouted', { conversationId, senderStaffId, senderNick, isGroup })
      return
    }
    const projectResolved = resolveProject(resolved.route)
    if (projectResolved.error) {
      await sink(projectResolved.error)
      log('inbound/bad-project', { project: resolved.route.project })
      return
    }
    const { project } = projectResolved
    const routeLabel = resolved.route.label || resolved.route.project

    remember({
      key: bindingKey,
      kind: isGroup ? 'group' : 'dm',
      conversationId,
      senderStaffId,
      senderNick,
      route: routeLabel,
      project: project.name,
      matchedBy: resolved.source,
    })

    const existedBefore = Boolean(state.bindings[bindingKey])
    let sessionId
    let turn = 1
    let recreated = false
    try {
      const ensured = await ensureSession(bindingKey, project)
      sessionId = ensured.sessionId
      turn = ensured.turn
      recreated = !ensured.fresh && !existedBefore
    } catch (error) {
      log('session/create-failed', error?.message ?? error)
      await sink(`主会话没建起来：${oneLine(error?.message ?? error, 300)}`)
      return
    }

    const from = senderNick || senderStaffId
    const promptText = buildPrompt({
      text,
      project,
      routeLabel,
      from,
      conversationId,
      first: turn <= 1,
      turn,
      recreated,
      plain: options.plain === true,
    })

    state.inflight += 1
    let acked = false
    const ack = () => {
      if (acked || !cfg.ackText) return
      acked = true
      Promise.resolve()
        .then(() => sink(cfg.ackText))
        .catch((error) => log('ack/failed', error?.message ?? error))
    }

    try {
      let result
      try {
        result = await runTurn({ sessionId, promptText, onAck: ack })
      } catch (error) {
        // 主会话可能已被用户在网页端删掉：清掉绑定、重建一次再试。
        if (!/not.?found/i.test(String(error?.message ?? ''))) throw error
        log('session/missing', { bindingKey, sessionId })
        delete state.bindings[bindingKey]
        saveBindings()
        const ensured = await ensureSession(bindingKey, project)
        sessionId = ensured.sessionId
        turn = ensured.turn
        const retryPrompt = buildPrompt({
          text,
          project,
          routeLabel,
          from,
          conversationId,
          first: true,
          turn,
          recreated: true,
          plain: options.plain === true,
        })
        result = await runTurn({ sessionId, promptText: retryPrompt, onAck: ack })
      }
      const answer = result.answer
      if (!answer) {
        await sink('主会话这一轮没有产出可发送的文本（可能只做了工具调用）。请在网页端看这条会话的完整过程。')
        state.lastTurn = { conversationId: bindingKey, at: Date.now(), ok: false, chars: 0, error: 'empty-answer' }
        return
      }
      bumpTurn(bindingKey)
      await sink(answer)
      state.lastTurn = { conversationId: bindingKey, at: Date.now(), ok: true, chars: answer.length, error: '' }
      log('turn/done', { bindingKey, sessionId, turn, chars: answer.length })
    } catch (error) {
      const message = oneLine(error?.message ?? error, 300)
      state.lastTurn = { conversationId: bindingKey, at: Date.now(), ok: false, chars: 0, error: message }
      log('turn/failed', { bindingKey, sessionId, turn, error: message, stack: oneLine(error?.stack ?? '', 1500) })
      await sink(`这轮排查没跑完：${message}\n网页端能看到这条会话的完整过程，需要我重试就说一声。`).catch(() => {})
    } finally {
      state.inflight -= 1
    }
  }

  // 入站先按「入口键」排队；解析路由前用 conversationId 兜底排队键即可。
  const submit = (raw, options = {}) => {
    const isGroup = String(raw?.conversationType ?? '') === '2'
    const conversationId = String(raw?.conversationId ?? 'unknown')
    const senderStaffId = String(raw?.senderStaffId ?? raw?.senderId ?? '')
    const senderNick = String(raw?.senderNick ?? '')
    const key = isGroup
      ? `g:${conversationId}`
      : `d:${senderStaffId || senderNick || conversationId}`
    return enqueue(key, () => handleInbound(raw, options))
  }

  // ── 本地自检 / 状态路由（不需要钉钉凭据也能验证主链路）──
  const web = (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined) ?? ctx.webServer
  if (web && typeof web.register === 'function') {
    const json = (res, status, value) => {
      const body = JSON.stringify(value, null, 2)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(body)
    }
    if (cfg.selftest) {
      try {
        ctx.effect?.(() => web.register({
          kind: 'prefix',
          path: '/dingtalk-triage',
          handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            if (url.pathname === '/dingtalk-triage/status') {
              return json(res, 200, {
                enabled: cfg.enabled,
                stream: state.stream,
                projects: cfg.projects,
                routes: cfg.routes.map((r) => ({ ...r, described: describeRoute(r) })),
                bindings: state.bindings,
                recent: state.recent,
                inflight: state.inflight,
                lastTurn: state.lastTurn,
                logPath,
              })
            }
            if (url.pathname === '/dingtalk-triage/selftest') {
              const text = url.searchParams.get('text') ?? ''
              if (!text) return json(res, 400, { error: '缺少 text 参数' })
              const type = url.searchParams.get('type') === 'dm' ? 'dm' : 'group'
              const raw = {
                msgId: `selftest-${Date.now()}`,
                conversationId: url.searchParams.get('conversationId') ?? (type === 'dm' ? 'selftest-dm' : 'selftest-group'),
                conversationType: type === 'dm' ? '1' : '2',
                isInAtList: true,
                msgtype: 'text',
                text: { content: text },
                senderStaffId: url.searchParams.get('senderStaffId') ?? (type === 'dm' ? 'selftest-staff' : 'selftest-user'),
                senderNick: url.searchParams.get('senderNick') ?? (type === 'dm' ? '自检' : '自检'),
              }
              try {
                await submit(raw, { plain: url.searchParams.get('plain') !== '0' })
                return json(res, 200, { ok: true, lastTurn: state.lastTurn, bindings: state.bindings, recent: state.recent })
              } catch (error) {
                return json(res, 500, { ok: false, error: oneLine(error?.message ?? error, 500) })
              }
            }
            return json(res, 404, { error: 'not found' })
          },
        }))
        log('route/registered', '/dingtalk-triage/{status,selftest}')
      } catch (error) {
        log('route/register-failed', error?.message ?? error)
      }
    }
  }

  // ── 钉钉 Stream 连接 ──
  let client = null
  const startStream = async () => {
    if (!cfg.clientId || !cfg.clientSecret) {
      log('stream/skip', '缺少 clientId / clientSecret，未连接钉钉（自检路由仍可用）')
      return
    }
    let sdk
    try {
      sdk = await import('dingtalk-stream')
    } catch (error) {
      log('stream/sdk-missing', error?.message ?? error)
      return
    }
    const { DWClient, TOPIC_ROBOT } = sdk
    try {
      client = new DWClient({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, debug: false })
      client.registerCallbackListener(TOPIC_ROBOT, (message) => {
        // 先 ack 再处理：ack 表示「消息已可靠收到」，不是「回答完了」。
        try {
          const messageId = message?.headers?.messageId
          if (messageId) client.socketCallBackResponse(messageId, { status: 'SUCCESS', message: 'OK' })
        } catch (error) {
          log('stream/ack-failed', error?.message ?? error)
        }
        let parsed
        try {
          parsed = JSON.parse(String(message?.data ?? ''))
        } catch {
          log('stream/bad-json', String(message?.data ?? '').slice(0, 200))
          return
        }
        log('stream/inbound', {
          msgId: parsed?.msgId,
          conversationType: parsed?.conversationType,
          conversationId: parsed?.conversationId,
          senderStaffId: parsed?.senderStaffId,
          senderNick: parsed?.senderNick,
          msgtype: parsed?.msgtype,
          isInAtList: parsed?.isInAtList,
        })
        void submit(parsed).catch((error) => log('stream/handle-failed', error?.message ?? error))
      })
      await client.connect()
      state.stream = { connected: client.connected === true, lastError: '', since: Date.now() }
      log('stream/connected', { connected: client.connected })
      if (client.connected !== true) {
        state.stream.lastError = 'connect() 返回但 socket 未就绪'
      }
    } catch (error) {
      state.stream = { connected: false, lastError: oneLine(error?.message ?? error, 300), since: Date.now() }
      log('stream/connect-failed', state.stream.lastError)
    }
  }

  // 连接不能阻塞插件加载：失败也只落一行日志。
  void startStream()

  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => {
        try {
          client?.disconnect?.()
        } catch {
          // ignore
        }
        log('dispose', 'stream disconnected')
      })
    } catch {
      // ignore
    }
  }
}
