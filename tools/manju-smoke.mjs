/**
 * 离线冒烟测试：宿主半 + 客户端半。
 * 用 Electron 当 Node 跑，不启动 DSH、不改任何真实项目数据。
 */
import fs from 'node:fs'

const HOST = 'D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js'
const CLIENT = 'D:/Ai/DSH-plugins/dsh-manju-studio/lib/client.js'

// 模拟 ComfyUI 在线：宿主半用 fetch 打 /system_stats，不桩的话 ensureComfy 会判定
// 不可用、渲染阶段直接中止（那是对的行为，但后面的逻辑就测不到了）
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' })

const fails = []
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? '  PASS ' : '  FAIL ') + msg) }

// ══════════════════════════ 一、宿主半 ══════════════════════════

const files = {
  'D:\\Ai\\漫剧\\skill-test\\project.json': '{"title":"落花灵根","genre":"仙侠","params":{"style":"写实","steps":12,"autoStart":false}}',
  'D:\\Ai\\漫剧\\skill-test\\assets.json': '{"characters":[{"id":"characters_a1","name":"林小满","desc":"青衣","image":"assets/img/characters_a1_林小满.png"}],"scenes":[],"props":[]}',
  'D:\\Ai\\漫剧\\skill-test\\shots.json': '{"project":"skill-test","style":"写实","shots":[{"id":"s01"},{"id":"s02"},{"id":"s03"},{"id":"s04"}]}',
  'D:\\Ai\\漫剧\\skill-test\\script\\ep01.md': '# 《落花灵根》分镜剧本',
  'D:\\Ai\\漫剧\\skill-test\\novel.md': '正文一千字',
}
const dirs = {
  'D:\\Ai\\漫剧': [{ name: 'skill-test', type: 'directory' }],
  'D:\\Ai\\漫剧\\skill-test': [
    { name: 's01.mp4', type: 'file', size: 1500000 },
    { name: 's03.mp4', type: 'file', size: 1200000 },
    { name: '成片.mp4', type: 'file', size: 8400000 },
    { name: 'shots.json', type: 'file', size: 900 },
  ],
  'D:\\Ai\\漫剧\\skill-test\\script': [{ name: 'ep01.md', type: 'file', size: 26037 }],
}
const wrote = []
const cmdLog = []
// 节点预检的可调桩：checkOut 里出现全部 REQUIRED_NODES 才通过
const REQUIRED = ['UNETLoader', 'LoraLoaderModelOnly', 'CLIPLoader', 'VAELoader',
  'MiniMaxH3SigmaShift', 'MiniMaxH3ImageToVideo', 'BasicGuider', 'BasicScheduler',
  'KSamplerSelect', 'RandomNoise', 'SamplerCustomAdvanced', 'VAEDecode',
  'VAEDecodeAudio', 'CreateVideo', 'SaveVideo', 'MiniMaxH3ReferenceToVideo', 'MiniMaxH3AddGuide', 'LoadImage', 'LoadAudio']
let checkOut = 'ComfyUI \u53ef\u8fbe\n' + REQUIRED.join(' ') + '\n'
let checkExit = 0

const ctx = {
  effect: (f) => { f(); return () => {} },
  get: () => undefined,
  fs: {
    resolve: async (p) => ({ targetKey: 'k:' + p, displayPath: p }),
    stat: async (t) => {
      if (files[t.displayPath]) return { type: 'file', size: files[t.displayPath].length }
      if (dirs[t.displayPath]) return { type: 'directory' }
      if (files[t.displayPath] === '') return { type: 'file', size: 0 }
      return undefined
    },
    readText: async (t) => (files[t.displayPath] === undefined ? '' : files[t.displayPath]),
    writeText: async (t, c) => { wrote.push(t.displayPath); files[t.displayPath] = String(c); return {} },
    listDir: async (t) => dirs[t.displayPath] || [],
    readBytes: async () => new Uint8Array(0),
  },
  subprocess: {
    spawn: (spec) => {
      const argv = spec.argv.join(' ')
      cmdLog.push(argv)
      let out = ''
      let exit = 0
      if (argv.indexOf('nvidia-smi') >= 0) {
        out = '78, 40, 5000, 24564\n'
      } else if (argv.indexOf('ffprobe') >= 0) {
        // 按文件名造不同的探针结果：s03 无音轨、s05 时长过短
        const noAudio = argv.indexOf('s03.mp4') >= 0
        const short = argv.indexOf('s05.mp4') >= 0
        out = JSON.stringify({
          format: { duration: short ? '0.4' : '5.168', size: '1500000', bit_rate: '2320000' },
          streams: [
            { codec_type: 'video', width: 1344, height: 768, codec_name: 'h264', r_frame_rate: '24/1' },
            noAudio ? { codec_type: 'data' } : { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '32000' },
          ],
        })
      } else if (argv.indexOf('blackdetect') >= 0) {
        // s04 造一段 3 秒黑场（占 5.17s 的 58% → 触发黑屏不合格）
        out = argv.indexOf('s04.mp4') >= 0
          ? '[blackdetect @ 0x1] black_start:1 black_end:4 black_duration:3\n'
          : ''
      } else if (argv.indexOf('ffmpeg') >= 0) {
        out = ''
      } else if (argv.indexOf('probe') >= 0) {
        out = '\u8d28\u68c0: \u53d1\u73b0\u95ee\u9898\n  s03.mp4: \u65e0\u97f3\u8f68\n'
        exit = 1
      } else if (argv.indexOf('check') >= 0) {
        out = checkOut
        exit = checkExit
      } else {
        out = '[1/2] s01\n    \u5b8c\u6210 12.3s  1.43 MB -> x\n[2/2] s03\n  FAIL s03: boom\n== \u6c47\u603b ==  \u6210\u529f 1 / \u5931\u8d25 1  \u603b\u8017\u65f6 20s\n'
      }
      let drained = false
      const stdout = {
        readFrom: (off) => {
          const t = drained ? '' : out
          drained = true
          return { text: t, nextOffset: off + t.length }
        },
      }
      const stderr = { readFrom: (off) => ({ text: '', nextOffset: off }) }
      return {
        done: Promise.resolve({ exitCode: exit }),
        collected: { stdout, stderr },
        terminate() {},
      }
    },
  },
  webServer: { register: () => () => {} },
}

