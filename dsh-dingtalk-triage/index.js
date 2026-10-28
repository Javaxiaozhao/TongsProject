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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'

export const name = 'dingtalk-triage'
/** 热更标记：日志 boot 行会带上，用来确认跑的是哪版代码。 */
const CODEREV = 'rev21'
/**
 * 进程级 Stream 单例。模块级变量在每个 import 实例里各有一份（换文件名热更时管不到旧模块），
 * globalThis 在同一 Host 进程内共享，所以任何新实例都能断开前任的连接，杜绝多实例抢同一条消息。
 */
const STREAM_SLOT = Symbol.for('dsh.dingtalk-triage.stream')
function takeOverStream() {
  const previous = globalThis[STREAM_SLOT]
  if (previous && typeof previous.disconnect === "function") {
    try { previous.disconnect() } catch { /* 旧连接可能已死 */ }
    return true
  }
  return false
}
function publishStream(client) {
  globalThis[STREAM_SLOT] = client
}
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
  images: true,
  envSkills: {},
  playbookDir: '',
  selfBaseUrl: 'http://127.0.0.1:43129',
  databases: {},
  projectRoots: [],
  excludedProjects: [],
  projectMarkers: [],
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
    images: { type: 'boolean' },
    envSkills: { type: 'object' },
    playbookDir: { type: 'string' },
    selfBaseUrl: { type: 'string' },
    databases: { type: 'object' },
    projectRoots: { type: 'array', items: { type: 'string' } },
    excludedProjects: { type: 'array', items: { type: 'string' } },
    projectMarkers: { type: 'array', items: { type: 'string' } },
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

/** 项目 → 环境 skill 名列表；插件只知道「去哪找连接资料」，不含连接细节。 */
function normalizeEnvSkills(raw) {
  const out = {}
  if (!raw || typeof raw !== "object") return out
  for (const key of Object.keys(raw)) {
    const value = raw[key]
    const names = (Array.isArray(value) ? value : [value]).map((item) => str(item, "")).filter(Boolean)
    if (names.length > 0) out[key] = names
  }
  return out
}

