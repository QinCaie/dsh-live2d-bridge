// dsh-live2d-bridge —— 把 DSH 会话事件压成一份「当前在干什么」的状态文件。
//
// 为什么用文件而不是 HTTP 路由：
//   DSH 的 Web 端口带鉴权（外部程序直接请求 401），插件里注册的 /xxx.json 路由也只对页面内可用。
//   Live2D 舞台是独立 Electron 进程，所以这里**原子写文件**，舞台侧轮询文件即可 —— 无鉴权、无端口冲突。
//
// 事件语义与 dsh-xiaoke-widget / dsh-pet 的 work-status 一致（同一套判据）：
//   turn/start → thinking    tool/call → working（ask_user_question → waiting）
//   tool/result → result     approval/asked → waiting
//   turn/end completed → success，error/max-tokens/timeout → error，blocked → waiting
//   todo/write → 当前步骤文案
//
// 约束：零依赖（只 import node 内置）、只观察不改流程、异常全部吞掉。

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'live2d-bridge'
/** cordis：用到 tools / systemPrompt 服务，必须显式注入，否则访问 ctx.tools 会抛错 */
const inject = ['tools', 'systemPrompt']
const VERSION = '0.1.0'

const DIR = join(homedir(), '.dsh', 'live2d')
const FILE = join(DIR, 'status.json')
const TMP = join(DIR, 'status.json.tmp')
const ENDPOINT = join(DIR, 'endpoint.json')
const STAGE_TIMEOUT = 6000

/** 读舞台写下的 endpoint（端口 + token）；舞台没开返回 null */
async function stageEndpoint() {
  try {
    const ep = JSON.parse(await readFile(ENDPOINT, 'utf8'))
    if (ep?.url && ep?.token) return ep
  } catch {}
  return null
}