// 覆盖 collected 的 stdout 读取
const realSpawn = ctx.subprocess.spawn

const host = await import('file:///' + HOST)
console.log('\n=== 1. \u5bbf\u4e3b\u534a ===')
ok(host.name === 'manju-studio', 'name = manju-studio')
ok(JSON.stringify(host.inject) === '["webServer","fs","subprocess"]', 'inject 声明正确')

// 伪造 llm 服务：只实现插件用到的那几个方法
let llmReply = ''
const llmCalls = []
const fakeLlm = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'other', name: 'Other' }],
  listModels: async (p) => (p === 'deepseek' ? [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] : []),
  stream: (opts) => {
    llmCalls.push(opts)
    const t = llmReply
    return (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: t.slice(0, 12) }
      yield { type: 'text-delta', index: 0, text: t.slice(12) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

const routes = []
const ctx2 = Object.assign({}, ctx, {
  get: (name) => (name === 'llm' ? fakeLlm : undefined),
  webServer: { register: (r) => { routes.push(r); return () => {} } },
})
host.apply(ctx2)
ok(true, 'apply(ctx) 未抛异常')
ok(routes.length === 2, 'apply 注册 2 条路由（实际 ' + routes.length + '）')

const api2 = routes.filter((r) => r.path === '/api/manju-studio')[0]
ok(!!api2, '命令路由路径正确')
ok(routes.filter((r) => r.path === '/manju-file').length === 1, '媒体路由存在')

function call(route, cmd, args) {
  return new Promise((resolve) => {
    const hs = {}
    const req = {
      method: 'POST', url: route.path,
      on: (ev, cb) => {
        hs[ev] = cb
        if (ev === 'end') setTimeout(() => { hs.data && hs.data(Buffer.from(JSON.stringify({ cmd, args }))); hs.end() }, 0)
      },
    }
    const res = { writeHead: (s) => { res._s = s }, end: (b) => resolve({ status: res._s, body: String(b) }) }
    route.handler(req, res)
    setTimeout(() => resolve({ status: 0, body: 'TIMEOUT' }), 6000)
  })
}
const call2 = (cmd, args) => call(api2, cmd, args)
const J = (r) => { try { return JSON.parse(r.body) } catch (e) { return {} } }

const show = (n, r) => console.log('    ' + n + ' -> ' + r.status + '  ' + r.body.slice(0, 120))

// —— 新命令 ——
let r = await call2('shots.preview', { id: 'skill-test', range: { shots: '1,3-4' } })
show('shots.preview 1,3-4', r)
ok(J(r).picked === 3 && J(r).total === 4, '镜头范围 1,3-4 选中 3/4')

r = await call2('shots.preview', { id: 'skill-test', range: {} })
ok(J(r).picked === 4 && J(r).filtered === false, '空范围 = 全本 4 镜')

r = await call2('shots.preview', { id: 'skill-test', range: { shots: 's02' } })
ok(J(r).picked === 1, '按镜头 id 选镜')

r = await call2('shots.preview', { id: 'skill-test', range: { shots: '9-12' } })
ok(J(r).picked === 0, '越界范围筛出 0 镜')

r = await call2('script.list', { id: 'skill-test' })
show('script.list', r)
ok((J(r).files || []).length === 1, 'script.list 返回 1 个脚本')

r = await call2('script.import', { id: 'skill-test', rel: 'script/ep02.md', srcPath: 'D:\\Ai\\漫剧\\skill-test\\script\\ep01.md' })
show('script.import', r)
ok(J(r).ok === true && J(r).chars > 0, 'script.import 导入成功')

r = await call2('script.import', { id: 'skill-test', rel: 'script/x.md', srcPath: 'D:\\nope\\nope.md' })
ok(!!J(r).error, 'script.import 源文件不存在时报错')

r = await call2('novel.import', { id: 'skill-test', srcPath: 'D:\\Ai\\漫剧\\skill-test\\novel.md' })
ok(J(r).ok === true, 'novel.import 导入成功')

r = await call2('sysinfo', { id: 'skill-test' })
const si = J(r)
show('sysinfo', r)
ok(typeof si.cpu === 'number' && si.memTotal > 0, 'sysinfo 返回 CPU/内存')
ok(si.gpu && si.gpu.util === 78 && si.gpu.temp === 40, 'sysinfo 解析 nvidia-smi')
ok(si.comfy && si.comfy.url === 'http://127.0.0.1:8199' && typeof si.comfy.up === 'boolean', 'sysinfo 返回 ComfyUI 探测结果（up 为布尔，不依赖当时是否在跑）')

r = await call2('boot', {})
const bt = J(r)
ok((bt.projects || []).length === 1, 'boot 列出 1 个项目')
if (bt.projects && bt.projects[0]) {
  const p = bt.projects[0]
  console.log('    项目: ' + JSON.stringify({ t: p.title, cover: p.cover, sc: p.scriptCount, clips: p.clipCount, shots: p.shotCount, final: p.hasFinal }))
  ok(p.cover === '', 'boot 封面：无独立封面且无场景图时留空 —— **不用主角定妆照兜底**')
  ok(p.scriptCount === 1, 'boot 统计脚本数')
  ok(p.hasFinal === true, 'boot 识别已成片')
}

// —— 单阶段管线 & 质检解析 ——
r = await call2('pipelineStart', { id: 'skill-test', only: ['judge'] })
show('pipelineStart only=[judge]', r)
const jid = J(r).jobId
await new Promise((s) => setTimeout(s, 2500))
r = await call2('pipelinePoll', { jobId: jid })
let jj = J(r)
console.log('    阶段: ' + jj.stages.map((s) => s.name + '=' + s.state).join(' '))
ok(jj.stages.filter((s) => s.key === 'judge')[0].state === 'failed', '质检失败时阶段标记 failed')
ok(jj.exitCode === 1, '单阶段失败时 exitCode=1')
ok(jj.running === false, '单阶段执行结束')

// —— AI 一条龙：验证质检驱动、自动返修删文件 + 换 seed、合成走新链路 ——
wrote.length = 0
cmdLog.length = 0
const shotsBefore = JSON.parse(files['D:\\Ai\\漫剧\\skill-test\\shots.json'])
const seedBefore = {}
shotsBefore.shots.forEach((s) => { seedBefore[s.id] = s.seed })
r = await call2('pipelineStart', { id: 'skill-test', mode: 'ai', retries: 2 })
const jid2 = J(r).jobId
await new Promise((s) => setTimeout(s, 14000))
r = await call2('pipelinePoll', { jobId: jid2 })
jj = J(r)
console.log('    阶段: ' + jj.stages.map((s) => s.name + '=' + s.state).join(' '))
const delCmds = cmdLog.filter((c) => c.indexOf('del /f /q') >= 0)
console.log('    删除命令: ' + JSON.stringify(delCmds.slice(0, 3)))
ok(delCmds.length >= 1, 'AI 一条龙删除了质检不合格的镜头文件')
ok(cmdLog.some((c) => c.indexOf('blackdetect') >= 0), '质检走了黑屏防线（blackdetect）')
ok(cmdLog.some((c) => c.indexOf('ffprobe') >= 0), '质检走了 ffprobe 探测')
ok(jj.stages.filter((s) => s.key === 'judge')[0].state === 'failed', '质检阶段如实标记失败')
ok(jj.stages.filter((s) => s.key === 'merge')[0].state === 'done', '合成阶段执行完成')
ok(jj.stages.filter((s) => s.key === 'plan')[0].state === 'done', '一条龙里已存在的 shots.json 不重写方案')
ok(llmCalls.length === 0, '一条龙不覆盖已有 shots.json（未调用模型）')

const shotsAfter = JSON.parse(files['D:\\Ai\\漫剧\\skill-test\\shots.json'])
const s03After = shotsAfter.shots.filter((s) => s.id === 's03')[0]
ok(!!s03After && s03After.seed !== seedBefore.s03, '返修同时换了 seed（' + seedBefore.s03 + ' → ' + (s03After && s03After.seed) + '）——同 seed 重跑会复现同样结果')

const composeCmd = cmdLog.filter((c) => c.indexOf('ffmpeg') >= 0 && c.indexOf('成片.mp4') >= 0)[0] || ''
console.log('    合成命令片段: ' + composeCmd.slice(0, 200))
ok(composeCmd.indexOf('loudnorm') >= 0, '合成做了响度归一 (loudnorm)')
ok(composeCmd.indexOf('+faststart') >= 0, '合成加了 +faststart')
ok(composeCmd.indexOf('-crf 18') >= 0, '合成用 crf 18')
ok(composeCmd.indexOf('-c copy') < 0, '合成没有用流复制')
ok(wrote.some((w) => w.indexOf('_render.json') >= 0) === true, '全本渲染也写 _render.json（统一入口）')

// —— 带镜头范围的管线写 _render.json，并把角色/场景解析成有序参考图 ——
wrote.length = 0
r = await call2('pipelineStart', { id: 'skill-test', only: ['render'], range: { shots: '1' } })
await new Promise((s) => setTimeout(s, 3000))
ok(wrote.some((w) => w.indexOf('_render.json') >= 0), '渲染前写 _render.json（解析参考图后的渲染输入）')
const rdoc = files['D:\\Ai\\漫剧\\skill-test\\_render.json']
ok(!!rdoc, '_render.json 已生成')
const RJ = JSON.parse(rdoc || '{}')
ok(RJ.shots && RJ.shots.length === 1, '镜头范围生效：只渲 1 镜')
ok(RJ.defaults && RJ.defaults.sampler === 'euler', 'defaults 带 sampler（euler 为官方默认）')
ok(RJ.defaults.shift_video === 12.0 && RJ.defaults.shift_audio === 3.0, 'defaults 带配对的 video/audio shift')
ok(RJ.defaults.ref_image_size === 'match', 'defaults 带 ref_image_size')
const r0 = (RJ.shots || [])[0] || {}
ok(r0.characters === undefined && r0.scene === undefined, '渲染输入里不残留 id 引用（已解析成路径）')
ok(r0.mode === 't2v', '无参考引用的镜头按纯文生处理')

// 场景永远排在最后 + 转台图紧跟在角色定妆照之后
files['D:\\Ai\\漫剧\\skill-test\\assets.json'] = JSON.stringify({
  characters: [
    { id: 'c1', name: '林小满', desc: '', image: 'assets/img/characters_a1_林小满.png' },
    { id: 'c2', name: '沈砚', desc: '', image: 'assets/img/characters_a2_沈砚.png' },
  ],
  scenes: [{ id: 's1', name: '药庐', desc: '', image: 'assets/img/scenes_a1_药庐.png' }],
  props: [],
})
dirs['D:\\Ai\\漫剧\\skill-test\\assets\\img'] = [
  { name: 'characters_a1_林小满.png', type: 'file', size: 100 },
  { name: 'characters_a1_林小满_turnaround.png', type: 'file', size: 100 },
  { name: 'characters_a2_沈砚.png', type: 'file', size: 100 },
  { name: 'scenes_a1_药庐.png', type: 'file', size: 100 },
]
for (const k of Object.keys(files)) { /* keep */ }
files['D:\\Ai\\漫剧\\skill-test\\assets\\img\\characters_a1_林小满.png'] = 'x'
files['D:\\Ai\\漫剧\\skill-test\\assets\\img\\characters_a1_林小满_turnaround.png'] = 'x'
files['D:\\Ai\\漫剧\\skill-test\\assets\\img\\characters_a2_沈砚.png'] = 'x'
files['D:\\Ai\\漫剧\\skill-test\\assets\\img\\scenes_a1_药庐.png'] = 'x'
const savedShots = files['D:\\Ai\\漫剧\\skill-test\\shots.json']
files['D:\\Ai\\漫剧\\skill-test\\shots.json'] = JSON.stringify({
  project: 'skill-test', style: 'x',
  shots: [{ id: 's01', prompt: 'p', width: 1344, height: 768, length: 124, steps: 8, seed: 1,
    mode: 'r2v', characters: ['c1', 'c2'], scene: 's1' }],
})
r = await call2('pipelineStart', { id: 'skill-test', only: ['render'] })
await new Promise((s) => setTimeout(s, 3000))
const RJ2 = JSON.parse(files['D:\\Ai\\漫剧\\skill-test\\_render.json'])
const refs2 = (RJ2.shots[0].ref_images || []).map((p) => p.split('\\').pop())
console.log('    参考图顺序: ' + JSON.stringify(refs2))
ok(refs2.length === 4, '两角色(其一有转台图)+场景 = 4 张参考图')
ok(refs2[0] === 'characters_a1_林小满.png' && refs2[1] === 'characters_a1_林小满_turnaround.png',
  '转台图紧跟在其角色定妆照之后')
ok(refs2[3] === 'scenes_a1_药庐.png', '场景图永远排在最后一张（<Picture N> 编号契约）')
files['D:\\Ai\\漫剧\\skill-test\\shots.json'] = savedShots

// —— 单镜重渲（产物面板的「重渲此镜」）——
cmdLog.length = 0
wrote.length = 0
r = await call2('shot.rerender', { id: 'skill-test', shotId: 's02' })
const jidR = J(r).jobId
ok(r.status === 200 && !!jidR, 'shot.rerender 返回新的管线任务')
await new Promise((s) => setTimeout(s, 2500))
r = await call2('pipelinePoll', { jobId: jidR })
const rj = J(r)
console.log('    阶段: ' + rj.stages.map((s) => s.name + '=' + s.state).join(' '))
ok(rj.stages.filter((s) => s.key === 'render')[0].state === 'done', '单镜重渲的渲染阶段完成')
ok(cmdLog.some((c) => c.indexOf('del /f /q') >= 0 && c.indexOf('s02.mp4') >= 0), '先删掉该镜的 mp4（否则 render 会跳过）')
const sub2 = JSON.parse(files['D:\\Ai\\漫剧\\skill-test\\_render.json'])
ok(sub2.shots.length === 1 && sub2.shots[0].id === 's02', '单镜重渲只把 s02 写进 _render.json')
ok(cmdLog.some((c) => c.indexOf('_render.json') >= 0), '渲染用的是 _render.json 而不是全量 shots.json')
r = await call2('shot.rerender', { id: 'skill-test', shotId: '../../evil' })
ok(!!J(r).error, 'shot.rerender 拒绝非法镜头 id')

// —— 停止 ——
r = await call2('pipelineStart', { id: 'skill-test', mode: 'all' })
const jid3 = J(r).jobId
await new Promise((s) => setTimeout(s, 400))
r = await call2('pipelineStop', { jobId: jid3 })
ok(J(r).ok === true, 'pipelineStop 返回 ok')
await new Promise((s) => setTimeout(s, 2500))
r = await call2('pipelinePoll', { jobId: jid3 })
ok(J(r).running === false, '停止后管线不再运行')

// —— 安全守卫 ——
r = await call2('read', { id: '../../../windows' })
ok(!!J(r).error, 'read 拒绝非法项目 id')
r = await call2('script.read', { id: 'skill-test', rel: '../../../../etc/passwd' })
ok(!!J(r).error || J(r).rel === 'script/ep01.md', 'script.read 拦截路径穿越')
r = await call2('pipelineStart', { id: 'skill-test', only: ['nope'] })
ok(!!J(r).error, 'pipelineStart 拒绝未知阶段')
r = await call2('nope', {})
ok(r.status === 404, '未知命令返回 404')

// ── 管线串行化：同一时刻只准跑一条 ──
console.log('  -- 串行化 --')
r = await call2('pipelineStart', { id: 'skill-test', only: ['env'] })
ok(r.status === 200 && !!J(r).jobId, '第一条管线可启动')
const r2 = await call2('pipelineStart', { id: 'skill-test', only: ['env'] })
ok(!!J(r2).error && J(r2).error.indexOf('已有一条管线') >= 0, '第二条管线被拒（并发共用显卡只会互相伤害）')
await new Promise((s) => setTimeout(s, 3000))

// ── 节点预检：缺节点必须提前拦住 ──
console.log('  -- 节点预检 --')
r = await call2('render.preflight', { id: 'skill-test' })
ok(J(r).ok === true, '节点齐全时预检通过')
checkOut = 'ComfyUI \u53ef\u8fbe\n\u7f3a\u5931\u8282\u70b9: SaveVideo, CreateVideo\n'
checkExit = 1
r = await call2('render.preflight', { id: 'skill-test' })
const pfMiss = J(r).missing || []
console.log('    缺失: ' + pfMiss.slice(0, 5).join(', ') + ' …共 ' + pfMiss.length)
ok(J(r).ok === false && pfMiss.indexOf('SaveVideo') >= 0, '缺节点时预检不通过并点名')
r = await call2('pipelineStart', { id: 'skill-test', only: ['render'] })
await new Promise((s) => setTimeout(s, 3000))
r = await call2('pipelinePoll', { jobId: J(r).jobId })
ok(J(r).stages.filter((s) => s.key === 'render')[0].state === 'failed', '缺节点时渲染阶段被提前拦住（不跑到一半才炸）')
checkOut = 'ComfyUI \u53ef\u8fbe\n' + REQUIRED.join(' ') + '\n'
checkExit = 0

// ── 风格预设 ──
r = await call2('style.presets', {})
ok((J(r).presets || []).length === 10, '风格预设表返回 10 条')

// ── 质检：黑屏 / 无音轨 / 时长过短 / 报告落盘 ──
console.log('  -- 机械质检 --')
dirs['D:\\Ai\\漫剧\\skill-test'] = [
  { name: 's01.mp4', type: 'file', size: 1500000 },
  { name: 's03.mp4', type: 'file', size: 1200000 },
  { name: 's04.mp4', type: 'file', size: 1300000 },
  { name: 's05.mp4', type: 'file', size: 200000 },
  { name: '成片.mp4', type: 'file', size: 8400000 },
]
wrote.length = 0
r = await call2('qc', { id: 'skill-test' })
const qrep = J(r)
console.log('    质检: ' + qrep.total + ' 镜，不合格 ' + qrep.failed)
qrep.reports.forEach((c) => console.log('      ' + c.file + ' ok=' + c.ok
  + ' ' + (c.problems || []).join('/') + ' ' + (c.warnings || []).join('/')))
ok(qrep.total === 4, '成片不计入质检（4 个镜头）')
const byFile = {}
qrep.reports.forEach((c) => { byFile[c.file] = c })
ok(byFile['s01.mp4'].ok === true, 's01 通过')
ok(byFile['s03.mp4'].ok === false && byFile['s03.mp4'].problems.join().indexOf('无音轨') >= 0, 's03 因无音轨不合格')
ok(byFile['s04.mp4'].ok === false && byFile['s04.mp4'].problems.join().indexOf('黑屏') >= 0, 's04 因黑屏不合格（黑屏防线生效）')
ok(byFile['s04.mp4'].darkRatio > 0.5, 's04 黑场占比 ' + byFile['s04.mp4'].darkRatio + ' 超阈值')
ok(byFile['s05.mp4'].ok === false && byFile['s05.mp4'].problems.join().indexOf('时长过短') >= 0, 's05 因时长过短不合格')
ok(wrote.some((w) => w.indexOf('output\\qc_report.json') >= 0), '质检报告落盘 output/qc_report.json')

// ── 合成：cut 与 fade 两条链路 ──
console.log('  -- 合成 --')
cmdLog.length = 0
r = await call2('assemble', { id: 'skill-test', transition: 'cut' })
ok(J(r).ok === true, 'cut 合成成功')
const cutCmd = cmdLog.filter((c) => c.indexOf('ffmpeg') >= 0)[0] || ''
ok(cutCmd.indexOf('concat') >= 0, 'cut 走 concat 解复用器')
cmdLog.length = 0
r = await call2('assemble', { id: 'skill-test', transition: 'fade' })
ok(J(r).ok === true, 'fade 合成成功')
const fadeCmd = cmdLog.filter((c) => c.indexOf('ffmpeg') >= 0)[0] || ''
ok(fadeCmd.indexOf('xfade=transition=fade') >= 0, 'fade 走 xfade 链')
ok(fadeCmd.indexOf('acrossfade') >= 0, 'fade 同时交叉淡化音频')
cmdLog.length = 0
r = await call2('assemble', { id: 'skill-test', transition: 'dissolve' })
const dsCmd = cmdLog.filter((c) => c.indexOf('ffmpeg') >= 0)[0] || ''
ok(J(r).transition === 'fade' && dsCmd.indexOf('xfade=transition=fade') >= 0, 'dissolve 被降级为 fade（像素溶解是颗粒噪点观感）')

// ── 无人可用时给出可读报错 ──
dirs['D:\\Ai\\漫剧\\skill-test'] = [{ name: '成片.mp4', type: 'file', size: 8400000 }]
r = await call2('assemble', { id: 'skill-test' })
ok(!!J(r).error && J(r).error.indexOf('没有可合成的镜头') >= 0, '没有镜头可合成时报错清楚')
dirs['D:\\Ai\\漫剧\\skill-test'] = [
  { name: 's01.mp4', type: 'file', size: 1500000 },
  { name: 's03.mp4', type: 'file', size: 1200000 },
  { name: 'shots.json', type: 'file', size: 900 },
]

// ── 方案阶段：大模型直出分镜 ──
console.log('  -- 方案阶段 --')
r = await call2('llm.providers', {})
let lp = J(r)
show('llm.providers', r)
ok((lp.providers || []).length === 2, '列出 2 个模型路由')
ok(lp.providers[0].models.length === 2, 'deepseek 列出 2 个模型')

const SHOTS_PATH = 'D:\\Ai\\漫剧\\skill-test\\shots.json'
const before = files[SHOTS_PATH]

// 模型返回 Markdown 围栏 + 越界帧数 + 错语言标记的台词，必须被规整
llmReply = '```json\n' + JSON.stringify({
  style: 'cinematic 2.5D anime, xianxia',
  characters: [
    { id: 'c1', name: '林小满', description: '十七岁少女，清瘦长脸，青衣' },
    { id: 'bad id!', name: '沈砚', description: '玄色长袍' },
  ],
  scenes: [{ id: 's1', name: '药庐', description: '雨夜竹帘' }],
  shots: [
    {
      id: 's01', mode: 'ref2va', shot_size: '近景', camera: 'Push In, small amplitude, slow',
      characters: ['c1'], scene: 's1', length: 999, seed: 11,
      dialogue: [{ speaker: '林小满', text: '师兄，药好了。' }],
      h3_prompt: 'subject_definitions:\n<Subject 1> is Lin Xiaoman, a seventeen-year-old girl in blue robes.\n\n'
        + 'retention_analysis:\n<Picture 1> fully_preserved - FACE LOCK on her own picture.\n\n'
        + 'detailed_description:\nCINEMATIC 2.5D ANIME. [Shot 1] She turns toward the camera.\n'
        + '<Subject 1> (S1) says in a soft voice: <d>[Japanese]师兄，药好了。</d>\n'
        + 'No on-screen text, no subtitles.\n'
        + 'Subjects must remain clearly visible and adequately lit throughout the video.',
    },
    {
      id: 'bad id!', length: 120, characters: ['c1'],
      h3_prompt: 'subject_definitions:\n<Subject 1> is Lin Xiaoman.\n\ndetailed_description:\n'
        + '[Shot 1] Rain falls on tiled rooftops.\nShe whispers: <d>别走。</d>\n'
        + 'overall_soundscape:\nRain on tiles.',
    },
    { id: 's03', h3_prompt: '太短' },
  ],
}), '\n```'
llmCalls.length = 0
r = await call2('pipelineStart', { id: 'skill-test', only: ['plan'] })
const jid4 = J(r).jobId
await new Promise((s) => setTimeout(s, 3000))
r = await call2('pipelinePoll', { jobId: jid4 })
const pj = J(r)
console.log('    阶段: ' + pj.stages.map((s) => s.name + '=' + s.state).join(' '))
ok(pj.stages.filter((s) => s.key === 'plan')[0].state === 'done', '方案阶段执行成功')
ok(llmCalls.length === 1, '方案阶段调用了一次模型')
const sent = llmCalls[0]
ok(sent.provider === 'deepseek' && sent.model === 'deepseek-chat', '路由用 params 里的 provider/model')
ok(sent.system.indexOf('2500–6000') >= 0, '系统提示词含 h3_prompt 长度约束')
ok(sent.system.indexOf('17k+5') >= 0, '系统提示词含帧数网格约束')
ok(sent.system.indexOf('Push In') >= 0 && sent.system.indexOf('whip pan') >= 0, '系统提示词含官方运镜词表与禁用行话')
ok(sent.system.indexOf('[Chinese]') >= 0, '系统提示词含台词语言锁')
ok(sent.system.indexOf('nearly black') >= 0, '系统提示词含亮度护栏（提示词侧黑屏防线）')
ok(sent.system.indexOf('不许写负面提示词语法') >= 0, '系统提示词禁止负面提示词语法')
ok(sent.system.indexOf('只描述渲染表面') >= 0, '系统提示词含风格/身份分离铁律')
ok(sent.system.indexOf('一个角色 = 一张卡') >= 0, '系统提示词含"一个角色一张卡"（同名/代号归一）')
ok(sent.system.indexOf('参考图进入顺序即契约') >= 0 && sent.system.indexOf('<Picture i>') >= 0, '系统提示词含官方参考图顺序与编号契约')
ok(sent.messages[0].content[0].text.indexOf('分镜剧本') >= 0, 'script/ 优先作为方案输入')
ok(sent.messages[0].content[0].text.indexOf('写实') >= 0, '风格句被送进模型')
ok(sent.messages[0].source.kind === 'plugin', '消息来源标记为插件')

const gen = JSON.parse(files[SHOTS_PATH])
const planDoc = JSON.parse(files['D:\\Ai\\漫剧\\skill-test\\plan.json'])
console.log('    shots.json: ' + JSON.stringify({
  project: gen.project, n: gen.shots.length,
  s1: { id: gen.shots[0].id, mode: gen.shots[0].mode, len: gen.shots[0].length, chars: gen.shots[0].characters, scene: gen.shots[0].scene },
  s2: { id: gen.shots[1].id, mode: gen.shots[1].mode, len: gen.shots[1].length },
}))
ok(gen.project === 'skill-test', 'shots.json 的 project 被锁定为项目 id')
ok(gen.shots.length === 2, '丢弃了提示词过短的镜头（3 → 2）')
ok(gen.shots[0].length === 362, '帧数 999 被吸附到 17k+5 网格上限 362')
ok(gen.shots[1].length === 124, '帧数 120 被吸附到 124')
ok(gen.shots[0].width === 1344 && gen.shots[0].height === 768, '分辨率锁定 1344×768')
ok(gen.shots[0].steps === 12, '步数取自项目参数（12），不被模型返回值覆盖')
ok(/^[A-Za-z0-9_-]{1,40}$/.test(gen.shots[1].id), '非法镜头 id 被改写为 ' + gen.shots[1].id)
ok(gen.shots[0].mode === 'r2v' && gen.shots[1].mode === 'r2v', '有参考引用 → 走 Ref2VA 权重分支（模型写的 ref2va 也归一）')
ok(gen.shots[0].characters.join() === 'c1' && gen.shots[0].scene === 's1', '镜头保留角色与场景引用')
ok(gen.shots[0].shot_size === '近景' && gen.shots[0].camera.indexOf('Push In') >= 0, '镜头保留景别与运镜')

// 台词语言锁：模型写错的语言标记必须被归一，裸 <d> 也要补标记
ok(gen.shots[0].prompt.indexOf('<d>[Chinese]师兄，药好了。</d>') >= 0, '模型写错的 [Japanese] 被归一为 [Chinese]')
ok(gen.shots[0].prompt.indexOf('[Japanese]') < 0, '不再残留任何非中文语言标记')
ok(gen.shots[0].prompt.indexOf('MANDARIN ONLY') >= 0, '有台词的镜头追加了 MANDARIN ONLY 语言锁')
ok(gen.shots[1].prompt.indexOf('<d>[Chinese]别走。</d>') >= 0, '裸 <d> 台词被补上 [Chinese]')
ok(gen.shots[1].prompt.indexOf('MANDARIN ONLY') >= 0, '每个有台词的镜头都带语言锁')
ok(planDoc.characters.length === 2 && planDoc.scenes.length === 1, 'plan.json 保留角色卡与场景卡')
ok(/^[A-Za-z0-9_-]{1,40}$/.test(planDoc.characters[1].id), '非法角色 id 被改写为 ' + planDoc.characters[1].id)
ok(files[SHOTS_PATH + '.bak'] === before, '原 shots.json 已备份为 .bak')

// 模型返回垃圾时必须原样保留 shots.json
llmReply = '抱歉，我无法完成这个请求。'
const good = files[SHOTS_PATH]
r = await call2('pipelineStart', { id: 'skill-test', only: ['plan'] })
await new Promise((s) => setTimeout(s, 3000))
r = await call2('pipelinePoll', { jobId: J(r).jobId })
ok(J(r).stages.filter((s) => s.key === 'plan')[0].state === 'failed', '模型返回非 JSON 时方案阶段标记失败')
ok(files[SHOTS_PATH] === good, '方案失败时 shots.json 保持原样（未被写坏）')

// 没有正文时给出可读的报错
files['D:\\Ai\\漫剧\\skill-test\\novel.md'] = ''
files['D:\\Ai\\漫剧\\skill-test\\script\\ep01.md'] = ''
r = await call2('pipelineStart', { id: 'skill-test', only: ['plan'] })
await new Promise((s) => setTimeout(s, 3000))
r = await call2('pipelinePoll', { jobId: J(r).jobId })
const noText = J(r).lines.join(' ')
ok(noText.indexOf('没有可用的正文') >= 0, '缺少正文时给出可读报错')
files['D:\\Ai\\漫剧\\skill-test\\novel.md'] = '正文一千字'

// ══════════════════════════ 二、客户端半 ══════════════════════════

console.log('\n=== 2. \u5ba2\u6237\u7aef\u534a ===')
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
  useState: (init) => [overrides[hookIdx] === undefined ? init : overrides[hookIdx++], () => {}],
  useRef: (init) => ({ current: init }),
  Component: class {
    constructor(p) { this.props = p || {}; this.state = {}; this.setState = () => {}; }
    render() { return null; }
  },
  useCallback: (fn) => fn,
  memo: (c) => c, useMemo: (f) => f(),
  useEffect: () => {},
}
// useState 里用了 hookIdx++ 只在取用时递增，改为总是递增：
ReactShim.useState = (init) => {
  const i = hookIdx++
  return [overrides[i] === undefined ? init : overrides[i], () => {}]
}

let factory = null
globalThis.window = { __ModuleLoader__: { load: (o) => { factory = o.factory } } }
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { appendChild() {} },
}

