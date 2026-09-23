/**
 * 小说工作区（D:\Ai\小说）与「一键做视频」的契约测试。
 *
 * 为什么值得单独一条套件：
 *   * 小说工作区是**项目根之外**的第二个根（D:\Ai\小说），路径校验、封面路由、
 *     目录扫描都自成一套，出错的形态是"界面能开、但点下去什么都不发生"；
 *   * 「一键做视频」是**写盘 + 建项目 + 登记集 + 开跑**的复合动作，它错一步，
 *     用户损失的是"我以为它做完了"。
 *
 * 夹具自带：临时造一个小说工作区（含立项书 / 分卷正文 / 设定集 / 全本 / 封面与候选封面），
 * 跑完把自己造的东西全部清掉，并且**恢复**原来指向的小说工作区目录 ——
 * 绝不碰用户真实的小说，也不改他的配置。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "DSH Desktop.exe" manju-novel-test.mjs（或 tools\check.cmd）
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const ROOT = 'D:\\Ai\\漫剧'
const HOST = 'D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js'
const CFG = path.join(ROOT, '_studio.json')

const stamp = Date.now().toString(36)
const LIB = path.join(ROOT, '_novel-test-' + stamp)
const WORK = '测试作品甲'
const WD = path.join(LIB, WORK)
const PID = 'zz-novel-' + stamp

let pass = 0
let fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + msg) } else { fail += 1; console.log('  FAIL ' + msg + (extra ? '  ← ' + extra : '')) }
}

// ── 夹具 ──
const chap = (n, tag) => '# 第' + String(n).padStart(3, '0') + '章 ' + tag + '\n\n' + (tag + '。').repeat(1600)
const chapName = (n, tag) => '第' + String(n).padStart(3, '0') + '章_' + tag + '.md'

const CFG_BAK = CFG + '.noveltestbak'

/**
 * 崩溃自愈：先把上一次留下的残局收拾干净。
 *
 * 为什么需要：夹具会把"小说工作区"目录临时改成夹具目录，跑完再还原。但如果上一次跑被
 * **硬杀**（实测：用 `Select-Object -First N` 截断输出会提前断开管道把进程杀掉，
 * finally 根本走不到），用户的 _studio.json 就会永远停在"指向一个已经删掉的临时目录"上 ——
 * 界面表现是"小说管理一打开就说工作区不存在"，而真正的原因在几天前的一次测试里。
 * 所以把原配置另外存一份 sidecar：下一次开跑先把残局还原，再开始干活。
 */
function healFromCrash() {
  try {
    let did = false
    // ① 上一轮被硬杀留下的夹具目录（前缀是本套件独有的，清掉不会误伤真实项目）
    let leftovers = []
    try {
      leftovers = fs.readdirSync(ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^_novel-test-/.test(d.name))
        .map((d) => path.join(ROOT, d.name))
    } catch (e) { /* 根目录读不到就算了 */ }
    for (const p of leftovers) {
      try { fs.rmSync(p, { recursive: true, force: true }); did = true } catch (e) { /* 占用中就留着 */ }
    }
    // ② 被留在"指向已删夹具"的小说工作区配置
    if (fs.existsSync(CFG_BAK)) {
      const prev = fs.readFileSync(CFG_BAK, 'utf8')
      if (prev === '__none__') { try { fs.rmSync(CFG, { force: true }) } catch (e) { /* 忽略 */ } }
      else fs.writeFileSync(CFG, prev, 'utf8')
      fs.rmSync(CFG_BAK, { force: true })
      did = true
    }
    return did
  } catch (e) { return false }
}
const healed = healFromCrash()
if (healed) console.log('  ⚠ 上一次跑被中断：已还原小说工作区配置并清掉夹具残留（自愈）')

let cfgBackup = null
try { cfgBackup = fs.readFileSync(CFG, 'utf8') } catch (e) { cfgBackup = null }
try { fs.writeFileSync(CFG_BAK, cfgBackup === null ? '__none__' : cfgBackup, 'utf8') } catch (e) { /* 忽略 */ }

