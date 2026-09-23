/** 状态扫描：真实项目数据 × 各种界面状态，找出哪一组会让渲染抛异常。 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const HOST = 'D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js'
const CLIENT = 'D:\\Ai\\DSH-plugins\\dsh-manju-studio\\lib\\client.js'
const ROOT = 'D:\\Ai\\漫剧'

/**
 * 项目选择：参数 > 环境变量 > 当前活跃项目 > 第一个真实项目。
 * 原先写死 yaolu-yeyu：那个项目一被删，这条套件表面上还在跑（45 条全过），
 * 实际喂给界面的是 read 回的 error 载荷 —— "真实数据"这个前提悄悄没了，绿灯是假的。
 */
function pickProject() {
  const explicit = String(process.argv[2] || '').trim()
  if (explicit && fs.existsSync(path.join(ROOT, explicit))) return explicit
  const env = String(process.env.MANJU_SWEEP_PROJECT || '').trim()
  if (env && fs.existsSync(path.join(ROOT, env))) return env
  try {
    const a = JSON.parse(fs.readFileSync(path.join(ROOT, '_active.json'), 'utf8'))
    const p = String(a.project || '').trim()
    if (p && fs.existsSync(path.join(ROOT, p))) return p
  } catch (e) { /* 没有活跃项目指针是正常状态 */ }
  try {
    const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !/^[_.]/.test(d.name) && !/^zz-/.test(d.name))
      .map((d) => d.name)
    for (const d of dirs) if (fs.existsSync(path.join(ROOT, d, 'project.json'))) return d
  } catch (e) { /* 根目录读不到就算了 */ }
  return ''
}

const PID = pickProject()

function realSpawn(spec) {
  let argv = spec.argv
  if (/\.(cmd|bat)$/i.test(argv[0])) argv = ['cmd.exe', '/c'].concat(argv)
  const c = spawn(argv[0], argv.slice(1), { cwd: spec.cwd, windowsHide: true, env: spec.env || process.env })
  let o = '', e = ''
  c.stdout.on('data', (d) => { o += d.toString('utf8') })
  c.stderr.on('data', (d) => { e += d.toString('utf8') })
  const done = new Promise((r) => { c.on('close', (x) => r({ exitCode: x })); c.on('error', () => r({ exitCode: -1 })) })
  const rd = (g) => ({ readFrom: (off) => { const t = g(); return { text: t.slice(off), nextOffset: t.length } } })
  return { done, collected: { stdout: rd(() => o), stderr: rd(() => e) }, terminate: () => { try { c.kill() } catch (x) {} } }
}
const fsShim = {
  resolve: async (p) => ({ targetKey: p, displayPath: path.resolve(p) }),
  stat: async (t) => { try { const s = await fsp.stat(t.displayPath); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size } } catch (e) { return undefined } },
  readText: async (t) => await fsp.readFile(t.displayPath, 'utf8'),
  writeText: async (t, c) => { await fsp.mkdir(path.dirname(t.displayPath), { recursive: true }); await fsp.writeFile(t.displayPath, c, 'utf8'); return {} },
  listDir: async (t) => {
    const es = await fsp.readdir(t.displayPath, { withFileTypes: true })
    const out = []
    for (const e of es) { let s = 0; try { s = (await fsp.stat(path.join(t.displayPath, e.name))).size } catch (x) {} out.push({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: s }) }
    return out
  },
  readBytes: async (t) => await fsp.readFile(t.displayPath),
}
const host = await import('file:///' + HOST)
const routes = []
host.apply({ effect: (f) => { f(); return () => {} }, get: () => undefined,
  fs: fsShim, subprocess: { spawn: realSpawn },
  webServer: { register: (r) => { routes.push(r); return () => {} } } })
