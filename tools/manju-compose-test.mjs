/**
 * 宿主合成路径的契约测试（界面「合成」按钮真正走的那一条）。
 *
 * 为什么值得单独一条套件：
 *   * 这条路径以前**只有源码文本断言**（"函数存在""标签写对了"），没有一次真的合成过。
 *     而它恰恰是用户日常点的那条：分集命名、字幕卡四类、叠化时字幕尾部扣减、
 *     成片落盘位置 —— 任何一处错了，界面上都只是"成片看起来怪怪的"。
 *   * 驱动器那条路径（tools/manju_headless/subtitles.py）已经有行为锁了，
 *     两半必须**逐字同口径**（同一份 ASS 语义），这条套件负责证明宿主这半也是真的。
 *
 * 做法：造一个 2 镜的极小项目（320×192、1 秒、带音轨，用 ffmpeg 现生成），
 * 真调一次 `assemble`，然后把产出的 ASS 拆开逐条量。跑完把夹具删干净。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "DSH Desktop.exe" manju-compose-test.mjs（或 tools\check.cmd）
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = 'D:\\Ai\\漫剧'
const HOST = 'D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js'
const PID = '_compose-test-' + Date.now().toString(36)
const DIR = path.join(ROOT, PID)

let pass = 0
let fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + msg) } else { fail += 1; console.log('  FAIL ' + msg + (extra ? '  ← ' + extra : '')) }
}

// ── 夹片：1 秒、320×192、带音轨（有音轨才能走 loudnorm；无声片会让合成直接失败）──
function ff(args) {
  return new Promise((resolve) => {
    const c = spawn('ffmpeg', args, { windowsHide: true })
    let e = ''
    c.stderr.on('data', (d) => { e += d.toString() })
    c.on('close', (code) => resolve({ code, err: e.slice(-400) }))
  })
}
await fsp.mkdir(path.join(DIR, 'output'), { recursive: true })
for (const sid of ['ep01-s01', 'ep01-s02']) {
  const r = await ff(['-y', '-f', 'lavfi', '-i', 'color=c=navy:s=320x192:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    path.join(DIR, sid + '.mp4')])
  if (r.code !== 0) { console.log('  夹具生成失败（ffmpeg）：' + r.err); process.exit(1) }
}
await fsp.writeFile(path.join(DIR, 'project.json'), JSON.stringify({
  title: '合成契约', episodes: { ep01: '第一集 · 夹具' },
  params: { width: 320, height: 192, loudness: -16, subtitles: true, subtitleSize: 6 },
}, null, 2), 'utf8')
await fsp.writeFile(path.join(DIR, 'plan.json'), JSON.stringify({
  project: PID, style: 'TEST',
  characters: [], scenes: [],
  shots: [
    { id: 'ep01-s01', episode: 'ep01', dialogue: [
      { speaker: '老周', text: '八文一斤。' },
      { speaker: '', text: '剩余 3 天', kind: 'sys' },
    ] },
    { id: 'ep01-s02', episode: 'ep01', dialogue: [
      { speaker: '', text: '这也太贵了', kind: 'danmaku' },
      { speaker: '', text: '轰', kind: 'sfx' },
    ] },
  ],
}, null, 2), 'utf8')
await fsp.writeFile(path.join(DIR, 'assets.json'), JSON.stringify({ characters: [], scenes: [], props: [] }), 'utf8')

// ── 宿主 harness（真文件系统 + 真子进程：合成本来就要调 ffmpeg）──
function realSpawn(spec) {
  let argv = spec.argv
  if (/\.(cmd|bat)$/i.test(argv[0])) argv = ['cmd.exe', '/c'].concat(argv)
  const child = spawn(argv[0], argv.slice(1), { cwd: spec.cwd, windowsHide: true })
  let o = ''
  let e = ''
  child.stdout.on('data', (d) => { o += d.toString('utf8') })
  child.stderr.on('data', (d) => { e += d.toString('utf8') })
  const done = new Promise((r) => { child.on('close', (c) => r({ exitCode: c })); child.on('error', () => r({ exitCode: -1 })) })
  const mk = (g) => ({ readFrom: (off) => { const t = g(); return { text: t.slice(off), nextOffset: t.length } } })
  return { done, collected: { stdout: mk(() => o), stderr: mk(() => e) }, terminate: () => { try { child.kill() } catch (x) { /* 已退出 */ } } }
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
    setTimeout(() => resolve({ error: 'TIMEOUT' }), 180000)
  })
}
const cleanup = async () => { await fsp.rm(DIR, { recursive: true, force: true }) }
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }) } catch (e) { /* 忽略 */ } })