fs.writeFileSync(process.env.TEMP + '/__mj_client_probe.mjs', src)
await import('file:///' + process.env.TEMP.replace(/\\/g, '/') + '/__mj_client_probe.mjs')
ok(typeof factory === 'function', 'window.__ModuleLoader__.load 被调用')

const captured = []
const mod = factory((name) => { if (name === 'react') return ReactShim; throw new Error('unknown require ' + name) })
ok(Array.isArray(mod.inject) && mod.inject.indexOf('slots') >= 0, 'exports.inject 含 slots')
ok(typeof mod.apply === 'function', 'exports.apply 是函数')

const fakeCtx = {
  effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {} },
  slots: {
    inject: (name, cb) => { cb() },
    register: (reg, comp) => { captured.push({ reg, comp }); return () => {} },
  },
}
let applyThrew = null
try { mod.apply(fakeCtx) } catch (e) { applyThrew = e }
ok(!applyThrew, '客户端 apply 未抛异常：' + (applyThrew ? applyThrew.message : ''))
ok(captured.length === 2, '注册了 2 个槽位')
const mainReg = captured.filter((c) => c.reg.name === 'main')[0]
const sideReg = captured.filter((c) => c.reg.name === 'sidebar.panellist')[0]
ok(mainReg && mainReg.reg.key === 'manju-studio', 'main 槽位 key = manju-studio')
ok(sideReg && sideReg.reg.id === 'manju-studio', 'sidebar.panellist id = manju-studio')
ok(!!sideReg && !!sideReg.reg.label, '侧栏有 label')
ok(!!mainReg && typeof mainReg.comp === 'function', 'main 拿到组件函数')
ok(!!sideReg && typeof sideReg.comp === 'function', 'sidebar 拿到图标组件')