const api = routes.filter((r) => r.path === '/api/manju-studio')[0]
function call(cmd, args) {
  return new Promise((resolve) => {
    const hs = {}
    const req = { method: 'POST', url: '/api/manju-studio',
      on: (ev, cb) => { hs[ev] = cb; if (ev === 'end') setTimeout(() => { hs.data && hs.data(Buffer.from(JSON.stringify({ cmd, args }))); hs.end() }, 0) } }
    const res = { writeHead: () => {}, end: (b) => resolve(JSON.parse(String(b))) }
    api.handler(req, res)
    setTimeout(() => resolve({ error: 'TIMEOUT' }), 60000)
  })
}
const boot = await call('boot', {})
const proj = await call('read', { id: PID })
const params = await call('params.get', { id: PID })
const prod = await call('products', { id: PID })
const sysinfo = await call('sysinfo', {})
const presets = await call('style.presets', {})

const src = fs.readFileSync(CLIENT, 'utf8')
let hookIdx = 0
let overrides = []
const ReactShim = {
  createElement: (type, props, ...kids) => {
    const p = Object.assign({}, props || {})
    if (kids.length === 1) p.children = kids[0]
    else if (kids.length > 1) p.children = kids
    return { __el: true, type, props: p }
  },
  useRef: (init) => ({ current: init }),
  Component: class {
    constructor(p) { this.props = p || {}; this.state = {}; this.setState = () => {}; }
    render() { return null; }
  },
  useCallback: (fn) => fn,
  memo: (c) => c, useMemo: (f) => f(),
  useEffect: () => {},
  useState: (init) => { const i = hookIdx++; return [overrides[i] === undefined ? init : overrides[i], () => {}] },
}
let factory = null
globalThis.window = { __ModuleLoader__: { load: (o) => { factory = o.factory } } }
globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }), head: { appendChild() {} } }
fs.writeFileSync(process.env.TEMP + '/__mj_sweep_client.mjs', src)
await import('file:///' + process.env.TEMP.replace(/\\/g, '/') + '/__mj_sweep_client.mjs')
const captured = []
factory((n) => { if (n === 'react') return ReactShim; throw new Error('unknown require ' + n) })
  .apply({ effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
    slots: { inject: (n, cb) => cb(), register: (reg, comp) => { captured.push({ reg, comp }); return () => {} } } })
const Studio = captured.filter((c) => c.reg.name === 'main')[0].comp

const JOB_IDLE = { running: false, exitCode: 0, stages: [], progress: null, log: [] }
const JOB_RUN = {
  running: true, exitCode: null, jobId: 'pipe1',
  stages: (['env', 'plan', 'asset', 'encode', 'render', 'judge', 'merge']).map((k, i) => ({ key: k, name: k, state: i < 3 ? 'done' : (i === 3 ? 'running' : 'pending'), note: '' })),
  progress: { label: 's03 渲染中', done: 2, total: 7 },
  log: ['[1/7] s01 完成 407.5s', '[2/7] s02 完成 201.0s'],
}
const shot0 = ((proj.shotsDoc && proj.shotsDoc.shots) || [])[0] || {}
const clip0 = ((prod.clips) || [])[0] || {}
const clipTake = ((prod.clips) || []).filter((c) => c.take)[0] || clip0

function mk(o) {
  const a = []
  a[0] = o.view === undefined ? 'video' : o.view
  a[1] = boot
  a[2] = sysinfo
  a[3] = o.err || ''
  a[4] = o.busy || ''
  a[5] = o.noPid ? '' : PID
  a[6] = o.noPid ? null : proj
  a[7] = o.paramsNull ? null : (o.paramsEmpty ? {} : params)
  a[8] = [{ id: 'deepseek', name: 'DeepSeek', models: ['deepseek-chat'] }]
  a[9] = o.prodEmpty ? { characters: [], scenes: [], props: [], clips: [] } : prod
  a[10] = o.novel === undefined ? '正文' : o.novel
  a[12] = 'script/ep01.md'
  a[13] = '# 剧本'
  a[15] = [{ name: 'ep01.md', rel: 'script/ep01.md', size: 1024 }]
  a[16] = o.source || 'novel'
  a[19] = { chapter: '', episode: '', shots: '' }
  a[20] = { total: 7, picked: 7, by: '全本', filtered: false }
  a[21] = o.job || JOB_IDLE
  a[22] = o.logOpen === undefined ? true : o.logOpen
  a[23] = o.prodTab || 'characters'
  a[24] = 'ComfyUI OK'
  a[25] = !!o.showNew
  a[26] = !!o.showCast
  a[27] = { id: '', title: '', genre: '', style: '' }
  a[28] = { kind: 'characters', srcPath: '', name: '', desc: '' }
  a[29] = o.prodOpen === undefined ? true : o.prodOpen
  a[30] = presets.presets || []
  a[31] = 'all'
  a[32] = o.sideOpen === undefined ? true : o.sideOpen
  a[33] = o.detailShot || null
  a[34] = o.qcRep || null
  a[35] = o.sideTab || 'params'
  a[36] = o.comfy || { up: true, port: '8199', pids: ['1'], managed: true, vram: { usedMB: 1000, totalMB: 24463, freeMB: 23000 } }
  a[37] = o.imgModels || null
  a[38] = o.renaming || ''
  a[39] = o.notice || ''
  a[40] = o.menuFor || ''
  a[41] = o.menuAt || { x: 0, y: 0 }
  a[42] = o.viewer || null
  a[43] = o.confirm || null
  return a
}

