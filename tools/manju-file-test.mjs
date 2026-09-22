/**
 * manju-studio /manju-file 路由的契约测试（临时脚本，跑完即可删）
 *
 * 为什么要真起一个 http server 而不是造假的 req/res：
 * 这次改动动了 304 / 206 / pipe 三件容易"看着对、其实错"的事 ——
 * 假对象会把它们全都掩盖掉。用真服务器 + 真 fetch，才验得到浏览器会看到的行为。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "DSH Desktop.exe" <本文件>
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const ROUTES = []
const PLUGIN = 'D:\\Ai\\DSH-plugins\\dsh-manju-studio\\lib\\index.js'

const fakeFs = {
  async resolve(p) { return p },
  async stat(p) {
    try {
      const s = await fsp.stat(p)
      return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs }
    } catch (e) { return null }
  },
  async listDir(p) {
    try {
      const es = await fsp.readdir(p, { withFileTypes: true })
      return es.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: 0 }))
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
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch (e) { return () => {} } },
  on: () => () => {},
  get: (k) => (k === 'logger' ? { info() {}, warn() {}, error() {} } : undefined),
}

const mod = await import('file:///' + PLUGIN.replace(/\\/g, '/'))
const apply = mod.apply || (mod.default && mod.default.apply)
if (typeof apply !== 'function') { console.log('FAIL 拿不到 apply 导出'); process.exit(1) }
await apply(ctx)

const route = ROUTES.find((r) => r.path === '/manju-file')
if (!route) { console.log('FAIL 没注册 /manju-file 路由'); process.exit(1) }

const srv = http.createServer((req, res) => {
  Promise.resolve(route.handler(req, res)).catch((e) => { try { res.writeHead(500); res.end(String(e)) } catch (e2) {} })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + srv.address().port

const PJ = 'jixin-wendao'
const IMG = 'assets/img/scenes_gen_云海天穹_832028.png'
const absImg = 'D:\\Ai\\漫剧\\' + PJ + '\\' + IMG.replace(/\//g, '\\')
const size = (await fsp.stat(absImg)).size

let pass = 0
let fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + msg) } else { fail += 1; console.log('  FAIL ' + msg + (extra ? '  ← ' + extra : '')) }
}
const u = (rel) => base + '/manju-file?p=' + PJ + '&r=' + encodeURIComponent(rel)

console.log('== 1. 基本响应与缓存头 ==')
{
  const r = await fetch(u(IMG))
  const buf = Buffer.from(await r.arrayBuffer())
  const etag = r.headers.get('etag')
  console.log('  ETag=' + etag + '  CC=' + r.headers.get('cache-control') + '  AR=' + r.headers.get('accept-ranges'))
  ok(r.status === 200, '200 OK')
  ok(buf.length === size, '正文长度与文件一致（' + buf.length + ' vs ' + size + '）')
  ok(!!etag && etag.length > 4, '带强 ETag')
  ok(r.headers.get('cache-control') === 'private, no-cache', 'Cache-Control = private, no-cache（不是 no-store —— 那是封面闪烁的根因）')
  ok(r.headers.get('accept-ranges') === 'bytes', 'Accept-Ranges: bytes')
  ok(!!r.headers.get('last-modified'), '带 Last-Modified')

  console.log('== 2. 条件请求必须 304 ==')
  const r2 = await fetch(u(IMG), { headers: { 'If-None-Match': etag } })
  const body2 = await r2.arrayBuffer()
  ok(r2.status === 304, '同 ETag 回 304（浏览器复用已解码的图，不再闪）')
  ok(body2.byteLength === 0, '304 不带正文')

  const r3 = await fetch(u(IMG), { headers: { 'If-Modified-Since': r.headers.get('last-modified') } })
  ok(r3.status === 304, 'If-Modified-Since 也回 304')
}

console.log('== 3. Range 支持（视频拖进度）==')
{
  const r = await fetch(u(IMG), { headers: { Range: 'bytes=0-99' } })
  const buf = Buffer.from(await r.arrayBuffer())
  ok(r.status === 206, '206 Partial Content', 'got ' + r.status)
  ok(r.headers.get('content-range') === 'bytes 0-99/' + size, 'Content-Range 正确：' + r.headers.get('content-range'))
  ok(buf.length === 100, '只回 100 字节')
  const r2 = await fetch(u(IMG), { headers: { Range: 'bytes=' + (size - 10) + '-' } })
  const b2 = await r2.arrayBuffer()
  ok(r2.status === 206 && b2.byteLength === 10, '尾部开区间能取')
  const r3 = await fetch(u(IMG), { headers: { Range: 'bytes=999999999-' } })
  ok(r3.status === 416, '越界范围回 416', 'got ' + r3.status)
}

console.log('== 4. mp4 也能走 Range ==')
{
  const mp4 = 's01.mp4'
  const ms = (await fsp.stat('D:\\Ai\\漫剧\\' + PJ + '\\' + mp4)).size
  const r = await fetch(u(mp4), { headers: { Range: 'bytes=0-1023' } })
  ok(r.status === 206 && (await r.arrayBuffer()).byteLength === 1024, 'mp4 206 + 1024 字节（总 ' + ms + '）')
}

console.log('== 5. HEAD 与安全边界 ==')
{
  const r = await fetch(u(IMG), { method: 'HEAD' })
  ok(r.status === 200 && r.headers.get('content-length') === String(size), 'HEAD 回 200 + Content-Length，无正文')
  const bad = await fetch(base + '/manju-file?p=' + PJ + '&r=' + encodeURIComponent('../../../Windows/win.ini'))
  ok(bad.status === 400 || bad.status === 403, '路径穿越被拒（' + bad.status + '）')
  const miss = await fetch(u('assets/img/不存在.png'))
  ok(miss.status === 404, '不存在的文件 404')
}

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail)
srv.close()
process.exit(fail ? 1 : 0)
