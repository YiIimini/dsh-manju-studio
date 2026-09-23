/**
 * 幽灵作业的回归闸门：卡住的管线必须能被看见、被停止、被放行，并且留下日志。
 *
 * 事故（2026-09-23，用户在界面上遇到）：
 *   点完「一键做视频」之后，界面永远只说「已有一条管线在运行（pipe1）。请先等它结束或点「停止」」，
 *   而运行条里**没有任何日志**、也点不到停止 —— 底下其实一个进程都没有（GPU 空闲、ComfyUI 队列空）。
 *   用户被永久挡住，除了重启 DSH 没有出路。
 *
 * 三层根因（都已修，这条套件逐条钉住）：
 *   1. 方案阶段的大模型调用**没有超时** —— `for await (const c of stream)` 会永久挂着，
 *      作业的 running 永远是 true。→ 加空闲闸 + 总时长闸。
 *   2. 宿主只在作业**结束**时落盘日志 —— 于是"卡住的那次"恰恰没有日志（最需要日志的偏偏没有）。
 *      → 看门狗每轮增量落盘。
 *   3. 作业的心跳只存在于内存、且没有任何兜底 —— 一旦某处 await 不返回就没有任何机制收尾。
 *      → 看门狗：静默超过阈值就强制放行，并写明原因。
 *   另外「全局活动」只读 _active.json（驱动器写的），界面起的管线完全不可见 → 现在也报宿主作业。
 *
 * 做法：把看门狗阈值压到秒级（MANJU_JOB_STALE_SEC / MANJU_JOB_TICK_MS），
 * 用一个**永远不结束**的假子进程制造"卡死的作业"，然后断言它被正确处理。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "DSH Desktop.exe" manju-watchdog-test.mjs（或 tools\check.cmd）
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

// 必须在 import 宿主之前设好：阈值是模块加载时读的
process.env.MANJU_JOB_STALE_SEC = '1'
process.env.MANJU_JOB_TICK_MS = '300'

const ROOT = 'D:\\Ai\\漫剧'
const HOST = 'D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js'
const PID = '_watchdog-test-' + Date.now().toString(36)
const DIR = path.join(ROOT, PID)

// 上一次跑被硬杀会留下夹具目录（本套件故意制造"卡死"，最容易被 Ctrl+C 打断）。
// 开跑先扫一遍自己的前缀 —— 只清自己的，不碰真实作品。
try {
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (d.isDirectory() && /^_watchdog-test-/.test(d.name)) {
      fs.rmSync(path.join(ROOT, d.name), { recursive: true, force: true })
    }
  }
} catch (e) { /* 根目录读不到就算了 */ }

let pass = 0
let fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + msg) } else { fail += 1; console.log('  FAIL ' + msg + (extra ? '  ← ' + extra : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 夹具：一个"内容齐备"的项目（好让管线能通过开跑前的内容体检）──
await fsp.mkdir(path.join(DIR, 'output', 'logs'), { recursive: true })
await fsp.writeFile(path.join(DIR, 'project.json'), JSON.stringify({ title: '幽灵作业', episodes: { ep01: '第一集' } }), 'utf8')
await fsp.writeFile(path.join(DIR, 'novel-ep01.md'), '正文'.repeat(300), 'utf8')
await fsp.writeFile(path.join(DIR, 'novel.md'), '正文'.repeat(300), 'utf8')
await fsp.writeFile(path.join(DIR, 'assets.json'), JSON.stringify({ characters: [], scenes: [], props: [] }), 'utf8')

// ── harness：子进程**故意永远不结束**，制造卡死 ──
const spawned = []
function hangSpawn(spec) {
  spawned.push(spec.argv.join(' '))
  let off = 0
  const mk = () => ({ readFrom: () => ({ text: '', nextOffset: off }) })
  return {
    done: new Promise(() => { /* 永不 settle —— 这正是"卡住"的形状 */ }),
    collected: { stdout: mk(), stderr: mk() },
    terminate: () => { /* 连杀都杀不掉：模拟最坏情况 */ },
  }
}
const fsShim = {
  resolve: async (p) => ({ targetKey: p, displayPath: path.resolve(p) }),
  stat: async (t) => { try { const s = await fsp.stat(t.displayPath); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs } } catch (e) { return undefined } },
  readText: async (t) => await fsp.readFile(t.displayPath, 'utf8'),
  writeText: async (t, c) => { await fsp.mkdir(path.dirname(t.displayPath), { recursive: true }); await fsp.writeFile(t.displayPath, c, 'utf8'); return {} },
  listDir: async (t) => {
    const es = await fsp.readdir(t.displayPath, { withFileTypes: true })
    const out = []
    for (const e of es) { let s = 0; try { s = (await fsp.stat(path.join(t.displayPath, e.name))).size } catch (x) { /* 忽略 */ } out.push({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: s }) }
    return out
  },
  readBytes: async (t) => await fsp.readFile(t.displayPath),
}
const host = await import('file:///' + HOST)
const routes = []
host.apply({
  effect: (f) => { f(); return () => {} },
  get: () => undefined,
  fs: fsShim,
  subprocess: { spawn: hangSpawn, resolveExecutable: async (x) => x },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
})
const api = routes.filter((r) => r.path === '/api/manju-studio')[0]
function call(cmd, args) {
  return new Promise((resolve) => {
    const hs = {}
    const req = {
      method: 'POST', url: '/api/manju-studio',
      on: (ev, cb) => { hs[ev] = cb; if (ev === 'end') setTimeout(() => { hs.data && hs.data(Buffer.from(JSON.stringify({ cmd, args }))); hs.end() }, 0) },
    }
    const res = { writeHead: () => {}, end: (b) => { try { resolve(JSON.parse(String(b))) } catch (e) { resolve({ error: 'BADJSON ' + String(b).slice(0, 160) }) } } }
    api.handler(req, res)
    setTimeout(() => resolve({ error: 'TIMEOUT' }), 30000)
  })
}
const cleanup = async () => { await fsp.rm(DIR, { recursive: true, force: true }) }
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }) } catch (e) { /* 忽略 */ } })