function render(el, out, depth) {
  if (depth > 90) { out.bad.push('嵌套过深'); return }
  if (el === null || el === undefined || typeof el === 'boolean') return
  if (Array.isArray(el)) { el.forEach((x) => render(x, out, depth + 1)); return }
  if (typeof el === 'string' || typeof el === 'number') { out.text++; return }
  if (!el.__el) { out.bad.push('非元素'); return }
  // 真实 React 对这两类会抛错并卸载整棵树（= 白屏），木桩必须同样严格：
  //   ① type 为 undefined/null/其它非字符串非函数值 → "Element type is invalid"
  //   ② children 里出现对象 → "Objects are not valid as a React child"
  if (typeof el.type !== 'string' && typeof el.type !== 'function') {
    throw new Error('Element type is invalid: ' + String(el.type) + '（props: ' + Object.keys(el.props || {}).join(',') + '）')
  }
  if (typeof el.type === 'function' && el.type.prototype && typeof el.type.prototype.render === 'function') {
    const inst = new el.type(el.props)
    inst.props = el.props
    if (!inst.state || !inst.state.err) render(inst.render(), out, depth + 1)
    return
  }
  if (typeof el.type === 'function') { render(el.type(el.props), out, depth + 1); return }
  out.nodes++
  out.tags[el.type] = (out.tags[el.type] || 0) + 1
  for (const k of Object.keys(el.props)) {
    const v = el.props[k]
    if (k === 'children') continue
    if (typeof v === 'string' && (v.indexOf('undefined') >= 0 || v.indexOf('NaN') >= 0)) out.bad.push(el.type + '.' + k + '=' + v.slice(0, 50))
  }
  render(el.props.children, out, depth + 1)
}