/** 调舞台 HTTP API：失败一律折成 { ok:false, error }，不把异常扔给模型 */
async function stageFetch(method, apiPath, body) {
  const ep = await stageEndpoint()
  if (!ep) return { ok: false, error: 'Live2D 舞台没开（读不到 ~/.dsh/live2d/endpoint.json）' }
  try {
    const res = await fetch(ep.url + apiPath, {
      method,
      headers: { 'x-stage-token': ep.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(STAGE_TIMEOUT),
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!res.ok) return { ok: false, status: res.status, error: data }
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

const VOICE_URL = process.env.LIVE2D_VOICE_URL || 'http://127.0.0.1:8899'
const VOICE_ON = process.env.LIVE2D_VOICE !== '0'

/** 有声音的 say：先问 pet-brain 合成 wav（3~8 秒），失败就退化成纯气泡 */
async function sayWithVoice(text, ms) {
  if (VOICE_ON) {
    try {
      const r = await fetch(VOICE_URL + '/voice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(60000),
      })
      const j = await r.json().catch(() => null)
      if (j?.ok && j.url) return stageAction({ kind: 'voice', url: VOICE_URL + j.url, text, ms, state: 'idle' })
    } catch {}
  }
  return stageAction({ kind: 'say', text, ms, state: 'idle' })
}

function stageAction(action, extra = {}) {
  return stageFetch('POST', '/api/action', { source: 'agent', priority: 'NORMAL', fade: 0.3, ttlMs: 0, ...extra, action })
}

/** 会话开场报到：说一句 + 竖食指。每个会话只做一次 */
const greeted = new Set()
async function greetSession() {
  await stageAction({ kind: 'pose', name: '竖手指', ms: 4000 })
  await stageAction({ kind: 'say', text: '连接成功啦～', ms: 4000, state: 'idle' })
}

/** 给模型的说明：何时该用 live2d 工具 */
const LIVE2D_PROMPT = `## Live2D 桌面角色

本机桌面有一个 Live2D 舞台，你可以用 \`live2d\` / \`live2d_status\` 两个工具控制她：
说话气泡、表情、姿势、视线、待机动作、工作状态。

- 想让她开口：\`live2d\` + \`kind:"say"\`，\`text\` 是要说的话，\`ms\` 是气泡停留时长。
- 做动作：\`kind:"pose"\`，常见姿势名：默认手 / 竖手指 / 举手 / 狗尾草 / 护胯。
- 换表情：\`kind:"expression"\`，表情名可先用 \`live2d_status\` 或直接试（爱心眼 / 黑框眼镜 / 脸红 / ＞＜ …）。
- 读回状态与互动：live2d_status（返回气泡文字、待机动作、表情层和最近的点/摸/拖记录）。
- 舞台没开时工具返回 \`ok:false\`，忽略即可，不要因此中断任务。
- **会话开场报到由本插件自动完成**（说「连接成功啦～」+ 竖食指），你不要再重复报到；
  任务过程中想给她加动作或台词，随时用工具即可。`

const STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error']
const PRIORITY = { waiting: 60, error: 50, working: 40, thinking: 30, result: 25, success: 20 }
const TASK_MAX = 48
const TERMINAL_KEEP_MS = 60 * 1000
const QUESTION_TOOL = 'ask_user_question'
const GOAL_TOOL = 'update_goal'

/** 会话状态表：sid → { state, seq, task, tool, ts } */
const sessions = new Map()
/** 会话级回合标志：sid → { goalRound, closing } */
const flags = new Map()
const terminalTimers = new Map()

let writeTimer = 0
let lastPayload = ''

function log(msg) {
  try { console.log(`[live2d-bridge] ${msg}`) } catch {}
}

function trimTask(text) {
  const points = Array.from(String(text || '').trim())
  if (!points.length) return null
  return points.length > TASK_MAX ? points.slice(0, TASK_MAX).join('') + '…' : points.join('')
}

/** todo/write → 当前步骤（优先 in_progress，其次第一个 pending） */
function taskFromTodo(event) {
  const todos = Array.isArray(event?.data?.todos) ? event.data.todos : []
  let current = null
  for (const t of todos) if (t && t.status === 'in_progress') current = t
  if (!current) current = todos.find((t) => t && t.status === 'pending')
  return trimTask(current?.content)
}

/** update_goal 的收尾动作（决定这一轮算 complete 还是 blocked） */
function goalAction(event) {
  try {
    const o = JSON.parse(String(event?.data?.arguments || ''))
    if (o && (o.action === 'complete' || o.action === 'blocked')) return o.action
  } catch {}
  return null
}

function sidOf(session) {
  return String(session?.header?.id || session?.id || 'unknown')
}

function turnEndState(reasonKind) {
  if (reasonKind === 'completed') return 'success'
  if (reasonKind === 'error' || reasonKind === 'max-tokens' || reasonKind === 'timeout') return 'error'
  if (reasonKind === 'blocked') return 'waiting'
  return null
}

/** 事件 → 状态档（不关心返回 null） */
function reduce(event, flag) {
  const type = event?.type
  const data = event?.data || {}
  switch (type) {
    case 'turn/start': return 'thinking'
    case 'tool/call': return String(data.name || data.toolName || '') === QUESTION_TOOL ? 'waiting' : 'working'
    case 'tool/result': return 'result'
    case 'approval/asked': return 'waiting'
    case 'turn/end': {
      const kind = String(data?.reason?.kind || '')
      const st = turnEndState(kind)
      if (st !== 'success') return st
      // goal 自动续跑的中间轮只是「本轮完成」，不算收工
      if (!flag?.goalRound) return 'success'
      if (flag.closing === 'blocked') return 'error'
      if (flag.closing === 'complete') return 'success'
      return 'result'
    }
    default: return null
  }
}

function best() {
  let pick = null
  for (const [sid, e] of sessions) {
    if (!pick || PRIORITY[e.state] > PRIORITY[pick.state] ||
      (PRIORITY[e.state] === PRIORITY[pick.state] && e.ts > pick.ts)) {
      pick = e
      pick.sid = sid
    }
  }
  return pick
}

function scheduleWrite() {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = 0
    try {
      const b = best()
      const payload = {
        ok: true,
        v: 1,
        at: Date.now(),
        state: b ? b.state : null,
        task: b ? b.task : null,
        tool: b ? b.tool : null,
        session: b ? b.sid : null,
        states: STATES,
      }
      const json = JSON.stringify(payload)
      if (json === lastPayload) return
      lastPayload = json
      mkdirSync(DIR, { recursive: true })
      writeFileSync(TMP, json, 'utf8')
      renameSync(TMP, FILE) // 原子替换：舞台不会读到写了一半的文件
    } catch (e) {
      log('写状态失败：' + (e && e.message))
    }
  }, 120)
  if (writeTimer.unref) writeTimer.unref()
}

function setState(sid, state, seq, extra = {}) {
  const prev = sessions.get(sid)
  if (prev && prev.state === state && prev.seq >= seq) {
    // 状态没变但附带信息（工具名/任务）变了也要落盘
    if ((extra.tool ?? prev.tool) !== prev.tool || (extra.task ?? prev.task) !== prev.task) {
      prev.tool = extra.tool ?? prev.tool
      prev.task = extra.task ?? prev.task
      prev.ts = Date.now()
      scheduleWrite()
    }
    return
  }
  sessions.set(sid, {
    state,
    seq,
    ts: Date.now(),
    task: extra.task !== undefined ? extra.task : (prev ? prev.task : null),
    tool: extra.tool !== undefined ? extra.tool : (prev ? prev.tool : null),
  })
  scheduleWrite()
}

function clearTerminalTimer(sid) {
  const t = terminalTimers.get(sid)
  if (t) { clearTimeout(t); terminalTimers.delete(sid) }
}

function scheduleTerminalCleanup(sid) {
  if (terminalTimers.has(sid)) return
  const t = setTimeout(() => {
    terminalTimers.delete(sid)
    const e = sessions.get(sid)
    if (e && (e.state === 'success' || e.state === 'error')) {
      sessions.delete(sid)
      flags.delete(sid)
      scheduleWrite()
    }
  }, TERMINAL_KEEP_MS)
  if (t.unref) t.unref()
  terminalTimers.set(sid, t)
}

function onSessionEvent(session, event) {
  if (!event || !event.type) return
  const sid = sidOf(session)
  const type = event.type
  const seq = Number(event.seq || 0)

  if (type === 'todo/write') {
    const cur = sessions.get(sid)
    if (cur) setState(sid, cur.state, seq, { task: taskFromTodo(event) })
    return
  }
  if (type === 'user/message') {
    const source = event?.data?.source
    if (source && source.kind === 'goal') {
      const f = flags.get(sid) || { goalRound: false, closing: null }
      f.goalRound = true
      flags.set(sid, f)
    }
    return
  }
  if (type === 'turn/start') {
    flags.set(sid, { goalRound: false, closing: null })
    clearTerminalTimer(sid)
  }
  if (type === 'tool/call' && String(event?.data?.name || '') === GOAL_TOOL) {
    const action = goalAction(event)
    if (action) {
      const f = flags.get(sid) || { goalRound: false, closing: null }
      f.closing = action
      flags.set(sid, f)
    }
  }

  const next = reduce(event, flags.get(sid))
  if (!next) {
    if (type === 'turn/end') {
      flags.delete(sid)
      clearTerminalTimer(sid)
      if (sessions.delete(sid)) scheduleWrite()
    }
    return
  }

  const tool = type === 'tool/call' ? String(event?.data?.name || event?.data?.toolName || '') || null
    : type === 'tool/result' ? (sessions.get(sid)?.tool ?? null)
      : null
  const extra = {}
  if (type === 'tool/call') extra.tool = tool
  if (type === 'turn/start') { extra.tool = null; extra.task = null }
  setState(sid, next, seq, extra)

  if (next === 'success' || next === 'error') scheduleTerminalCleanup(sid)
  else clearTerminalTimer(sid)
}

function apply(ctx) {
  log(`v${VERSION} 加载，状态文件：${FILE}`)

  // 给模型的使用说明（排在工具说明区，TOOL_GOAL 之后）
  try {
    if (ctx.systemPrompt?.section) {
      ctx.systemPrompt.section({ name: 'tool:live2d', order: 2450, text: LIVE2D_PROMPT })
    }
  } catch (e) { log('注册提示词失败：' + (e && e.message)) }

  // ---------- 模型可调用的工具：直接控制桌面上的 Live2D 角色 ----------
  const OUTPUT = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
  ctx.tools.register(defineTool({
    name: 'live2d',
    description: '控制桌面上的 Live2D 角色：说话气泡 / 表情 / 姿势 / 视线 / 待机动作 / 工作状态。舞台没开时返回 ok:false。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['say', 'expression', 'pose', 'look', 'idle', 'state', 'stop'], description: '动作类型' },
      text: { type: 'string', description: 'say：要说的话' },
      name: { type: 'string', description: 'expression：表情名；pose：姿势名；idle：待机动作名；state：状态名（thinking/working/waiting/success/error/idle）' },
      x: { type: 'number', description: 'look：归一化 X（-1..1，0 为正前方）' },
      y: { type: 'number', description: 'look：归一化 Y（-1..1）' },
      ms: { type: 'number', description: '持续时间毫秒（say / look / pose）' },
      task: { type: 'string', description: 'state：当前在做什么的短语，会显示在气泡里' },
    },
    output: OUTPUT,
    async execute(args) {
      const kind = String(args?.kind || '')
      if (kind === 'say') {
        const text = String(args?.text || '').trim()
        if (!text) return { ok: false, error: 'say 需要 text' }
        return sayWithVoice(text, Number(args?.ms) || 0)
      }
      if (kind === 'expression') return stageAction({ kind: 'expression', name: args?.name ? String(args.name) : null })
      if (kind === 'pose') return stageAction({ kind: 'pose', name: args?.name ? String(args.name) : null, ms: Number(args?.ms) || 320 })
      if (kind === 'look') return stageAction({ kind: 'look', x: Number(args?.x) || 0, y: Number(args?.y) || 0, ms: Number(args?.ms) || 2500 })
      if (kind === 'idle') return stageAction({ kind: 'idle', mode: 'play', name: args?.name ? String(args.name) : undefined })
      if (kind === 'state') {
        const st = String(args?.name || 'working')
        const none = ['idle', 'none', 'null'].includes(st)
        return stageAction({ kind: 'state', state: none ? null : st, task: args?.task ? String(args.task) : undefined })
      }
      if (kind === 'stop') return stageAction({ kind: 'stop', scope: 'all' })
      return { ok: false, error: `不认识的 kind：${kind}` }
    },
    presentCall: (args) => ({ card: 'generic', title: `Live2D ${args?.kind || ''}`, kind: 'other', rawInput: args }),
  }))
  ctx.tools.register(defineTool({
    name: 'live2d_status',
    description: '读取 Live2D 角色的当前状态（气泡文字 / 待机动作 / 表情层）以及最近的互动反馈（点、摸、拖）。',
    parameters: {
      since: { type: 'number', description: '只取比这个 seq 更新的互动反馈，默认 0（全部最近记录）' },
    },
    output: OUTPUT,
    async execute(args) {
      const st = await stageFetch('GET', '/api/state')
      if (!st.ok) return st
      const fb = await stageFetch('GET', `/api/feedback?since=${Number(args?.since) || 0}`)
      return { ok: true, state: st.data, feedback: fb.ok ? fb.data : null }
    },
    presentCall: () => ({ card: 'generic', title: 'Live2D 状态', kind: 'read' }),
  }))

  ctx.on('session/event', (session, event) => {
    try {
      // 新会话开场：插件主动报到一次（不依赖模型主动调用；每个会话只做一次）
      // 子代理会话（header.parentSession 存在）不报到，否则一次任务会冒出好几声「连接成功啦」
      if (event?.type === 'turn/start') {
        const sid = sidOf(session)
        const child = !!session?.header?.parentSession
        if (!child && !greeted.has(sid)) {
          greeted.add(sid)
          greetSession().catch(() => {})
        }
      }
      onSessionEvent(session, event)
    } catch (e) { log('session/event 异常：' + (e && e.message)) }
  })
  ctx.on('session/disposed', (session) => {
    try {
      const sid = sidOf(session)
      greeted.delete(sid)
      clearTerminalTimer(sid)
      flags.delete(sid)
      if (sessions.delete(sid)) scheduleWrite()
    } catch {}
  })
  ctx.on('dispose', () => {
    try {
      for (const t of terminalTimers.values()) clearTimeout(t)
      terminalTimers.clear()
      if (writeTimer) clearTimeout(writeTimer)
      sessions.clear()
      flags.clear()
      // 不删状态文件：舞台读不到新状态时按「空闲」处理，文件留着方便排查
      log('卸载')
    } catch {}
  })
}

function applySafe(ctx) {
  try { apply(ctx) } catch (e) {
    try { mkdirSync(DIR, { recursive: true }); writeFileSync(join(DIR, 'bridge-error.log'), String((e && e.stack) || e)) } catch {}
    throw e
  }
}

export { applySafe as apply, inject, name }
