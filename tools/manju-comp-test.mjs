/**
 * 合规标注真机测试：用真 ffmpeg 造小 mp4 → 走插件的 assemble → 检查 final.ass。
 * 关键断言：① 两条常驻标注事件存在 ② 字幕底边距被顶到预留区之上（≥12% 画高）
 *          ③ 关掉合规时底边距回到 6%
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = 'D:\\Ai\\漫剧'
const PID = '_comp-test'
const DIR = path.join(ROOT, PID)
const HOST = 'D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js'
const FF = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe'

const fails = []
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails.push(m) }

await fsp.rm(DIR, { recursive: true, force: true })
await fsp.mkdir(DIR, { recursive: true })
await fsp.writeFile(path.join(DIR, 'project.json'), JSON.stringify({
  title: '合规测试',
  params: { width: 1344, height: 768, subtitles: true, subtitleSize: 5, compliance: 'hongguo', transition: 'cut', loudness: -16 },
}), 'utf8')
await fsp.writeFile(path.join(DIR, 'assets.json'), JSON.stringify({ characters: [], scenes: [], props: [] }), 'utf8')
await fsp.writeFile(path.join(DIR, 'plan.json'), JSON.stringify({
  shots: [{ id: 's01', dialogue: [{ speaker: '林小满', text: '这是一句测试台词。' }] }],
}), 'utf8')

// 真 ffmpeg 造一个 1 秒的合法 mp4（带音轨，否则合成会失败）
for (const n of ['s01', 's02']) {
  const r = spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=navy:s=1344x768:d=1:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', path.join(DIR, n + '.mp4')], { encoding: 'utf8' })
  if (r.status !== 0) { console.log('  造素材失败: ' + (r.stderr || '').slice(0, 200)) }
}
ok(fs.existsSync(path.join(DIR, 's01.mp4')), 'ffmpeg 造出真 mp4 素材')

function realSpawn(spec) {
  let argv = spec.argv
  if (/\.(cmd|bat)$/i.test(argv[0])) argv = ['cmd.exe', '/c'].concat(argv)
  const child = spawn(argv[0], argv.slice(1), { cwd: spec.cwd, windowsHide: true, env: spec.env || process.env })
  let o = '', e = ''
  child.stdout.on('data', (d) => { o += d.toString('utf8') })
  child.stderr.on('data', (d) => { e += d.toString('utf8') })
  const done = new Promise((r) => { child.on('close', (c) => r({ exitCode: c })); child.on('error', () => r({ exitCode: -1 })) })
  const rdr = (g) => ({ readFrom: (off) => { const t = g(); return { text: t.slice(off), nextOffset: t.length } } })
  return { done, collected: { stdout: rdr(() => o), stderr: rdr(() => e) }, terminate: () => { try { child.kill() } catch (x) {} } }
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
function call(cmd, args, t) {
  return new Promise((resolve) => {
    const hs = {}
    const req = { method: 'POST', url: '/api/manju-studio',
      on: (ev, cb) => { hs[ev] = cb; if (ev === 'end') setTimeout(() => { hs.data && hs.data(Buffer.from(JSON.stringify({ cmd, args }))); hs.end() }, 0) } }
    const res = { writeHead: (s) => { res._s = s }, end: (b) => resolve({ status: res._s, body: String(b) }) }
    api.handler(req, res)
    setTimeout(() => resolve({ status: 0, body: 'TIMEOUT' }), t || 180000)
  })
}
const J = (r) => { try { return JSON.parse(r.body) } catch (e) { return { raw: r.body.slice(0, 200) } } }
const H = 768
const readAss = () => fs.readFileSync(path.join(DIR, 'output', 'final.ass'), 'utf8')

console.log('=== 开合规：合成并检查 ASS ===')
const a1 = J(await call('assemble', { id: PID }, 180000))
console.log('  assemble -> ' + JSON.stringify(a1).slice(0, 200))
ok(a1.ok === true, '合规模式下合成成功')
if (fs.existsSync(path.join(DIR, 'output', 'final.ass'))) {
  const ass = readAss()
  const lines = ass.split('\n')
  const compEvents = lines.filter((l) => l.indexOf('Dialogue:') === 0 && l.indexOf(',合规,') > 0)
  console.log('  合规事件 ' + compEvents.length + ' 条：')
  compEvents.forEach((l) => console.log('    ' + l.slice(0, 130)))
  ok(compEvents.length === 2, '两条常驻合规标注（底部一行 + 右侧竖排）')
  ok(compEvents.some((l) => l.indexOf('禁止现实模仿') > 0), '底部标注文案正确')
  ok(compEvents.some((l) => l.indexOf('\\frz270') > 0 && l.indexOf('\\pos(') > 0), '右侧竖排用了旋转 + 绝对定位')

  // 字幕样式 对白 的 MarginV 必须 >= 12% 画高
  const styleLine = lines.find((l) => l.indexOf('Style: 对白,') === 0)
  ok(!!styleLine, '找到对白样式行')
  if (styleLine) {
    const mv = Number(styleLine.split(',')[21])
    console.log('  对白 MarginV = ' + mv + 'px = ' + (mv / H * 100).toFixed(1) + '% 画高')
    ok(mv >= Math.round(H * 0.12), '字幕底边距被顶到预留区之上（≥12%）')
  }
} else { ok(false, '没生成 final.ass') }

console.log('=== 关合规：底边距回到 6% ===')
const pj = JSON.parse(fs.readFileSync(path.join(DIR, 'project.json'), 'utf8'))
pj.params.compliance = ''
fs.writeFileSync(path.join(DIR, 'project.json'), JSON.stringify(pj), 'utf8')
const a2 = J(await call('assemble', { id: PID, subtitles: true }, 180000))
ok(a2.ok === true, '无合规模式下合成成功')
if (fs.existsSync(path.join(DIR, 'output', 'final.ass'))) {
  const ass = readAss()
  const lines = ass.split('\n')
  const compEvents = lines.filter((l) => l.indexOf('Dialogue:') === 0 && l.indexOf(',合规,') > 0)
  ok(compEvents.length === 0, '无合规时没有标注事件')
  const styleLine = lines.find((l) => l.indexOf('Style: 对白,') === 0)
  if (styleLine) {
    const mv = Number(styleLine.split(',')[21])
    console.log('  对白 MarginV = ' + mv + 'px = ' + (mv / H * 100).toFixed(1) + '% 画高')
    ok(mv === Math.round(H * 0.06), '底边距回到 6%（给画面留更多空间）')
  }
}

console.log('=== 合规约束要写进方案提示词 ===')
const planProbe = spawnSync(process.env.ELECTRON_RUN_AS_NODE ? 'node' : 'node', ['-e', '0'], { encoding: 'utf8' })
// 直接检查源码里 planSystem 是否引用了 COMPLIANCE
const src = fs.readFileSync('D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js', 'utf8')
ok(/planSystem[\s\S]{0,6000}COMPLIANCE\[params\.compliance\]/.test(src),
  'planSystem 里有平台构图约束（生成期预留边距，而不是只在合成期贴遮罩）')
ok(/COMPLIANCE\[params\.compliance\][\s\S]{0,200}prompt/.test(src), '约束取自 COMPLIANCE 表的 prompt 字段')

await fsp.rm(DIR, { recursive: true, force: true })
console.log()
if (fails.length) { console.log('FAILED ' + fails.length); fails.forEach((f) => console.log('  - ' + f)); process.exit(1) }
console.log('全部通过')
process.exit(0)
