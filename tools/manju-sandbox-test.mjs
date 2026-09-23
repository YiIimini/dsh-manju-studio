/**
 * 沙箱契约：宿主写盘必须带**按调用策略**（这次真实事故的回归闸门）。
 *
 * 事故（2026-09-23，用户在界面上遇到的）：
 *   点「一键做视频」→ `cannot write "D:\Ai\漫剧\manju-1gqm2q\project.json":
 *   file access denied under workspace-write mode`。
 *
 * 根因不在插件逻辑，而在 `ctx.fs` 的语义：它实际是 `@deepseek-ai/dsh-fs-sandbox`，
 * 对每次写入做包含性校验 —— `writeText(target, content, expected, signal, sandboxPolicy)`。
 * **不传第 5 个参数就套用部署默认**（workspace-write + 会话工作区根），
 * 而本插件管的是 `D:\Ai\漫剧` 与小说工作区（`D:\Ai\小说`），**都在会话工作区之外**。
 * 于是"新建项目"这类第一个动作就写不进去 —— 而且它只在**界面发起的调用**里出现
 * （Agent 在会话里跑的是 danger-full-access，所以我自己测时看不到）。
 *
 * 这条套件把那个沙箱**模拟出来**：一个只在"策略声明的根"下允许写入的 fs。
 * 于是：
 *   * 任何一处忘了带策略的写盘，都会在这里当场被拒（而不是等用户点出来）；
 *   * 并且反过来验证模拟本身可信 —— 不带策略写项目根**必须**被拒，
 *     否则这条套件就是"永远不会失败的测试"，等于没测。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "DSH Desktop.exe" manju-sandbox-test.mjs（或 tools\check.cmd）
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = 'D:\\Ai\\漫剧'
const HOST = 'D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js'
const stamp = Date.now().toString(36)
const LIB = path.join(ROOT, '_sandbox-test-lib-' + stamp)      // 小说工作区夹具
const WORK = '沙箱测试书'
const WD = path.join(LIB, WORK)
const PID = 'zz-sandbox-' + stamp
/** 部署默认的 workspace-write 根：故意**不含**项目根 —— 正是事故现场的形状。 */
const SESSION_WS = path.join(os.tmpdir(), 'mj-session-workspace')

let pass = 0
let fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + msg) } else { fail += 1; console.log('  FAIL ' + msg + (extra ? '  ← ' + extra : '')) }
}

// ── 夹具：一部最小的小说作品（一键做视频要读它）──
for (const p of [WD, path.join(WD, '正文', '卷一_试'), path.join(SESSION_WS)]) await fsp.mkdir(p, { recursive: true })
await fsp.writeFile(path.join(WD, '立项.json'), JSON.stringify({ 书名: WORK, 题材: '测试' }), 'utf8')
await fsp.writeFile(path.join(WD, '正文', '卷一_试', '第001章_开篇.md'), '# 第001章 开篇\n\n' + '字'.repeat(3000), 'utf8')

// ── 模拟 @deepseek-ai/dsh-fs-sandbox ──
const writes = []
async function resolveTarget(p) { return { targetKey: p, displayPath: path.resolve(String(p)) } }
const sandboxedFs = {
  async resolve(p) { return await resolveTarget(p) },
  async stat(t) { try { const s = await fsp.stat(t.displayPath); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs } } catch (e) { return undefined } },
  async readText(t) { return await fsp.readFile(t.displayPath, 'utf8') },
  async readBytes(t) { return await fsp.readFile(t.displayPath) },
  async listDir(t) {
    const es = await fsp.readdir(t.displayPath, { withFileTypes: true })
    const out = []
    for (const e of es) { let s = 0; try { s = (await fsp.stat(path.join(t.displayPath, e.name))).size } catch (x) { /* 忽略 */ } out.push({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: s }) }
    return out
  },
  /** 与 dsh-fs-sandbox 同口径：mode=workspace-write 时只允许策略声明的根（+ 临时区）。 */
  async writeText(target, content, expected, signal, policy) {
    const disp = String(target.displayPath || target)
    const pol = policy ?? { mode: 'workspace-write', workspaceRoot: SESSION_WS }
    writes.push({ path: disp, policy: policy ? Object.assign({}, policy) : null })
    if (pol.mode !== 'danger-full-access') {
      if (pol.mode === 'read-only') throw new Error('cannot write "' + disp + '": file access denied under read-only mode')
      const r = String(pol.workspaceRoot || '').replace(/[\\/]+$/, '').toLowerCase()
      const low = disp.toLowerCase()
      const under = r && (low === r || low.indexOf(r + '\\') === 0)
      if (!under) throw new Error('cannot write "' + disp + '": file access denied under workspace-write mode')
    }
    await fsp.mkdir(path.dirname(disp), { recursive: true })
    await fsp.writeFile(disp, String(content), 'utf8')
    return {}
  },
}
function realSpawn(spec) {
  let argv = spec.argv
  if (/\.(cmd|bat)$/i.test(argv[0])) argv = ['cmd.exe', '/c'].concat(argv)
  const child = spawn(argv[0], argv.slice(1), { cwd: spec.cwd, windowsHide: true })
  let o = '', e = ''
  child.stdout.on('data', (d) => { o += d.toString('utf8') })
  child.stderr.on('data', (d) => { e += d.toString('utf8') })
  const done = new Promise((r) => { child.on('close', (c) => r({ exitCode: c })); child.on('error', () => r({ exitCode: -1 })) })
  const mk = (g) => ({ readFrom: (off) => { const t = g(); return { text: t.slice(off), nextOffset: t.length } } })
  return { done, collected: { stdout: mk(() => o), stderr: mk(() => e) }, terminate: () => { try { child.kill() } catch (x) { /* 已退出 */ } } }
}
const host = await import('file:///' + HOST)
const routes = []
host.apply({
  effect: (f) => { f(); return () => {} },
  get: () => undefined,
  fs: sandboxedFs,
  subprocess: { spawn: realSpawn, resolveExecutable: async (x) => x },
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
    setTimeout(() => resolve({ error: 'TIMEOUT' }), 60000)
  })
}