const tsec = (t) => { const p = String(t).split(/[:.]/); return Number(p[0]) * 3600 + Number(p[1]) * 60 + Number(p[2]) + Number(p[3] || 0) / 100 }

try {
  console.log('== 1. 分集合成：成片-<集>.mp4 + output/final-<集>.ass ==')
  const r = await call('assemble', { id: PID, episode: 'ep01', transition: 'cut' })
  ok(r && r.ok === true, '合成成功', JSON.stringify(r).slice(0, 160))
  ok(r && r.file === '成片-ep01.mp4', '成片命名带集号：' + (r && r.file))
  ok(fs.existsSync(path.join(DIR, '成片-ep01.mp4')), '成片真的落盘了')
  ok(r && r.clips === 2, '合进了 2 镜（' + (r && r.clips) + '）')
  ok(r && r.width === 320 && r.height === 192, '画布取项目参数（' + (r && r.width) + 'x' + (r && r.height) + '）')
  const assPath = path.join(DIR, 'output', 'final-ep01.ass')
  ok(fs.existsSync(assPath), '字幕写在 output/final-ep01.ass（带集号，不串集）')
  ok(!fs.existsSync(path.join(DIR, 'output', 'final.ass')), '没写项目级 final.ass（分集就该分开）')

  console.log('== 2. 字幕卡四类真的进了 ASS ==')
  const ass = await fsp.readFile(assPath, 'utf8')
  ok(/Style: 对白,/.test(ass) && /Style: 旁白,/.test(ass), '对白/旁白样式在')
  ok(/Style: 系统,/.test(ass) && /Style: 弹幕,/.test(ass) && /Style: 音效,/.test(ass),
    '字幕卡三类样式**有定义**（引用未定义样式会让画面随播放器漂移）')
  const lines = ass.split(/\r?\n/).filter((l) => l.startsWith('Dialogue: '))
  ok(lines.length === 4, '四条台词各出一行（实际 ' + lines.length + '）')
  const styles = lines.map((l) => l.split(',')[3])
  ok(styles.join('|') === '对白|系统|弹幕|音效', '四类样式按台词顺序落位：' + styles.join('|'))
  const sysLine = lines[styles.indexOf('系统')]
  ok(/\\an7\\pos\(/.test(sysLine), '系统提示定位在左上（\\an7）')
  ok(/\\bord7/.test(lines[styles.indexOf('音效')]), '音效大字带粗描边')
  ok(/\{\\fad\(/.test(lines[0]) && !/系统：/.test(sysLine), '普通台词有淡入、字幕卡不带说话人前缀')
  ok(lines.every((l) => l.indexOf('\\N') < 0), '单行不折行')

  console.log('== 3. 字幕不重叠（转场处两条同时在屏 = 观众读作不连贯）==')
  const evs = lines.map((l) => { const p = l.split(','); return { s: tsec(p[1]), e: tsec(p[2]) } })
  let ov = 0
  for (let i = 0; i < evs.length - 1; i++) if (evs[i + 1].s < evs[i].e - 0.001) ov += 1
  ok(ov === 0, '无重叠', ov + ' 处')

  console.log('== 4. 不分集时仍写项目级成片（老用法不能被破坏）==')
  const r2 = await call('assemble', { id: PID, transition: 'cut' })
  ok(r2 && r2.ok === true && r2.file === '成片.mp4', '不分集 → 成片.mp4', (r2 && r2.file) || JSON.stringify(r2).slice(0, 120))
  ok(fs.existsSync(path.join(DIR, '成片.mp4')) && fs.existsSync(path.join(DIR, 'output', 'final.ass')),
    '项目级成片与字幕都在')

  console.log('== 5. 分集隔离：别的集的镜头不许混进来 ==')
  await fsp.writeFile(path.join(DIR, 'ep02-s01.mp4'), await fsp.readFile(path.join(DIR, 'ep01-s01.mp4')))
  const r3 = await call('assemble', { id: PID, episode: 'ep01', transition: 'cut' })
  ok(r3 && r3.clips === 2, 'ep01 仍然只合 2 镜（不是 3）—— 按 <集>- 前缀裁镜头', (r3 && r3.clips) + '')
  const r4 = await call('assemble', { id: PID, episode: 'ep03', transition: 'cut' })
  ok(r4 && !!r4.error, '没有这一集的镜头时给出明确错误：' + String(r4 && r4.error).slice(0, 40))
} finally {
  await cleanup()
}

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail)
process.exit(fail ? 1 : 0)
