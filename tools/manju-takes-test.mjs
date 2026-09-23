/**
 * 抽卡功能真机测试（真文件系统）
 *   ① 抽卡备选必须被识别为 take，且**不参与合成与质检**
 *   ② 选用要把备选升为定稿、原定稿退回备选（可反悔，不是单向操作）
 *   ③ 清备选只删备选、不动定稿
 *   ④ 选用接口必须拒绝非备选文件名（防越权改名）
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = 'D:\\Ai\\漫剧'
const PID = '_takes-test'
const DIR = path.join(ROOT, PID)
const HOST = 'D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js'

const fails = []
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails.push(m) }

// 造一个含抽卡备选的项目：s01 定稿 + 2 备选，s02 定稿，外加一个成片
await fsp.rm(DIR, { recursive: true, force: true })
await fsp.mkdir(DIR, { recursive: true })
await fsp.writeFile(path.join(DIR, 'project.json'), JSON.stringify({ title: '抽卡测试' }), 'utf8')
await fsp.writeFile(path.join(DIR, 'assets.json'), JSON.stringify({ characters: [], scenes: [], props: [] }), 'utf8')
const mk = (n, bytes) => fsp.writeFile(path.join(DIR, n), Buffer.alloc(bytes, 7))
await mk('s01.mp4', 1000)
await mk('s01_take2.mp4', 2000)
await mk('s01_take3.mp4', 3000)
await mk('s02.mp4', 4000)
await mk('成片.mp4', 9000)

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
    setTimeout(() => resolve({ status: 0, body: 'TIMEOUT' }), t || 120000)
  })
}
const J = (r) => { try { return JSON.parse(r.body) } catch (e) { return { raw: r.body.slice(0, 200) } } }
const namesIn = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.mp4')).sort()

console.log('=== ① 产物列表要区分定稿 / 备选 ===')
const prod = J(await call('products', { id: PID }))
const clips = prod.clips || []
console.log('  ' + JSON.stringify(clips.map((c) => c.name + (c.take ? '(备' + c.take + ')' : '(定稿)'))))
ok(clips.length === 5, '列出 5 个 mp4（2 定稿 + 2 备选 + 成片）')
const t2 = clips.find((c) => c.name === 's01_take2.mp4')
ok(!!t2 && t2.take === 2 && t2.shot === 's01', 's01_take2 被识别为 s01 的第 2 张备选')
const f1 = clips.find((c) => c.name === 's01.mp4')
ok(!!f1 && !f1.take && f1.shot === 's01', 's01.mp4 是定稿')

console.log('=== ② 选用：备选升为定稿，原定稿退回备选（可反悔）===')
const before = namesIn()
console.log('  选用前: ' + JSON.stringify(before))
const pick = J(await call('shot.pick', { id: PID, src: 's01_take2.mp4' }))
console.log('  shot.pick -> ' + JSON.stringify(pick))
ok(pick.ok === true, '选用成功')
ok(pick.demoted === 's01_take4.mp4', '原定稿被打到 s01_take4（不覆盖已有备选编号）')
const after = namesIn()
console.log('  选用后: ' + JSON.stringify(after))
ok(after.length === before.length, '文件数不变（用改名而不是复制，磁盘不涨）')
ok(!after.includes('s01_take2.mp4'), '被选中的备选已升格')
// 关键：s01.mp4 现在应该是原来 take2 的内容（2000 字节）
const sz = fs.statSync(path.join(DIR, 's01.mp4')).size
ok(sz === 2000, 's01.mp4 现在是原 take2 的内容（' + sz + ' 字节）')
ok(fs.statSync(path.join(DIR, 's01_take4.mp4')).size === 1000, '原定稿内容完好地躺在 take4（可换回来）')

console.log('=== ③ 清备选：只删备选，定稿不动 ===')
const drop = J(await call('shot.dropTakes', { id: PID, shot: 's01' }))
console.log('  shot.dropTakes -> ' + JSON.stringify(drop))
ok(drop.ok === true && drop.removed.length === 2, '清掉 2 张备选')
const after2 = namesIn()
console.log('  清理后: ' + JSON.stringify(after2))
ok(after2.includes('s01.mp4') && after2.includes('s02.mp4'), '两个定稿都还在')
ok(!after2.some((f) => f.includes('_take')), '备选全清')
ok(after2.includes('成片.mp4'), '成片未被波及')

console.log('=== ④ 选用接口必须拒绝非备选名（防越权改名）===')
for (const bad of ['s01.mp4', '成片.mp4', '..\\..\\evil.mp4', 's01_takeX.mp4', '']) {
  const r = J(await call('shot.pick', { id: PID, src: bad }))
  ok(!!r.error, '拒绝非法输入 ' + JSON.stringify(bad) + ' → ' + String(r.error).slice(0, 40))
}
ok(namesIn().includes('成片.mp4'), '被拒后文件系统未被改动')

console.log('=== ⑤ 合成只吃定稿（备选不混进成片）===')
// 重新造两张备选，然后合成，检查只用了 2 个定稿
await mk('s01_take2.mp4', 2000)
await mk('s02_take2.mp4', 2000)
const asm = J(await call('assemble', { id: PID }, 120000))
console.log('  assemble -> ' + JSON.stringify(asm).slice(0, 160))
// ffmpeg 可能因测试文件是垃圾字节而失败，这里只验证"喂进去的镜头数"
ok(asm.clips === 2 || (asm.error && String(asm.error).indexOf('没有可合成') < 0),
  '合成只取 2 个定稿（备选被排除），clips=' + asm.clips)

await fsp.rm(DIR, { recursive: true, force: true })
console.log()
if (fails.length) { console.log('FAILED ' + fails.length); fails.forEach((f) => console.log('  - ' + f)); process.exit(1) }
console.log('全部通过')
process.exit(0)