try {
  console.log('== 1. 起一个"永远跑不完"的作业 ==')
  const st = await call('pipelineStart', { id: PID, only: ['env'], episode: 'ep01' })
  ok(st && st.ok === true && !!st.jobId, '作业起来了：' + (st && st.jobId), JSON.stringify(st).slice(0, 140))
  const jid = st.jobId
  await sleep(300)

  console.log('== 2. 它必须"看得见"（这是用户抱怨的核心：说在跑、日志空白）==')
  const list = await call('jobs.list', {})
  const me = (list.jobs || []).filter((j) => j.jobId === jid)[0]
  ok(!!me && me.running === true, 'jobs.list 报出它在跑')
  ok(!!me && me.project === PID && !!me.stage, '并且说清是哪个项目、在哪个阶段：' + (me && (me.project + ' / ' + me.stage)))
  const act = await call('activity', {})
  ok(act && act.running === true, '全局活动（运行条的数据源）也认为有作业在跑')
  ok(act && act.hostJobId === jid, '并且给出宿主作业 id（界面据此显示"停止"）：' + (act && act.hostJobId))
  ok(act && act.active && act.active.project === PID, '运行条能显示项目名（不再是一片空白）')

  console.log('== 3. 挡住新管线时，要告诉用户"它在干嘛 + 怎么脱困" ==')
  const blocked = await call('pipelineStart', { id: PID, only: ['env'] })
  const em = String((blocked && blocked.error) || '')
  ok(em.indexOf(jid) >= 0 && em.indexOf('已跑') >= 0, '错误里点名是哪个作业、跑了多久')
  ok(em.indexOf('强制解除') >= 0, '并且给出脱困办法（强制解除）')
  ok(blocked && blocked.busy && blocked.busy.jobId === jid, '附带结构化信息（界面可用）')

  console.log('== 4. 看门狗：静默超阈值 → 强制放行 + 留下日志 ==')
  await sleep(2200)   // 阈值 1s + 巡检 0.3s
  const list2 = await call('jobs.list', {})
  const me2 = (list2.jobs || []).filter((j) => j.jobId === jid)[0]
  ok(!!me2 && me2.running === false, '卡死的作业已被放行（不再永久挡住界面）')
  ok(!!me2 && me2.stalled === true, '并且标记为"卡死"而不是"正常结束"')
  const logRel = me2 && me2.logRel
  ok(!!logRel, '作业留下了日志路径：' + logRel)
  let logText = ''
  if (logRel) { try { logText = await fsp.readFile(path.join(DIR, logRel.replace(/\//g, '\\')), 'utf8') } catch (e) { /* 读不到 */ } }
  ok(logText.indexOf('[看门狗]') >= 0, '日志里写明是看门狗放行的（不是无声消失）')
  const lg = await call('logs.list', { id: PID })
  ok((lg.logs || []).some((x) => /^pipe\d*-/.test(String(x.name))),
    '界面的日志清单里能看到这份作业日志（名字形如 pipe1-<时间>.log）',
    JSON.stringify(lg).slice(0, 200))

  console.log('== 5. 放行之后，用户必须能立刻重新开跑 ==')
  const again = await call('pipelineStart', { id: PID, only: ['env'] })
  ok(again && again.ok === true && !!again.jobId, '新作业起得来（界面不再被死锁）', JSON.stringify(again).slice(0, 140))
  const jid2 = again.jobId

  console.log('== 6. 点「停止」必须**立即**放行（卡住的作业收不到停止信号）==')
  const stopped = await call('pipelineStop', { jobId: jid2 })
  ok(stopped && stopped.ok === true, '停止返回 ok', JSON.stringify(stopped).slice(0, 120))
  const list3 = await call('jobs.list', {})
  const me3 = (list3.jobs || []).filter((j) => j.jobId === jid2)[0]
  ok(!!me3 && me3.running === false, '立刻就不在"运行中"了（不必等管线自己发现）')

  console.log('== 7. force：用户确认没在跑时，一条命令放行 ==')
  const j3 = await call('pipelineStart', { id: PID, only: ['env'] })
  await sleep(200)
  const forced = await call('pipelineStart', { id: PID, only: ['env'], force: true })
  ok(forced && forced.ok === true, '带 force 能直接开新作业', JSON.stringify(forced).slice(0, 140))
  ok(spawned.length >= 3, '确实反复起过子进程（夹具真的在跑）')
  await call('pipelineStop', {})
} finally {
  await cleanup()
}

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail)
process.exit(fail ? 1 : 0)
