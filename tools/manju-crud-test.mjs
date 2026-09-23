/**
 * 项目增删与日志命令的契约测试（临时目录自己造、自己清）
 *
 * 为什么必须测这两条删除路径：
 *   * `remove` 是**软删除**（移进 _trash 可恢复）——它一旦退化成真删，用户丢数据；
 *   * `purge` 是**真删**（不可恢复）——它一旦越界（删到根目录外、或删了正在跑的项目），
 *     代价同样是不可逆的。两种错误方向相反，都得钉住。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const PLUGIN = 'D:\\Ai\\DSH-plugins\\dsh-manju-studio\\lib\\index.js'
const ROOT = 'D:\\Ai\\漫剧'

const ROUTES = []
const fakeFs = {
  async resolve(p) { return p },
  async stat(p) {
    try { const s = await fsp.stat(p); return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs } }
    catch (e) { return null }
  },
  async listDir(p) {
    try {
      const es = await fsp.readdir(p, { withFileTypes: true })
      const out = []
      for (const e of es) {
        let size = 0
        try { size = (await fsp.stat(path.join(p, e.name))).size } catch (x) { /* 忽略 */ }
        out.push({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: size })
      }
      return out
    } catch (e) { return [] }
  },
  async readText(p) { try { return await fsp.readFile(p, 'utf8') } catch (e) { return '' } },
  async writeText(p, t) { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, String(t), 'utf8') },
  async readBytes(p) { return await fsp.readFile(p) },
}
const ctx = {
  fs: fakeFs,
  subprocess: { spawn: () => { throw new Error('测试不启动子进程') }, resolveExecutable: async () => '' },
  webServer: { register: (r) => { ROUTES.push(r); return () => {} } },
  effect: (fn) => { try { fn() } catch (e) { /* 忽略 */ } return () => {} },
  on: () => () => {},
  get: (k) => (k === 'logger' ? { info() {}, warn() {}, error() {} } : undefined),
}
const mod = await import('file:///' + PLUGIN.replace(/\\/g, '/'))
await mod.apply(ctx)
const api = ROUTES.filter((r) => r.path === '/api/manju-studio')[0]
if (!api) { console.log('  FAIL 没注册 /api/manju-studio 路由'); process.exit(1) }

function call(cmd, args) {
  return new Promise((resolve) => {
    const hs = {}
    const req = {
      method: 'POST', url: '/api/manju-studio',
      on: (ev, cb) => { hs[ev] = cb; if (ev === 'end') setTimeout(() => { hs.data && hs.data(Buffer.from(JSON.stringify({ cmd, args }))); hs.end() }, 0) },
    }
    const res = { writeHead: () => {}, end: (b) => { try { resolve(JSON.parse(String(b))) } catch (e) { resolve({ error: 'BADJSON ' + String(b).slice(0, 120) }) } } }
    api.handler(req, res)
    setTimeout(() => resolve({ error: 'TIMEOUT' }), 30000)
  })
}