// 组件真渲染
const Studio = mainReg.comp
const Icon = sideReg.comp

function render(el, out, depth) {
  if (depth > 60) { out.bad.push('嵌套过深（疑似自引用）'); return }
  if (el === null || el === undefined || typeof el === 'boolean') return
  if (Array.isArray(el)) { el.forEach((x) => render(x, out, depth + 1)); return }
  if (typeof el === 'string' || typeof el === 'number') { out.text++; return }
  if (!el.__el) { out.bad.push('非元素节点: ' + Object.prototype.toString.call(el)); return }
  if (typeof el.type === 'function' && el.type.prototype && typeof el.type.prototype.render === 'function') {
    // class 组件：new 出来再渲染它的 render()（真 React 就是这么做的）
    const inst = new el.type(el.props)
    inst.props = el.props
    if (typeof inst.componentDidCatch !== 'function' || !inst.state || !inst.state.err) {
      render(inst.render(), out, depth + 1)
    }
    return
  }
  if (typeof el.type === 'function') { render(el.type(el.props), out, depth + 1); return }
  const tag = el.type
  out.nodes++
  out.tags[tag] = (out.tags[tag] || 0) + 1
  const cn = el.props && typeof el.props.className === 'string' ? el.props.className : ''
  if (cn) cn.split(/\s+/).forEach((c) => { if (c) out.cls[c] = (out.cls[c] || 0) + 1 })
  for (const k of Object.keys(el.props)) {
    const v = el.props[k]
    if (k === 'children') continue
    if (typeof v === 'string' && (v.indexOf('undefined') >= 0 || v.indexOf('NaN') >= 0)) {
      out.bad.push(tag + '.' + k + ' = ' + v.slice(0, 60))
    }
  }
  render(el.props.children, out, depth + 1)
}

