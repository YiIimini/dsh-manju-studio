/**
 * 小说库 + 一条龙预检的真实文件系统测试。
 * 用一个临时目录造出小说结构，验证 dir.list / novel.scan / content.check。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = 'D:\\Ai\\漫剧'
const PID = '_lib-test'
const DIR = path.join(ROOT, PID)
const LIB = path.join(ROOT, '_lib-test-novels')
const HOST = 'D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js'

const fails = []
const ok = (c, m) => { if (!c) fails.push(m); console.log((c ? '  PASS ' : '  FAIL ') + m) }

// 造小说目录：3 本在根，2 本在子目录，1 个非文本干扰项
for (const p of [LIB, path.join(LIB, '系列甲'), DIR]) await fsp.mkdir(p, { recursive: true })
await fsp.writeFile(path.join(LIB, '落花灵根.txt'), '字'.repeat(3000), 'utf8')
await fsp.writeFile(path.join(LIB, '凡铁.md'), '# 凡铁\n' + '字'.repeat(1500), 'utf8')
await fsp.writeFile(path.join(LIB, '封面.png'), 'notatext', 'utf8')
await fsp.writeFile(path.join(LIB, '系列甲', '第一卷.txt'), '字'.repeat(900), 'utf8')
await fsp.writeFile(path.join(LIB, '系列甲', '第二卷.txt'), '字'.repeat(600), 'utf8')
await fsp.writeFile(path.join(DIR, 'project.json'), JSON.stringify({ title: '库测试' }), 'utf8')
await fsp.writeFile(path.join(DIR, 'assets.json'), JSON.stringify({ characters: [], scenes: [], props: [] }), 'utf8')

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
  return { done, collected: { stdout: mk(() => o), stderr: mk(() => e) }, terminate: () => { try { child.kill() } catch (x) {} } }
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
host.apply({
  effect: (f) => { f(); return () => {} }, get: () => undefined,
  fs: fsShim, subprocess: { spawn: realSpawn },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
})
const api = routes.filter((r) => r.path === '/api/manju-studio')[0]
function call(cmd, args) {
  return new Promise((resolve) => {
    const hs = {}
    const req = { method: 'POST', url: '/api/manju-studio',
      on: (ev, cb) => { hs[ev] = cb; if (ev === 'end') setTimeout(() => { hs.data && hs.data(Buffer.from(JSON.stringify({ cmd, args }))); hs.end() }, 0) } }
    const res = { writeHead: (s) => { res._s = s }, end: (b) => resolve({ status: res._s, body: String(b) }) }
    api.handler(req, res)
    setTimeout(() => resolve({ status: 0, body: 'TIMEOUT' }), 120000)
  })
}
const J = (r) => { try { return JSON.parse(r.body) } catch (e) { return {} } }

console.log('=== 1. 驱动器列表（路径为空时）===')
const d0 = J(await call('dir.list', { path: '' }))
console.log('  drives=' + JSON.stringify((d0.drives || []).slice(0, 4)) + '…  共 ' + (d0.drives || []).length)
ok((d0.drives || []).length >= 1, '列出了驱动器')
ok(d0.atRoot === true, '空路径视为根')

console.log('=== 2. 目录浏览 ===')
const d1 = J(await call('dir.list', { path: LIB }))
console.log('  path=' + d1.path + '  dirs=' + JSON.stringify(d1.dirs) + '  parent=' + d1.parent)
ok(d1.path === LIB, '回显路径')
ok((d1.dirs || []).indexOf('系列甲') >= 0, '列出子目录')
ok((d1.files || []).some((f) => f.name === '落花灵根.txt'), '顺带列出该目录下的文本')
ok((d1.files || []).every((f) => !/\.png$/i.test(f.name)), '不把 .png 当小说')
const dUp = J(await call('dir.list', { path: d1.parent }))
ok(dUp.path === ROOT, '上一级到 ' + dUp.path)

console.log('=== 3. 扫描小说目录（递归两层）===')
const sc = J(await call('novel.scan', { dir: LIB }))
console.log('  count=' + sc.count + '  ' + JSON.stringify((sc.files || []).map((f) => f.name)))
ok(sc.count === 4, '扫到 4 个文本（3 根 + 2 子目录 - 1 个 .png 干扰）')
ok((sc.files || []).some((f) => f.name === '第一卷.txt'), '递归进了子目录')
ok((sc.files || []).every((f) => f.chars > 0), '每本都带字数估算')

console.log('=== 4. 内容预检：空项目应拦住一条龙 ===')
const c0 = J(await call('content.check', { id: PID }))
console.log('  ok=' + c0.ok + '  problems=' + JSON.stringify(c0.problems))
ok(c0.ok === false, '空项目预检不通过')
const ps = J(await call('pipelineStart', { id: PID, mode: 'ai' }))
ok(!!ps.error && ps.error.indexOf('内容还没准备好') >= 0, '一条龙被拦下并说清原因：' + String(ps.error).slice(0, 60))

console.log('=== 5. 导入正文后预检通过 ===')
const imp = J(await call('novel.import', { id: PID, srcPath: path.join(LIB, '落花灵根.txt') }))
ok(imp.ok === true && imp.chars === 3000, '导入正文成功（3000 字）')
const c1 = J(await call('content.check', { id: PID }))
console.log('  ok=' + c1.ok + '  novelChars=' + c1.novelChars)
ok(c1.ok === true, '预检通过')
ok(c1.novelChars === 3000, '识别到 3000 字')

console.log('=== 6. 有脚本也算有内容 ===')
const D2 = path.join(ROOT, '_lib-test2')
await fsp.mkdir(path.join(D2, 'script'), { recursive: true })
await fsp.writeFile(path.join(D2, 'project.json'), '{}', 'utf8')
await fsp.writeFile(path.join(D2, 'assets.json'), '{"characters":[],"scenes":[],"props":[]}', 'utf8')
await fsp.writeFile(path.join(D2, 'script', 'ep01.md'), '# 分镜剧本\n正文', 'utf8')
const c2 = J(await call('content.check', { id: '_lib-test2' }))
console.log('  ok=' + c2.ok + '  scripts=' + JSON.stringify(c2.scripts))
ok(c2.ok === true && (c2.scripts || []).length === 1, '只有脚本时也判定为有内容')

// 清理
await fsp.rm(LIB, { recursive: true, force: true })
await fsp.rm(DIR, { recursive: true, force: true })
await fsp.rm(D2, { recursive: true, force: true })

console.log()
if (fails.length) { console.log('FAILED ' + fails.length); fails.forEach((f) => console.log('  - ' + f)); process.exit(1) }
console.log('全部通过')
// 空闲退出注册的 interval 会吊住事件循环，测试必须显式退出
process.exit(fails && fails.length ? 1 : 0)