let pass = 0
let fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + msg) } else { fail += 1; console.log('  FAIL ' + msg + (extra ? '  ← ' + extra : '')) }
}
const stamp = Date.now().toString(36)
const mkProj = async (id) => {
  const dir = path.join(ROOT, id)
  await fsp.mkdir(path.join(dir, 'chapters'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify({ title: id }), 'utf8')
  await fsp.writeFile(path.join(dir, 'chapters', 'c1.md'), 'hello world', 'utf8')
  await fsp.writeFile(path.join(dir, 's01.mp4'), Buffer.alloc(2048, 7))
  return dir
}

const purgeId = 'zz-purgetest-' + stamp
const softId = 'zz-softtest-' + stamp

console.log('== 1. purge：真删 + 报告清理量 ==')
{
  const dir = await mkProj(purgeId)
  const r = await call('purge', { id: purgeId })
  ok(r && r.ok === true, 'purge 返回 ok', JSON.stringify(r))
  ok(!fs.existsSync(dir), '目录真的被删掉了（不可恢复）')
  ok(r && r.files === 3, '报告文件数正确（3 个文件）', 'got ' + (r && r.files))
  ok(r && r.bytes >= 2048, '报告释放字节数（含 2KB 的 mp4）', 'got ' + (r && r.bytes))
}

console.log('== 2. purge 的安全边界 ==')
{
  const a = await call('purge', { id: '../evil' })
  ok(a && !!a.error, '非法 id 被拒：' + (a && a.error))
  const b = await call('purge', { id: 'zz-not-exist-' + stamp })
  ok(b && !!b.error, '不存在的项目被拒：' + (b && b.error))
  const c = await call('purge', { id: '' })
  ok(c && !!c.error, '空 id 被拒：' + (c && c.error))
  const d = await call('purge', { id: 'D:/Ai/漫剧/zz-path-probe' })
  ok(d && !!d.error, '带路径分隔符的 id 被拒（只接受纯项目名）：' + (d && d.error))
  // 注意：**绝不**在这里对真实项目调用 purge 做"是否拒绝"的探测 ——
  // 万一它没拒绝，删掉的就是真作品。安全边界只用不可能存在的输入来验证。
}

console.log('== 3. remove：软删除必须可恢复 ==')
{
  const dir = await mkProj(softId)
  const r = await call('remove', { id: softId })
  ok(r && r.ok === true, 'remove 返回 ok')
  ok(!fs.existsSync(dir), '原目录已移走')
  const moved = r && r.movedTo
  ok(!!moved && fs.existsSync(moved), '内容在 _trash 里还在（可恢复）', 'movedTo=' + moved)
  ok(!!moved && fs.existsSync(path.join(moved, 'project.json')), '项目文件完整搬过去了')
  const back = await call('boot', {})
  ok(back && back.projects && !back.projects.some((p) => p.id === softId), '已不在项目列表里')
  // 清理：把测试产生的回收站目录删掉，别留垃圾
  if (moved) { try { await fsp.rm(path.dirname(moved), { recursive: true, force: true }) } catch (e) { /* 忽略 */ } }
}

console.log('== 4. 日志命令 ==')
{
  // 夹具自建：原先固定读 jixin-wendao 的日志，那个项目一被删这条断言就恒红
  // （"没有日志可读"）—— 但 logs.* 的契约本来就是"读本项目 output/logs 下的 .log"，
  // 自己造一个项目 + 一份日志就能验，不必依赖任何真实作品是否还在、是否渲过。
  const logId = 'zz-logtest-' + stamp
  const dir = await mkProj(logId)
  await fsp.mkdir(path.join(dir, 'output', 'logs'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'output', 'logs', 'render-test.log'), 'line1\nline2\n', 'utf8')
  const ls = await call('logs.list', { id: logId })
  ok(ls && Array.isArray(ls.logs), 'logs.list 返回数组')
  if (ls && ls.logs && ls.logs.length) {
    ok(ls.logs.length >= 1, '至少有一份日志（' + ls.logs.length + ' 份）')
    ok(ls.logs[0].name === 'render-test.log', '按名字列出日志：' + ls.logs[0].name)
    const r1 = await call('logs.read', { id: logId, name: 'output/logs/' + ls.logs[0].name })
    ok(r1 && typeof r1.text === 'string' && r1.text.length > 0, 'logs.read 能读到正文')
    const bad = await call('logs.read', { id: logId, name: 'project.json' })
    ok(bad && !!bad.error, '越界读被拒（只允许 output/logs 下）：' + (bad && bad.error))
  } else {
    ok(false, '没有读到日志（夹具已写入 output/logs/render-test.log，说明 logs.list 漏了它）')
  }
  await fsp.rm(dir, { recursive: true, force: true })
}

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail)
process.exit(fail ? 1 : 0)