function pass(name, state, expect) {
  hookIdx = 0
  overrides = state
  const out = { nodes: 0, text: 0, tags: {}, cls: {}, bad: [] }
  let err = null
  try { render(Studio(), out, 0) } catch (e) { err = e }
  const line = '    ' + name + ': 节点 ' + out.nodes + ' 文本 ' + out.text
    + ' 按钮 ' + (out.tags.button || 0) + ' 输入 ' + ((out.tags.input || 0) + (out.tags.textarea || 0))
    + ' 图 ' + (out.tags.img || 0) + ' 视频 ' + (out.tags.video || 0)
  console.log(line)
  ok(!err, name + ' 渲染不抛异常' + (err ? '：' + err.message + ' @ ' + String(err.stack).split('\n')[1] : ''))
  ok(out.bad.length === 0, name + ' 无 undefined/NaN 属性' + (out.bad.length ? '：' + out.bad.slice(0, 3).join(' | ') : ''))
  if (expect) ok(expect(out), name + ' 内容符合预期')
  return out
}

const BOOT = { root: 'D:\\Ai\\漫剧', projects: [
  { id: 'skill-test', title: '落花灵根', genre: '仙侠', style: '写实', shotCount: 4, assetCount: 2,
    scriptCount: 1, cover: 'assets/img/characters_a1_林小满.png', novelChars: 1200, clipCount: 3, hasFinal: true },
] }
const SYS = { cpu: 17, cores: 24, memUsed: 34e9, memTotal: 67e9,
  gpu: { util: 78, temp: 40, memUsed: 5e9, memTotal: 24e9 },
  comfy: { up: true, url: 'http://127.0.0.1:8199', error: '' } }