const CASES = []
for (const view of ['video', 'comfy']) {
  for (const sideTab of ['content', 'params', 'render', 'engine', 'pipe']) {
    CASES.push({ name: view + '/' + sideTab, view, sideTab })
  }
}
for (const prodTab of ['characters', 'scenes', 'props', 'clips']) CASES.push({ name: 'prod-' + prodTab, prodTab })
CASES.push({ name: '运行中', job: JOB_RUN })
CASES.push({ name: '日志收起', logOpen: false })
CASES.push({ name: '侧栏收起', sideOpen: false })
CASES.push({ name: '产物收起', prodOpen: false })
CASES.push({ name: '新建项目弹窗', showNew: true })
CASES.push({ name: '角色管理弹窗', showCast: true })
CASES.push({ name: '镜头详情弹窗', detailShot: shot0 })
CASES.push({ name: '质检报告弹窗', qcRep: { total: 7, failed: 0, warned: 0, byFile: {}, reports: [] } })
CASES.push({ name: '改名中', renaming: PID })
CASES.push({ name: '菜单展开', menuFor: PID })
CASES.push({ name: '错误态', err: '出错了' })
CASES.push({ name: '忙碌态', busy: '渲染中' })
CASES.push({ name: '空正文', novel: '' })
CASES.push({ name: '脚本模式', source: 'script' })
// ★ 关键用例：params 为空 + 未打开项目 —— 这正是页面刚加载时的真实状态。
//   之前的扫描全部传了非空 params，所以漏掉了 stylePreview 的 null 解引用。
CASES.push({ name: '空参数/无项目', paramsEmpty: true, noPid: true })
CASES.push({ name: '空参数/有项目', paramsEmpty: true })
CASES.push({ name: '空参数/render页', paramsEmpty: true, noPid: true, sideTab: 'render' })
CASES.push({ name: '空参数/engine页', paramsEmpty: true, noPid: true, sideTab: 'engine' })
CASES.push({ name: '空参数/管线页', paramsEmpty: true, noPid: true, sideTab: 'pipe' })
CASES.push({ name: '空参数/内容页', paramsEmpty: true, noPid: true, sideTab: 'content' })
CASES.push({ name: '空产物', prodEmpty: true, noPid: true })
// ★ 最强用例：params 直接给 null（原始 bug 的状态）。
//   函数内的本地兜底必须扛住 —— 这样即使有人把初值改回 null 也不会白屏。
CASES.push({ name: 'params=null/参数页', paramsNull: true, noPid: true, sideTab: 'params' })
CASES.push({ name: 'params=null/渲染页', paramsNull: true, noPid: true, sideTab: 'render' })
CASES.push({ name: 'params=null/引擎页', paramsNull: true, noPid: true, sideTab: 'engine' })
// ★★ 精确复现"点项目白屏"：**pid 已设、params 还是 null**。
//   openProject 的顺序是 setPid → 渲染 → await params.get → setParams，
//   中间这一帧就是崩溃窗口；而 colParams 的 stylePreview() 只在 !pid 为假时才被调用，
//   所以上面那些带 noPid 的用例全部走不到它。
CASES.push({ name: '★崩溃窗口 pid+params=null', paramsNull: true, sideTab: 'params' })
CASES.push({ name: '★崩溃窗口 pid+params空对象', paramsEmpty: true, sideTab: 'params' })
// 灯箱与自绘确认框
CASES.push({ name: '灯箱-单图', viewer: { items: [{ src: '/x.png', label: '参考图' }], index: 0 } })
CASES.push({ name: '灯箱-多图翻页', viewer: { items: [{ src: '/a.png', label: 'a' }, { src: '/b.png', label: 'b' }, { src: '/c.png', label: 'c' }], index: 1 } })
CASES.push({ name: '灯箱-视频', viewer: { items: [{ src: '/s01.mp4', label: 's01', kind: 'video' }], index: 0 } })
CASES.push({ name: '灯箱-空批', viewer: { items: [], index: 0 } })
CASES.push({ name: '确认框-移入回收站', confirm: { kind: 'remove', id: 'luohua', title: '落花灵根' } })

let bad = 0
console.log('扫描 ' + CASES.length + ' 组状态（' + (PID ? '真实数据 ' + PID : '⚠ 没有可用的真实项目，本轮用例全走空数据分支') + '）…\n')
for (const c of CASES) {
  const out = { nodes: 0, text: 0, tags: {}, bad: [] }
  let err = null
  hookIdx = 0
  overrides = mk(c)
  try { render(Studio(), out, 0) } catch (e) { err = e }
  if (err) {
    bad++
    console.log('  ✕ ' + c.name + '  抛异常: ' + err.message)
    console.log('      ' + String(err.stack).split('\n').slice(1, 4).map((l) => l.trim()).join('\n      '))
  } else if (out.bad.length) {
    bad++
    console.log('  ✕ ' + c.name + '  坏属性: ' + out.bad.slice(0, 3).join(' | '))
  } else if (out.nodes === 0) {
    bad++
    console.log('  ✕ ' + c.name + '  渲染出 0 个节点（等于白屏）')
  } else {
    console.log('  ✓ ' + c.name.padEnd(18) + ' 节点 ' + out.nodes + ' 按钮 ' + (out.tags.button || 0))
  }
}
console.log('\n' + (bad ? '有 ' + bad + ' 组异常' : '全部正常'))
process.exit(bad ? 1 : 0)