for (const p of [WD, path.join(WD, '正文', '卷一_试卷'), path.join(WD, '设定集'), path.join(WD, '全本'), path.join(WD, '封面')]) {
  await fsp.mkdir(p, { recursive: true })
}
await fsp.writeFile(path.join(WD, '立项.json'), JSON.stringify({
  书名: WORK,
  立项时间: '2026-09-23',
  题材: '玄幻修仙（T2）',
  高概念: '一句高概念：用来断言立项书被读到。',
  一句话卖点: '一句卖点。',
  主角形态: '器灵·机关木偶',
  美术方向: '3D 动漫脸（非真人），画面干净正常',
}, null, 2), 'utf8')
for (const [n, tag] of [[1, '第一章名'], [2, '第二章名'], [3, '第三章名']]) {
  await fsp.writeFile(path.join(WD, '正文', '卷一_试卷', chapName(n, tag)), chap(n, tag), 'utf8')
}
await fsp.writeFile(path.join(WD, '设定集', '设定集与大纲.md'), '# 设定集\n\n用来断言设定集清单。', 'utf8')
await fsp.writeFile(path.join(WD, '全本', WORK + '·全本.md'), '全本正文'.repeat(100), 'utf8')
// 封面：成品 封面.png 与候选 封面_候选1.png 同时存在 —— 必须选成品那张
const pngA = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)])
const pngB = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)])
await fsp.writeFile(path.join(WD, '封面', '封面.png'), pngA)
await fsp.writeFile(path.join(WD, '封面', '封面_候选1.png'), pngB)

// ── 宿主 harness（真文件系统） ──
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
    setTimeout(() => resolve({ error: 'TIMEOUT' }), 60000)
  })
}
/** 把夹具造出来的东西全部清掉，并还原小说工作区配置。 */
const cleanup = async () => {
  await fsp.rm(LIB, { recursive: true, force: true })
  await fsp.rm(path.join(ROOT, PID), { recursive: true, force: true })
  // 恢复原来的小说工作区配置（原本没有就删掉，别留一个空文件影响真实使用）
  if (cfgBackup === null) { try { await fsp.rm(CFG, { force: true }) } catch (e) { /* 忽略 */ } }
  else { try { await fsp.writeFile(CFG, cfgBackup, 'utf8') } catch (e) { /* 忽略 */ } }
  try { await fsp.rm(CFG_BAK, { force: true }) } catch (e) { /* 忽略 */ }
}
// 退出兜底：连配置一起还原（被硬杀时还有 sidecar 兜第二道）
process.on('exit', () => {
  try {
    fs.rmSync(LIB, { recursive: true, force: true })
    fs.rmSync(path.join(ROOT, PID), { recursive: true, force: true })
    if (cfgBackup === null) fs.rmSync(CFG, { force: true })
    else fs.writeFileSync(CFG, cfgBackup, 'utf8')
    fs.rmSync(CFG_BAK, { force: true })
  } catch (e) { /* 忽略 */ }
})