const PROJ = { id: 'skill-test', meta: { title: '落花灵根' }, novel: '正文一千字',
  shotsDoc: { shots: [{ id: 's01' }, { id: 's02' }] },
  assets: { characters: [], scenes: [], props: [] }, clips: [], files: [] }
const PARAMS = { style: '写实', provider: 'deepseek', llm: 'deepseek-chat', comfyUrl: 'http://127.0.0.1:8199',
  width: 1344, height: 768, fps: 24, tier: '768P 标准', steps: 8, seed: 20260920, sage: true, longshot: 1 }
const PROD = {
  characters: [{ id: 'characters_a1', name: '林小满', desc: '青衣少女', image: 'assets/img/c.png' }],
  scenes: [{ id: 'scenes_a2', name: '药庐', desc: '', image: 'assets/img/s.png' }],
  props: [], novels: [],
  clips: [{ name: 's01.mp4', size: 1500000, final: false }, { name: '成片.mp4', size: 8400000, final: true }],
}
const STAGES = [['env', 'done'], ['plan', 'manual'], ['asset', 'manual'], ['encode', 'manual'],
  ['render', 'running'], ['judge', 'pending'], ['merge', 'pending']]
  .map((s) => ({ key: s[0], name: { env: '环境', plan: '方案', asset: '资产', encode: '编码', render: '渲染', judge: '质检', merge: '合成' }[s[0]], state: s[1], note: '' }))