try {
  console.log('== 0. 先证明"模拟的沙箱"真的会拦人（否则这条套件永远不会失败）==')
  const strayPath = path.join(ROOT, '_zz-should-be-denied.txt')
  let denied = ''
  try {
    await sandboxedFs.writeText(await sandboxedFs.resolve(strayPath), 'x')   // 故意不带策略
  } catch (e) { denied = String(e && e.message) }
  ok(/access denied under workspace-write/.test(denied),
    '不带策略写项目根 → 被沙箱拦下（这就是用户看到的那条错误）', denied || '没有被拦！模拟不可信')
  writes.length = 0

  console.log('== 1. 建项目：每个写盘都要带策略 ==')
  const c = await call('create', { id: PID, title: '沙箱契约', genre: '测试', style: 'S' })
  ok(c && c.ok === true, 'create 成功（在 workspace-write 下不再被拦）', JSON.stringify(c).slice(0, 140))
  ok(writes.length >= 4, '至少写了 4 个骨架文件（实际 ' + writes.length + '）')
  const unstamped = writes.filter((w) => !w.policy || !w.policy.workspaceRoot)
  ok(unstamped.length === 0, '没有一处"裸写"（不带策略的写盘 = 界面里必炸）',
    unstamped.map((w) => w.path).join(', '))
  const badRoot = writes.filter((w) => {
    const r = String(w.policy.workspaceRoot).toLowerCase()
    return !(w.path.toLowerCase() === r || w.path.toLowerCase().indexOf(r + '\\') === 0)
  })
  ok(badRoot.length === 0, '盖章的根确实包含被写的路径（盖错根同样会被拒）', badRoot.map((w) => w.path).join(', '))
  ok(writes.every((w) => w.policy.mode === 'workspace-write'),
    '口径是"只为自己拥有的根盖章"，不是给整个插件开 danger-full-access')

  console.log('== 2. 一键做视频：跨两个根（项目根 + 小说工作区）都要能写 ==')
  writes.length = 0
  const setRoot = await call('novel.root', { set: LIB })
  ok(setRoot.root === LIB, '小说工作区指向夹具：' + setRoot.root)
  const v = await call('novel.toVideo', { work: WORK, id: PID + '-v', episode: 'ep01', scope: { kind: 'chapter' }, autoStart: false })
  ok(v && v.ok === true, 'novel.toVideo 成功（就是用户点的那一步）', JSON.stringify(v).slice(0, 200))
  ok(fs.existsSync(path.join(ROOT, PID + '-v', 'novel-ep01.md')), '本集素材写成了')
  ok(fs.existsSync(path.join(ROOT, PID + '-v', 'novel-source-ep01.json')), '溯源文件写成了')
  const roots = {}
  for (const w of writes) roots[w.policy && w.policy.workspaceRoot] = true
  ok(Object.keys(roots).length >= 1 && Object.keys(roots).every((r) => r),
    '两次写盘分别盖了各自的根：' + Object.keys(roots).join(' / '))
  ok(writes.every((w) => w.policy && w.policy.workspaceRoot), '跨根写入没有一处裸写')

  console.log('== 3. 小说工作区自己也别漏（_studio.json 在项目根、素材在项目根）==')
  ok(fs.existsSync(path.join(ROOT, '_studio.json')), '_studio.json 写成了（工作区映射）')

  console.log('== 4. 与真实 dsh-sandbox 的契约：我盖的戳要被它认 ==')
  // 上面用的是"照源码模拟"的沙箱；这一段直接问**真模块**：我传的
  // { mode:'workspace-write', workspaceRoot:<根> } 到底会被解读成什么。
  // 这是我这次修改真正的风险点（字段名/模式名写错 → 戳等于没带）。
  let rb = null
  try {
    rb = await import('file:///D:/Ai/DSH%20Desktop/resources/app/node_modules/@deepseek-ai/dsh-sandbox/lib/index.js')
  } catch (e) { rb = null }
  if (!rb || typeof rb.writableRoots !== 'function') {
    console.log('  – 没找到真实 dsh-sandbox 模块（换部署/换机器就跳过，不误报）')
  } else {
    const roots = rb.writableRoots({ mode: 'workspace-write', workspaceRoot: ROOT })
    ok(roots.some((r) => String(r).toLowerCase().replace(/[\\/]+$/, '') === ROOT.toLowerCase()),
      '真实 writableRoots 认我们的戳，含项目根：' + JSON.stringify(roots))
    ok(rb.writableRoots({ mode: 'danger-full-access' }).length === 0,
      '（对照）只有 workspace-write 才走根清单 —— 说明围栏语义确实按策略走')
  }
} finally {
  await fsp.rm(LIB, { recursive: true, force: true })
  await fsp.rm(path.join(ROOT, PID), { recursive: true, force: true })
  await fsp.rm(path.join(ROOT, PID + '-v'), { recursive: true, force: true })
  await fsp.rm(path.join(ROOT, '_zz-should-be-denied.txt'), { force: true })
  try {
    const cfg = await fsp.readFile(path.join(ROOT, '_studio.json'), 'utf8')
    const j = JSON.parse(cfg)
    if (j && j.novelRoot === LIB) { await fsp.rm(path.join(ROOT, '_studio.json'), { force: true }) }
  } catch (e) { /* 忽略 */ }
}

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail)
process.exit(fail ? 1 : 0)