/** 数据库连接资料；密码不进配置，只给密码文件路径。 */
function normalizeDatabases(raw) {
  const out = {}
  if (!raw || typeof raw !== "object") return out
  for (const key of Object.keys(raw)) {
    const item = raw[key] && typeof raw[key] === "object" ? raw[key] : {}
    const host = str(item.host, "")
    if (!host) continue
    out[key] = {
      host,
      port: num(item.port, 3306),
      user: str(item.user, ""),
      database: str(item.database, ""),
      passwordFile: str(item.passwordFile, ""),
    }
  }
  return out
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
    projectRoots: list(source.projectRoots).map((r) => str(r, '')).filter(Boolean),
    excludedProjects: list(source.excludedProjects).map((r) => str(r, '')).filter(Boolean),
    projectMarkers: list(source.projectMarkers).map((r) => str(r, '')).filter(Boolean),
    defaultProject: str(source.defaultProject, ''),
    images: bool(source.images, DEFAULTS.images),
    envSkills: normalizeEnvSkills(source.envSkills),
    playbookDir: str(source.playbookDir, ''),
    selfBaseUrl: str(source.selfBaseUrl, 'http://127.0.0.1:43129'),
    databases: normalizeDatabases(source.databases),
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

const DBQUERY_PY = "# 只读查询：密码与 SQL 只从环境变量读，不落命令行、不落日志。\nimport json, os, sys, time\nimport pymysql\nstarted = time.time()\nconn = pymysql.connect(\n    host=os.environ['DB_HOST'],\n    port=int(os.environ.get('DB_PORT') or 3306),\n    user=os.environ['DB_USER'],\n    password=os.environ['DB_PASSWORD'],\n    database=os.environ.get('DB_NAME') or None,\n    connect_timeout=8,\n    read_timeout=20,\n)\ntry:\n    cur = conn.cursor()\n    cur.execute(\"SET SESSION TRANSACTION READ ONLY\")\n    cur.execute(\"START TRANSACTION READ ONLY\")\n    cur.execute(os.environ[\"DB_SQL\"])\n    columns = [d[0] for d in (cur.description or [])]\n    rows = cur.fetchall()[:50]\n    payload = {\n        \"columns\": columns,\n        \"rowCount\": len(rows),\n        \"rows\": [[str(c) for c in row] for row in rows],\n        \"elapsedMs\": int((time.time() - started) * 1000),\n    }\n    print(json.dumps(payload, ensure_ascii=False))\n    conn.rollback()\nfinally:\n    conn.close()"

// 判断一个目录像不像代码项目的标记文件；projectMarkers 为空时不做筛选，全部收下。
const PROJECT_MARKERS = ['.git', 'package.json', 'pom.xml', 'build.gradle', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'composer.json', 'Gemfile']

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
    projectRoots: cfg.projectRoots,
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
    projects: [],
    // 最近出现过的入口身份：留着给 /status 用，方便把 conversationId / staffId 抄进配置。
    recent: [],
  }

  /**
   * 扫 work 根目录发现项目：根下每个非点号子目录算一个项目，目录名即项目名。
   * 手工配置的 projects 先入表且同名优先，扫描只补它没覆盖的。
   */
  function scanProjects() {
    const found = new Map()
    for (const project of cfg.projects) {
      found.set(project.name.toLowerCase(), { ...project, markers: [], source: "manual" })
    }
    for (const root of cfg.projectRoots) {
      let entries
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch (error) {
        log("projects/scan-failed", { root, error: error?.message ?? error })
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const name = entry.name
        if (name.startsWith(".")) continue
        if (cfg.excludedProjects.includes(name)) continue
        if (found.has(name.toLowerCase())) continue
        const cwd = join(root, name)
        const markers = []
        for (const marker of PROJECT_MARKERS) {
          try {
            if (existsSync(join(cwd, marker))) markers.push(marker)
          } catch {
            // 权限之类的问题忽略即可，不影响把目录当项目用
          }
        }
        if (cfg.projectMarkers.length > 0 && !markers.some((m) => cfg.projectMarkers.includes(m))) continue
        found.set(name.toLowerCase(), { name, cwd, agentPreset: "", markers, source: "scan", root })
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  state.projects = scanProjects()
  log("projects/discovered", state.projects.map((item) => item.name + " -> " + item.cwd))

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

  // ── 图片入站：钉钉下载 → attachments 落盘 → 作为图片内容块进 prompt ──
  const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
  let accessToken = { value: '', expiresAt: 0 }
  async function getAccessToken() {
    if (accessToken.value && Date.now() < accessToken.expiresAt - 60000) return accessToken.value
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('下载图片需要 clientId/clientSecret')
    const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: cfg.clientId, appSecret: cfg.clientSecret }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload || !payload.accessToken) {
      throw new Error("取 accessToken 失败：" + response.status + " " + oneLine(payload, 160))
    }
    accessToken = { value: payload.accessToken, expiresAt: Date.now() + (payload.expireIn || 7200) * 1000 }
    return accessToken.value
  }

  /** 按 magic bytes 判断图片类型，钉钉返回的 content-type 不可靠。 */
  function sniffImageMediaType(bytes, declared) {
    if (declared && /^image\/(png|jpeg|webp|gif)$/.test(declared)) return declared
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg"
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif"
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp"
    return undefined
  }

  /** picture 消息的 downloadCode 可能在 content（对象或 JSON 串）里，也可能在 picture 下。 */
  function pictureDownloadCode(raw) {
    let content = raw && raw.content
    if (typeof content === "string") {
      try { content = JSON.parse(content) } catch { content = undefined }
    }
    const box = content && typeof content === "object" ? content : undefined
    return (box && box.downloadCode) || (raw && raw.picture && raw.picture.downloadCode) || (raw && raw.picDownloadCode) || ""
  }

  async function downloadPicture(raw) {
    const downloadCode = pictureDownloadCode(raw)
    if (!downloadCode) throw new Error("图片消息里没有 downloadCode")
    const robotCode = String((raw && raw.robotCode) || "") || cfg.clientId
    const token = await getAccessToken()
    const response = await fetch('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ downloadCode, robotCode }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload || !payload.downloadUrl) {
      throw new Error("取图片下载地址失败：" + response.status + " " + oneLine(payload, 160))
    }
    const file = await fetch(payload.downloadUrl)
    if (!file.ok) throw new Error("下载图片失败：" + file.status)
    const buffer = new Uint8Array(await file.arrayBuffer())
    const mediaType = sniffImageMediaType(buffer, file.headers.get("content-type"))
    if (!mediaType) throw new Error("下载到的内容不是支持的图片格式")
    return { data: buffer, mediaType }
  }

  // ── 取数通道：TCP 可达性 + 只读 SELECT（密码走文件 → 环境变量） ──
  const dbqueryPyPath = join(dataDir, "dbquery.py")
  try { writeFileSync(dbqueryPyPath, DBQUERY_PY, "utf8") } catch (error) { log("dbquery/script-failed", error?.message ?? error) }

  function pingHost(host, port) {
    return new Promise((resolve) => {
      const started = Date.now()
      const socket = connect({ host, port })
      let settled = false
      const done = (reachable, error) => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch {}
        resolve({ reachable, ms: Date.now() - started, error: error || "" })
      }
      socket.setTimeout(5000)
      socket.once("connect", () => done(true, ""))
      socket.once("timeout", () => done(false, "timeout"))
      socket.once("error", (error) => done(false, (error && error.message) || "error"))
    })
  }

  function runPythonSelect(conn, sql) {
    return new Promise((resolve) => {
      const env = { ...process.env, DB_HOST: conn.host, DB_PORT: String(conn.port), DB_USER: conn.user, DB_NAME: conn.database, DB_SQL: sql, DB_PASSWORD: readFileSync(conn.passwordFile, "utf8").trim() }
      const started = Date.now()
      const child = spawn(cfg.pythonPath || "python", [dbqueryPyPath], { env, windowsHide: true })
      let stdout = ""
      let stderr = ""
      const timer = setTimeout(() => { try { child.kill() } catch {} }, 25000)
      child.stdout.on("data", (chunk) => { stdout += chunk })
      child.stderr.on("data", (chunk) => { stderr += String(chunk).slice(0, 600) })
      child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, error: (error && error.message) || "spawn-failed", elapsedMs: Date.now() - started }) })
      child.on("close", (code) => {
        clearTimeout(timer)
        const elapsedMs = Date.now() - started
        if (code !== 0) return resolve({ ok: false, error: stderr || ("exit " + code), elapsedMs })
        try { const parsed = JSON.parse(stdout.trim()); parsed.ok = true; parsed.elapsedMs = elapsedMs; resolve(parsed) }
        catch (error) { resolve({ ok: false, error: "输出不是 JSON：" + stdout.slice(0, 200), elapsedMs }) }
      })
    })
  }

  // ── 工作区归档：侧边栏按 Workspace 分组，只给 cwd 不够 ──
  const workspaces = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  /** 确保 cwd 对应的 Workspace 存在；存在的直接复用（create 本身也是幂等的）。 */
  async function ensureWorkspace(cwd) {
    if (!workspaces || typeof workspaces.create !== "function") return undefined
    try {
      const owned = typeof workspaces.resolveByPath === "function" ? await workspaces.resolveByPath(cwd) : undefined
      if (owned && owned.id) return owned.id
      const created = await workspaces.create(cwd, basename(cwd))
      log("workspace/created", { cwd, id: created && created.id, title: created && created.title })
      return created && created.id
    } catch (error) {
      log("workspace/failed", { cwd, error: oneLine(error?.message ?? error, 200) })
      return undefined
    }
  }

  // ── 每个人自己的链路库：默认在 dataDir 下，首启播种索引与模板 ──
  const playbookDir = cfg.playbookDir || join(dataDir, 'playbooks')
  try {
    mkdirSync(playbookDir, { recursive: true })
    const indexPath = join(playbookDir, 'INDEX.md')
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, [
        '# 排查链路索引',
        '',
        '| 链路 | 适用症状 | 最近验证 |',
        '| --- | --- | --- |',
        '',
      ].join('\n'), 'utf8')
    }
    const templatePath = join(playbookDir, 'TEMPLATE.md')
    if (!existsSync(templatePath)) {
      writeFileSync(templatePath, [
        '# <一句话：什么现象走这条链路>',
        '',
        '症状关键词：<业务怎么说这件事的几个词，用顿号分隔>',
        '',
        '## 最短路径',
        '',
        '1. <先查哪张表/哪个接口/哪个文件>',
        '2. <一条可直接复制的 SQL 或命令>',
        '',
        '## 判读规则',
        '',
        '- <哪个字段代表什么，什么值算成功/失败>',
        '',
        '## 不要走的路',
        '',
        '- <这次踩过的坑：哪个字段看起来像证据其实不是>',
        '',
        '## 最近验证',
        '',
        '- <日期>：<结论一句话>',
        '',
      ].join('\n'), 'utf8')
    }
    log('playbook/ready', { dir: playbookDir })
  } catch (error) {
    log('playbook/seed-failed', error?.message ?? error)
  }

  const projectByName = (label) => state.projects.find((p) => p.name === label)

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
        error: `找不到项目「${route.project}」。当前可用：${state.projects.map((p) => p.name).join("、") || "（未扫描到任何项目）"}。改 routes 里的 project，或把目录放进 projectRoots 扫描根。`,
      }
    }
    return { project }
  }

  async function ensureSession(bindingKey, project) {
    const existing = state.bindings[bindingKey]
    if (existing?.sessionId && existing.project === project.name) {
      return { sessionId: existing.sessionId, fresh: false, turn: existing.turn ?? 1 }
    }
    // session.create 只接受 workspaceId 或 cwd 其中一个，不能同时给：
    // 有工作区就用工作区（会话会归到该项目分组下），否则退回裸 cwd。
    const workspaceId = await ensureWorkspace(project.cwd)
    const request = workspaceId ? { workspaceId } : { cwd: project.cwd }
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
      // 钉钉 markdown 的原生 @ 需要正文里带 @+userId 占位，只给 atUserIds 不会渲染，
      // 只会推一条提醒。text 消息则靠 atUserIds 自动渲染。
      if (cfg.replyFormat === "markdown") {
        const prefix = "@" + atStaffId + " "
        if (!body.markdown.text.startsWith(prefix)) body.markdown.text = prefix + body.markdown.text
      }
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
  function buildPrompt({ text, project, routeLabel, from, conversationId, first, turn, recreated, plain, imageCount, envSkills }) {
    if (plain) return text
    const header = [
      `【钉钉消息】项目：${project.name}　入口：${routeLabel || conversationId}　提问人：${from || '未知'}　本会话第 ${turn ?? 1} 轮`,
      `内容：${text}`,
      ...(imageCount > 0 ? [`附图：${imageCount} 张，已作为图片内容块随本条消息给你，先看图判断现象再决定查哪几面。`] : []),
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
        '1.5 判断问题类型再决定走多重的流程：',
        '  · 取数/口径类（今天多少单、某单当前状态）：不要拆证据面、不要开子会话、不要沉淀链路。直接用本项目的环境 skill 连只读库或日志查，一次拿到结果就回复。输出固定四段：结论 → 数据源（生产/测试 + 库表或平台）→ 时点 → 口径。',
        '  · 现象/异常类（报错、状态不对、同步没到）：走完整流程，先查链路库，命中按最短链路，未命中才拆面。',
        `  · 需要查日志或连机器时：先在 ${playbookDir}/INDEX.md 里找日志/终端类条目，命中就按那条已验证的连接与取数步骤走（含平台登录、核机器、拿终端令牌、命令帧往返的具体命令）。未命中才自己探，且探通后必须沉淀成新条目。不要用本机 SSH 硬连生产机器。`,
        '  · 查日志前先自证身份：hostname、id -un 确认机器与环境（生产/测试）；取内容只用 tail -n / sed -n / grep，禁止 tail -f、journalctl -f、watch、vim 这类交互命令。',
        '  · 取数类固定两步，不许自己另造通道：',
        `    ① 先读 ${playbookDir}/INDEX.md，按症状关键词匹配；命中就照该文件的最短路径与口径执行，禁止再从代码反推口径；`,
        `    ② 再调 GET ${cfg.selfBaseUrl}/dingtalk-triage/dbquery?project=<项目名>&op=select&sql=<urlencode后SQL> 取数（web_fetch 或 pwsh 的 Invoke-RestMethod 都行）。该通道已内置只读事务、SELECT/SHOW 白名单、强制 LIMIT；禁止自己拼 mysql 连接、禁止读凭据文件、禁止写临时 py 脚本。`,
        '    ③ 链路库未命中时才允许自己查证口径，且回复里必须注明「口径为本次查证」。',
        '  · 变更类（订正、重推、改配置）：不要执行，只出方案并说明需要审批。',
        `  · 结案必须沉淀，不许跳过：给出结论后，在 ${playbookDir} 下新建或更新一条 .md（结构照 TEMPLATE.md：症状关键词 / 最短路径 / 判读规则 / 不要走的路 / 最近验证），并在 INDEX.md 登记或更新那一行。命中已有条目就只更新「最近验证」补新坑，不要另起一份；同一现象出现两份就合并并删掉旧的那份。`,
        '  · 沉淀是给你下一次用的，不是给提问人看的；对外回复里不要提链路库、文件路径和 SQL。',
        '  · 查库时只读：SET SESSION TRANSACTION READ ONLY、只跑 SELECT/SHOW、必须带 LIMIT 与超时；密码走环境变量或密码文件，绝不出现在命令行、日志和回复里。',
        '  · 本项目的环境入口见这些 skill：' + ((envSkills && envSkills.length) ? envSkills.join('、') : '（未配置，缺这一面就明说没查）') + '。连接资料以这些 skill 为准，不要自己猜连接串、账号或机器。',
        '2. 先查已沉淀的链路库：读 project-ops-triage 的 playbooks/INDEX.md。命中就按那条最短路径走，先读它的「不要走的路」；现象对不上状态值/报错原文/环境/统计口径就立刻换方向，不硬套。只有未命中才从零拆证据面。',
        '3. 需要查证的部分按证据面拆开，用 subagent 开子会话并行查（数据库 / 日志 / 代码 / 工单 / 对端），每个子会话只查一条面。',
        '4. 数据库和服务器不是必查项，先判断现象是否真指向它们再连；连之前先看本次会话实际挂载了哪些工具（MCP / SSH / 只读账号），缺的那一面就明说「这一面没查」，不要用推测补。',
        '5. 数据库只读、服务器只读；任何写操作、高资源查询、改配置都要停下来走审批，不要在群里承诺已经改了。',
        '6. 各面事实回到你这里汇总后再判断；只有单面证据的结论标成待核，不写成已确认。',
        '7. 缺关键信息（环境、分支、目录、单号、账号）就停下来把问题列给我，由我转给提问人，不要猜。',
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
        '- 如果是新问题：按第 1 条起的新案子处理，先判定是否属于本项目，再查链路库（命中走最短链路，未命中才拆证据面）。',
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

  async function runTurn({ sessionId, promptText, onAck, imageRefs }) {
    const imageParts = (imageRefs || []).map((attachment) => ({ type: "image", attachment }))
    const requestId = `dt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.turnTimeoutMs)

    const promptPromise = session.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: "text", text: promptText }, ...imageParts],
    }, controller.signal)
    promptPromise.catch(() => {}) // 立刻挂 handler：prompt 若在 follow 流期间被拒（如 session/agent-busy），避免 Node 判 unhandledRejection 让 dsh exit 1

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
    const picked = []
    let text = ''
    if (msgtype === 'text') {
      text = stripMentions(raw?.text?.content ?? '')
    } else if (msgtype === 'picture' && cfg.images) {
      try {
        picked.push(await downloadPicture(raw))
      } catch (error) {
        log('image/download-failed', oneLine(error?.message ?? error, 200))
        await sink(`截图没取到（${oneLine(error?.message ?? error, 160)}）。把关键信息用文字发一次，或者把报错原文贴一下。`)
        return
      }
      text = stripMentions(raw?.text?.content ?? '')
    } else {
      await sink(`目前支持文字和图片（收到的是 ${msgtype}）。请把问题用文字或截图再发一次。`)
      return
    }
    // 自检可以直接注入图片字节，绕过钉钉下载
    if (Array.isArray(options.images)) picked.push(...options.images)

    if (!text && picked.length === 0) {
      await sink('消息里没有可处理的内容。')
      return
    }

    const imageRefs = []
    if (picked.length > 0) {
      if (!attachments || typeof attachments.saveImage !== 'function') {
        await sink('收到图片，但当前环境没挂上 attachments 服务，看不了图。请把关键信息用文字发一次。')
        return
      }
      for (const image of picked) {
        try {
          imageRefs.push(await attachments.saveImage({ data: image.data, mediaType: image.mediaType, name: image.name }))
        } catch (error) {
          log('image/save-failed', oneLine(error?.message ?? error, 200))
          await sink(`图片存不下来（${oneLine(error?.message ?? error, 160)}）。换成文字描述再发一次。`)
          return
        }
      }
    }
    if (!text && imageRefs.length > 0) text = '（图片提问，无文字说明）'

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
    const projectResolved = resolved.error ? undefined : resolveProject(resolved.route)
    const project = projectResolved && projectResolved.project ? projectResolved.project : undefined
    const routeLabel = resolved.route ? (resolved.route.label || resolved.route.project) : ''
    // 入站即记录：还没绑定项目的新群，也要能在 /status 的 recent 里拿到自己的 id
    remember({
      key: bindingKey,
      kind: isGroup ? 'group' : 'dm',
      conversationId,
      senderStaffId,
      senderNick,
      route: routeLabel || '（未绑定）',
      project: project ? project.name : '',
      matchedBy: resolved.source ?? '',
    })
    if (resolved.error) {
      await sink(resolved.error)
      log('inbound/unrouted', { conversationId, senderStaffId, senderNick, isGroup })
      return
    }
    if (!project) {
      await sink(projectResolved && projectResolved.error ? projectResolved.error : '项目解析失败。')
      log('inbound/bad-project', { project: resolved.route.project })
      return
    }

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
      imageCount: imageRefs.length,
      envSkills: cfg.envSkills[project.name] || [],
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
        result = await runTurn({ sessionId, promptText, onAck: ack, imageRefs })
      } catch (error) {
        // 会话被删掉（not-found）或被归档（blocked，pre-step 门禁直接拦死）：清绑定、重建一次再试。
        if (!/(not.?found|blocked)/i.test(String(error?.message ?? ''))) throw error
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
          imageCount: imageRefs.length,
          envSkills: cfg.envSkills[project.name] || [],
          plain: options.plain === true,
        })
        result = await runTurn({ sessionId, promptText: retryPrompt, onAck: ack, imageRefs })
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
              if (url.searchParams.get('refresh') === '1') {
                state.projects = scanProjects()
                log('projects/discovered', state.projects.map((item) => item.name + ' -> ' + item.cwd))
              }
              return json(res, 200, {
                enabled: cfg.enabled,
                stream: state.stream,
                projects: state.projects,
                routes: cfg.routes.map((r) => ({ ...r, described: describeRoute(r) })),
                bindings: state.bindings,
                recent: state.recent,
                inflight: state.inflight,
                lastTurn: state.lastTurn,
                logPath,
              })
            }
            if (url.pathname === '/dingtalk-triage/inspect') {
              const sid = url.searchParams.get('session') || ''
              const tail = Number(url.searchParams.get('tail') || 20)
              if (!sid) return json(res, 400, { error: '缺少 session 参数' })
              try {
                const info = await session.inspect(sid)
                const events = (info && info.events) || []
                const out = events.slice(-tail).map((e) => {
                  const d = e.data || {}
                  const txt = Array.isArray(d.message && d.message.content)
                    ? d.message.content.map((b) => b.text || ("<" + b.type + ">")).join(" ")
                    : (d.arguments || "")
                  return {
                    seq: e.seq,
                    type: e.type,
                    name: d.name || "",
                    role: (d.message && d.message.role) || "",
                    reason: d.reason ? JSON.stringify(d.reason).slice(0, 120) : "",
                    error: d.error ? JSON.stringify(d.error).slice(0, 160) : "",
                    text: String(txt).replace(/\s+/g, " ").slice(0, 200),
                  }
                })
                return json(res, 200, { total: events.length, tail: out })
              } catch (error) {
                return json(res, 500, { error: oneLine(error?.message ?? error, 300) })
              }
            }
            if (url.pathname === '/dingtalk-triage/dbquery') {
              const project = url.searchParams.get('project') || ''
              const op = url.searchParams.get('op') || 'ping'
              const conn = cfg.databases[project]
              if (!conn) return json(res, 400, { error: '没有这个项目的数据库配置', configured: Object.keys(cfg.databases) })
              if (op === 'ping') return json(res, 200, { project, host: conn.host, port: conn.port, ...(await pingHost(conn.host, conn.port)) })
              const sql = (url.searchParams.get('sql') || '').trim()
              if (!/^(select|show)\b/i.test(sql)) return json(res, 400, { error: '只允许 SELECT / SHOW' })
              if (!conn.passwordFile) return json(res, 400, { error: '缺 passwordFile，无法认证' })
              if (!/\blimit\b/i.test(sql)) return json(res, 400, { error: 'SQL 必须自带 LIMIT' })
              try {
                const result = await runPythonSelect(conn, sql)
                log("dbquery/select", { project, ok: result.ok, rowCount: result.rowCount, elapsedMs: result.elapsedMs })
                return json(res, result.ok ? 200 : 500, result)
              } catch (error) {
                return json(res, 500, { ok: false, error: oneLine(error?.message ?? error, 300) })
              }
            }
            if (url.pathname === '/dingtalk-triage/selftest') {
              const text = url.searchParams.get('text') ?? ''
              if (!text) return json(res, 400, { error: '缺少 text 参数' })
              const type = url.searchParams.get('type') === 'dm' ? 'dm' : 'group'
              const extraImages = []
              const imagePath = url.searchParams.get('imagePath')
              if (imagePath) {
                try {
                  const bytes = readFileSync(imagePath)
                  const mediaType = sniffImageMediaType(bytes, '')
                  if (!mediaType) throw new Error('不是 png/jpeg/webp/gif')
                  extraImages.push({ data: bytes, mediaType })
                } catch (error) {
                  return json(res, 400, { error: oneLine(error?.message ?? error, 300) })
                }
              }
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
                await submit(raw, { plain: url.searchParams.get('plain') !== '0', images: extraImages })
                return json(res, 200, { ok: true, lastTurn: state.lastTurn, bindings: state.bindings, recent: state.recent })
              } catch (error) {
                return json(res, 500, { ok: false, error: oneLine(error?.message ?? error, 500) })
              }
            }
            return json(res, 404, { error: 'not found' })
          },
        }))
        log("route/registered", "/dingtalk-triage/{status,selftest,dbquery}")
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
      if (takeOverStream()) log("stream/previous-closed", "已断开上一个实例的 Stream 连接")
      client = new DWClient({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, debug: false })
      publishStream(client)
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
          if (globalThis[STREAM_SLOT] === client) globalThis[STREAM_SLOT] = null
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