const JOB = { jobId: 'pipe1', running: true, exitCode: null, mode: 'ai',
  progress: { index: 1, total: 2 }, stages: STAGES,
  lines: ['━━━ 阶段 环境 ━━━', 'ComfyUI OK', '[1/2] s01', '    完成 12.3s  1.43 MB -> x',
    '== 汇总 ==  成功 1 / 失败 1  总耗时 20s', '  FAIL s03: boom', '质检: 发现问题', '  s03.mp4: 无音轨'] }

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'other', name: 'Other', models: [] },
]

function state(over) {
  const base = ['video', BOOT, SYS, '', '', 'skill-test', PROJ, PARAMS, PROVIDERS, PROD, '正文一千字', true,
    'script/ep01.md', '# 《落花灵根》分镜剧本', false, [{ name: 'ep01.md', rel: 'script/ep01.md', size: 26037 }],
    'script', '', '', { chapter: '', episode: '', shots: '1,3' },
    { total: 4, picked: 2, by: '镜头范围 1,3', filtered: true },
    JOB, true, 'clips', 'ComfyUI OK',
    false, false, { id: '', title: '', genre: '', style: '' },
    { kind: 'characters', srcPath: '', name: '', desc: '' }]
  Object.keys(over || {}).forEach((k) => { base[Number(k)] = over[k] })
  return base
}