try {
  console.log('== 1. 媒体路由（小说工作区是第二个根）==')
  ok(routes.filter((r) => r.path === '/manju-novel-file').length === 1, '注册了 /manju-novel-file')

  console.log('== 2. 切小说工作区目录 ==')
  const bad = await call('novel.root', { set: 'not-a-path' })
  ok(!!bad.error, '非绝对路径被拒：' + String(bad.error).slice(0, 40))
  const set = await call('novel.root', { set: LIB })
  ok(set.root === LIB, '切到夹具工作区：' + set.root)
  ok(set.planInputMax > 0, '回报方案阶段正文字数上限 ' + set.planInputMax)
  const persisted = JSON.parse(await fsp.readFile(CFG, 'utf8'))
  ok(persisted.novelRoot === LIB, '目录选择落盘（重启后仍在）')

  console.log('== 2b. 封面路由：真起 server 走一遍媒体语义 ==')
  // 为什么要真起 server：这条路由曾经因为漏写一个 await（novelRootPath 是异步的）
  // 把路径拼成 "[object Promise]\<作品>"，症状是封面一律 404、而其它功能全都正常 ——
  // 只断言"路由注册了"完全抓不到它。
  {
    const route = routes.filter((r) => r.path === '/manju-novel-file')[0]
    const srv = http.createServer((req, res) => {
      Promise.resolve(route.handler(req, res)).catch(() => { try { res.writeHead(500); res.end() } catch (e) { /* 已响应 */ } })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const base = 'http://127.0.0.1:' + srv.address().port
    const u = (work, rel) => base + '/manju-novel-file?w=' + encodeURIComponent(work) + '&r=' + encodeURIComponent(rel)
    const c1 = await fetch(u(WORK, '封面/封面.png'))
    const buf = Buffer.from(await c1.arrayBuffer())
    ok(c1.status === 200 && c1.headers.get('content-type') === 'image/png',
      '封面 200 + image/png（实际 ' + c1.status + ' / ' + c1.headers.get('content-type') + '）')
    ok(buf.length === pngA.length, '正文长度与文件一致（' + buf.length + '）')
    ok(buf[100] === 1, '取到的是**成品**封面，不是候选（内容字节可辨）')
    ok(c1.headers.get('cache-control') === 'private, no-cache', 'Cache-Control = private, no-cache（封面不闪）')
    ok(!!c1.headers.get('etag'), '带强 ETag')
    const c2 = await fetch(u(WORK, '封面/封面.png'), { headers: { 'If-None-Match': c1.headers.get('etag') } })
    ok(c2.status === 304, '条件请求回 304')
    const c3 = await fetch(u(WORK, '封面/封面.png'), { headers: { Range: 'bytes=0-9' } })
    ok(c3.status === 206 && (await c3.arrayBuffer()).byteLength === 10, 'Range 回 206 / 10 字节')
    const esc = await fetch(u(WORK, '../../../Windows/win.ini'))
    ok(esc.status === 400 || esc.status === 403, '路径穿越被拒（' + esc.status + '）')
    const esc2 = await fetch(base + '/manju-novel-file?w=' + encodeURIComponent('..\\..') + '&r=win.ini')
    ok(esc2.status === 400, '非法作品名被拒（' + esc2.status + '）')
    srv.close()
  }

  console.log('== 3. 作品扫描 ==')
  const w = await call('novel.works', {})
  ok(w.count === 1 && (w.works || []).length === 1, '扫到 1 部作品（' + w.count + '）')
  const one = (w.works || [])[0] || {}
  ok(one.work === WORK, '作品名 = 目录名（中文）：' + one.work)
  ok(one.title === WORK, '书名读自立项.json')
  ok(one.chapterCount === 3, '章数 3（实际 ' + one.chapterCount + '）')
  ok(one.volCount === 1, '卷数 1')
  ok(!!one.full && one.full.rel.indexOf('全本/') === 0, '认到全本：' + (one.full && one.full.rel))
  ok((one.settings || []).length === 1, '认到设定集 1 份')
  ok(one.cover === '封面/封面.png', '封面取**成品**那张，不取候选：' + one.cover)
  ok(one.genre.indexOf('玄幻') >= 0 && one.hook.indexOf('高概念') >= 0, '立项书要点（题材/高概念）已带出')

  console.log('== 4. 作品详情与正文读取 ==')
  const d = await call('novel.work', { work: WORK })
  ok((d.volList || []).length === 1 && (d.volList[0].chapters || []).length === 3, '逐章清单 3 章')
  ok(d.volList[0].chapters[0].title === '第001章 第一章名', '章标题取自文件名：' + d.volList[0].chapters[0].title)
  const r1 = await call('novel.read', { work: WORK, rel: d.volList[0].chapters[0].rel })
  ok(r1.chars > 1000 && r1.text.indexOf('第一章名') >= 0, '读到正文（' + r1.chars + ' 字）')
  const rBig = await call('novel.read', { work: WORK, rel: d.volList[0].chapters[0].rel, maxChars: 50 })
  ok(rBig.truncated === true && rBig.text.length === 50, '有界读取（截断标记 + 只回 50 字）')
  const rEsc = await call('novel.read', { work: WORK, rel: '../../_studio.json' })
  ok(!!rEsc.error, '目录穿越被拒：' + String(rEsc.error).slice(0, 40))
  const rBin = await call('novel.read', { work: WORK, rel: '封面/封面.png' })
  ok(!!rBin.error, '不把二进制当文本读：' + String(rBin.error).slice(0, 40))
  const rNo = await call('novel.work', { work: '不存在的作品' })
  ok(!!rNo.error, '不存在的作品被拒')

  console.log('== 5. 一键做视频：建项目 + 本集素材 + 溯源 ==')
  const v = await call('novel.toVideo', {
    work: WORK, id: PID, episode: 'ep01',
    scope: { kind: 'chapter', count: 3 },
    autoStart: false,   // 绝不在这条套件里真的开跑渲染
  })
  ok(v.ok === true && v.id === PID, '建项目成功：' + v.id)
  ok(v.isNew === true, '是新建（不是复用已有项目）')
  ok(v.truncated === true && v.chars <= v.maxChars, '正文按方案上限截断并**如实回报**：' + v.chars + '/' + v.totalChars + '（上限 ' + v.maxChars + '）')
  ok((v.chapters || []).length === 3, '记录了三章的来源清单')
  const pj = JSON.parse(await fsp.readFile(path.join(ROOT, PID, 'project.json'), 'utf8'))
  ok(pj.title === WORK && pj.series === WORK, '项目标题与系列都取自作品（series 供跨集同一张脸）')
  ok(pj.style.indexOf('STYLIZED 3D ANIMATION') > 0 && pj.style.indexOf('STYLE (mandatory') === 0,
    '默认风格句是 3D 动漫且前置（用户指定的美术方向）')
  ok(pj.episodes && pj.episodes.ep01 === '第001章 第一章名', '集名登记为范围标签：' + (pj.episodes || {}).ep01)
  ok(!!pj.origin && pj.origin.work === WORK, '项目记下了来路（origin.work）')
  const own = await fsp.readFile(path.join(ROOT, PID, 'novel-ep01.md'), 'utf8')
  ok(own.length > 1000, '本集素材落盘 novel-ep01.md（' + own.length + ' 字）')
  const same = await fsp.readFile(path.join(ROOT, PID, 'novel.md'), 'utf8')
  ok(same === own, '新项目的 novel.md 与第一集素材一致')
  const src = JSON.parse(await fsp.readFile(path.join(ROOT, PID, 'novel-source-ep01.json'), 'utf8'))
  ok(src.work === WORK && (src.chapters || []).length === 3, '溯源文件记下作品与章清单')
  ok(src.truncated === true && src.sourceChapters === 3, '溯源文件记下"原作共几章 / 截断了吗"')
  ok(fs.existsSync(path.join(ROOT, PID, 'assets.json')) && fs.existsSync(path.join(ROOT, PID, 'shots.json')), '项目骨架齐全（assets.json / shots.json）')

  console.log('== 6. 一键做第二集：落进同一个项目，集号自动往后排 ==')
  const v2 = await call('novel.toVideo', {
    work: WORK, episode: '',             // 不给集号 → 应自动排 ep02
    scope: { kind: 'chapter', chapter: '第003章', count: 1 },
    autoStart: false,
  })
  ok(v2.id === PID, '复用同一个项目（一部小说 = 一个项目）：' + v2.id)
  ok(v2.isNew === false, '不是新建')
  ok(v2.episode === 'ep02', '集号自动排到 ep02（实际 ' + v2.episode + '）')
  const pj2 = JSON.parse(await fsp.readFile(path.join(ROOT, PID, 'project.json'), 'utf8'))
  ok(!!pj2.episodes.ep01 && !!pj2.episodes.ep02, '两集都在 project.json 里：' + JSON.stringify(pj2.episodes))
  const own2 = await fsp.readFile(path.join(ROOT, PID, 'novel-ep02.md'), 'utf8')
  ok(own2.indexOf('第三章名') >= 0, '第二集素材单独一份（novel-ep02.md）')
  const novelMd = await fsp.readFile(path.join(ROOT, PID, 'novel.md'), 'utf8')
  ok(novelMd.indexOf('第一章名') >= 0 && novelMd.indexOf('第三章名') < 0,
    'novel.md 没被第二集覆盖（重跑旧集的依据还在）')

  console.log('== 7. 拒绝不合理的请求 ==')
  const vBad = await call('novel.toVideo', { work: WORK, id: PID, episode: 'ep 01!', scope: { kind: 'chapter' }, autoStart: false })
  ok(!!vBad.error, '非法集号被拒：' + String(vBad.error).slice(0, 40))
  const vNo = await call('novel.toVideo', { work: '没有这本书', scope: { kind: 'full' }, autoStart: false })
  ok(!!vNo.error, '不存在的作品被拒')
  const vScope = await call('novel.toVideo', { work: WORK, id: PID, scope: { kind: 'volume', vol: '卷九十九' }, autoStart: false })
  ok(!!vScope.error, '不存在的卷被拒：' + String(vScope.error).slice(0, 40))
} finally {
  await cleanup()
}

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail)
process.exit(fail ? 1 : 0)