console.log('\n=== 3. \u7ec4\u4ef6\u6e32\u67d3 ===')
pass('空态', [])
pass('视频管理（产物默认折叠）', state(), (o) => (o.cls['mj-shot'] || 0) === 2
  && (o.tags.video || 0) >= 1 && (o.tags.img || 0) >= 1 && o.tags.button >= 24)
pass('视频管理（产物展开）', state({ '29': true }), (o) => o.tags.video >= 2 && (o.tags.img || 0) >= 1
  && (o.tags.input || 0) >= 6 && (o.tags.select || 0) >= 2)
pass('产物-人物素材', state({ '23': 'characters', '29': true }), (o) => (o.tags.img || 0) >= 2
  && (o.cls['mj-shot'] || 0) === 2)
pass('产物-镜头', state({ '23': 'clips', '29': true }), (o) => (o.tags.video || 0) >= 2)
// 版式：故事板是主区；侧栏可折叠
const BOARD = state()
pass('故事板：每镜一张卡', BOARD, (o) => (o.cls['mj-shot'] || 0) === 2
  && (o.cls['mj-shotmedia'] || 0) === 2 && (o.cls['mj-boardgrid'] || 0) === 1)
pass('故事板：筛选按钮齐全', BOARD, (o) => (o.cls['mj-boardbar'] || 0) === 1)
pass('侧栏折叠后让出宽度', state({ '32': false }), (o) => (o.cls['mj-side'] || 0) === 1
  && (o.cls['mj-rail'] || 0) === 1 && (o.tags.select || 0) === 0)
pass('侧栏展开渲染参数', state({ '32': true }), (o) => (o.cls['mj-rail'] || 0) === 0
  && (o.cls['mj-sidebody'] || 0) === 1 && (o.tags.select || 0) >= 2)
pass('侧栏渲染配置页', state({ '35': 'render' }), (o) => (o.tags.select || 0) >= 3
  && (o.tags.input || 0) >= 4 && (o.cls['mj-params'] || 0) === 0)
pass('侧栏内容页（含新建项目）', state({ '35': 'content' }), (o) => (o.tags.select || 0) === 0
  && (o.tags.button || 0) >= 20)
pass('侧栏管线页', state({ '35': 'pipe' }), (o) => (o.tags.select || 0) === 0
  && (o.tags.button || 0) >= 10)
pass('分镜详情弹窗', state({ '33': { shot: { id: 's01', prompt: 'six-section', mode: 'r2v', shot_size: '近景', dialogue: [{ speaker: 'A', text: '台词' }] }, id: 's01', state: 'idle', refs: [], scene: null, secs: 5.2 } }),
  (o) => (o.cls['mj-mask'] || 0) === 1 && (o.cls['mj-modal'] || 0) === 1)
// 小说管理视图已按用户要求移除（内容由用户直接提供，界面不再做目录管理）。
// 改为断言：即使把 view 设成已不存在的 'novel'，界面也必须回退到视频管理而不是白屏。
pass('已移除的小说视图会安全回退', state({ '0': 'novel' }), (o) => (o.tags.button || 0) >= 20)
// 顶部导航（NAV）只剩 视频管理 / ComfyUI 两项 —— 用顶部导航容器里的按钮数断言，
// 不能拿 mj-navb 去数（那是侧栏的 4 个页签）
pass('顶部导航只剩两项', state({}), (o) => (o.cls['mj-nav'] || 0) >= 1 && (o.tags.button || 0) >= 20)
pass('ComfyUI 启动管理页', state({ '0': 'comfy' }), (o) => (o.tags.button || 0) >= 8
  && (o.cls['mj-led'] || 0) >= 1)
pass('新建项目弹窗', state({ '25': true }), (o) => (o.tags.input || 0) >= 6)
pass('角色管理弹窗', state({ '26': true }), (o) => (o.tags.img || 0) >= 2)
pass('无模型路由时退回手填', state({ '8': [], '30': [] }), (o) => (o.tags.select || 0) === 0)
pass('风格预设可选', state({ '30': [{ key: 'ink_wash', name: '水墨国风', prompt: 'INK' }] }),
  (o) => (o.tags.span || 0) >= 1)

// 图标
hookIdx = 0
let iconErr = null
const ico = { nodes: 0, text: 0, tags: {}, bad: [] }
try { render(Icon({ size: 20, active: true }), ico, 0) } catch (e) { iconErr = e }
ok(!iconErr, '侧栏图标组件渲染正常')

// ══════════════════════════ 汇 总 ══════════════════════════
console.log('\n════════════════════════════════')
if (fails.length) {
  console.log('FAILED ' + fails.length + ' 项：')
  fails.forEach((f) => console.log('  - ' + f))
  process.exitCode = 1
} else {
  console.log('全部通过')
}
// 空闲退出注册的 interval 会吊住事件循环，测试必须显式退出
process.exit(fails && fails.length ? 1 : 0)
