/**
 * dsh-manju-studio —— 漫剧工作台 · Host 半
 *
 * 职责：为浏览器半提供 /api/manju-studio 命令接口与 /manju-file 媒体流接口。
 *   * 项目数据读写（小说正文 / 资产库 / 分镜 / 项目信息）
 *   * 资产图片导入（复制进项目目录）
 *   * 调用本地 manju.cmd 渲染、拼接、质检，并结构化解析渲染进度
 *
 * 不解析小说、不生成提示词 —— 提示词由大模型直出，本插件只做编排与呈现。
 */

export const name = 'manju-studio'

export const inject = ['webServer', 'fs', 'subprocess']

const ROOT = 'D:\\Ai\\漫剧'
const MANJU = 'C:\\Users\\Administrator\\.dsh\\skills\\manju-render\\scripts\\manju.cmd'

/**
 * manju.cmd 只是个"钉住解释器 + 强制 UTF-8"的壳。**我们直接调 python，不过 shell**：
 *   * 不用 cmd.exe → 没有批处理引号/转义问题（实测 `cmd /c "…"` 内嵌引号会被转义成
 *     `\"`，cmd 报"不是内部或外部命令"）；
 *   * `-X utf8` 等价于 PYTHONUTF8=1，避开中文 Windows 的 GBK stdio 崩溃；
 *   * 退出码直通，不再经过 `exit /b`。
 */
const MANJU_PY = 'C:\\Users\\Administrator\\.dsh\\skills\\manju-render\\scripts\\manju.py'
const PY_EXE = 'D:\\Ai\\ComfyUI\\standalone-env\\python.exe'
const PY_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: '' }

function manjuArgv(args) {
  return [PY_EXE, '-X', 'utf8', MANJU_PY].concat(args || [])
}
const SPAWN_BASE = 'D:\\Ai'
const API_PATH = '/api/manju-studio'
const FILE_PATH = '/manju-file'
const MAX_BODY = 8 * 1024 * 1024

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const REL_RE = /^[^\\/:*?"<>|]+(\/[^\\/:*?"<>|]+)*$/
const KINDS = ['characters', 'scenes', 'props']
const EMPTY_ASSETS = { characters: [], scenes: [], props: [] }

/**
 * H3 根节点清单：渲染前预检用。
 * 缺任何一个都会让渲染跑到一半才炸 node_errors —— 白白等几分钟，所以提前拦住。
 */
const REQUIRED_NODES = [
  'UNETLoader', 'LoraLoaderModelOnly', 'CLIPLoader', 'VAELoader',
  'MiniMaxH3SigmaShift', 'MiniMaxH3ImageToVideo', 'BasicGuider',
  'BasicScheduler', 'KSamplerSelect', 'RandomNoise', 'SamplerCustomAdvanced',
  'VAEDecode', 'VAEDecodeAudio', 'CreateVideo', 'SaveVideo',
  // Ref2VA 有序多参考图与帧锚点走这两个官方节点；LoadAudio 供参考音频用
  'MiniMaxH3ReferenceToVideo', 'MiniMaxH3AddGuide', 'LoadImage', 'LoadAudio',
]

function applyInner(ctx) {
  const fs = ctx.fs
  const subprocess = ctx.subprocess
  const jobs = Object.create(null)
  let seq = 0
  let lastCpu = null   // 上一次 CPU 时间片采样，用于算占用率（Windows 的 loadavg 恒为 0）
  let gpuCache = null  // nvidia-smi 较慢，缓存 2.5s

  const abs = (rel) => (rel ? ROOT + '\\' + rel : ROOT)

  /**
   * 插件版本 —— **从 package.json 读**，不在这里手写。
   * 手写必然与 package.json 漂移，而"界面显示的版本"正是用来确认重启是否生效的，
   * 漂移了它就没有意义。读不到就返回 ? ，绝不抛错。
   */
  let verCache = null
  async function pluginVersion() {
    if (verCache) return verCache
    try {
      const r = await fs.readText(await fs.resolve('D:\\Ai\\DSH-plugins\\dsh-manju-studio\\package.json'))
      const m = String(r).match(/"version"\s*:\s*"([^"]+)"/)
      verCache = m ? m[1] : '?'
    } catch (e) { verCache = '?' }
    return verCache
  }

  // ───────────────────────── 基础工具 ─────────────────────────

  async function runCmd(argv, cwd, env) {
    const spec = {
      argv,
      cwd: cwd || SPAWN_BASE,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 524288 }, stderr: { maxBytes: 524288 } },
      graceMs: 4000,
    }
    if (env) spec.env = Object.assign({}, process.env, env)
    const h = subprocess.spawn(spec)
    const outcome = await h.done
    let text = ''
    try { if (h.collected.stdout) text += h.collected.stdout.readFrom(0).text } catch (e) { /* 忽略 */ }
    try { if (h.collected.stderr) text += h.collected.stderr.readFrom(0).text } catch (e) { /* 忽略 */ }
    return { exitCode: outcome ? outcome.exitCode : null, text }
  }

  async function mkdirp(p) {
    try { await runCmd(['cmd.exe', '/c', 'md', p], SPAWN_BASE) } catch (e) { /* 已存在 */ }
  }

  async function exists(rel) {
    try { return !!(await fs.stat(await fs.resolve(abs(rel)))) } catch (e) { return false }
  }

  async function readText(rel, dflt) {
    try { return await fs.readText(await fs.resolve(abs(rel))) } catch (e) { return dflt }
  }

  async function readJson(rel, dflt) {
    const t = await readText(rel, null)
    if (t === null || t === undefined) return dflt
    try { return JSON.parse(t) } catch (e) { return dflt }
  }

  async function writeText(rel, text) {
    const p = abs(rel)
    const cut = p.lastIndexOf('\\')
    if (cut > 0) await mkdirp(p.slice(0, cut))
    await fs.writeText(await fs.resolve(p), text)
  }

  async function listDir(rel) {
    try {
      const t = await fs.resolve(abs(rel))
      const st = await fs.stat(t)
      if (!st || st.type !== 'directory') return []
      return await fs.listDir(t)
    } catch (e) { return [] }
  }

  function filesOf(entries) {
    const out = []
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.type === 'file') out.push({ name: e.name, size: e.size || 0 })
    }
    return out
  }

  /**
   * 抽出品列表里的镜头。
   *
   * 镜头的两种形态：
   *   <sid>.mp4            定稿（合成只用这个）
   *   <sid>_take<k>.mp4    抽卡产出的备选（k≥2）
   * 抽卡备选**不参与合成**，否则成片里会出现同一镜的好几个版本。
   */
  function clipsOf(entries) {
    const out = []
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.type === 'file' && /\.mp4$/i.test(e.name)) {
        const m = e.name.match(/^(.+)_take(\d+)\.mp4$/i)
        out.push({
          name: e.name,
          size: e.size || 0,
          final: e.name.indexOf('成片') === 0,
          take: m ? Number(m[2]) : 0,
          shot: m ? m[1] : e.name.replace(/\.mp4$/i, ''),
        })
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return out
  }

  /**
   * 镜头缩略图（poster）缓存 —— 抽一帧存成 JPEG。
   *
   * 为什么不让客户端拿 <video> 当缩略图：`preload="metadata"` 的视频要等 seek
   * 到指定时刻并解码完才有画面，此前是**黑的**；任何重绘/重排都会退回黑再重画，
   * 观感就是「一闪一闪」。而且一屏 7 张卡 = 7 个解码器常驻。
   * 抽帧后卡片是稳定静态图，视频只在灯箱里播。
   *
   * 抽帧失败**不报错**：只是没有 poster 字段，客户端会退回原有行为。
   */
  async function ensurePosters(id, clips) {
    if (!clips || !clips.length) return clips;
    const have = {};
    try {
      const es = await listDir(id + '\\_posters');
      for (let i = 0; i < es.length; i++) if (es[i].type === 'file') have[es[i].name] = true;
    } catch (e) { /* 目录还不存在，下面会建 */ }
    const need = [];
    for (let i = 0; i < clips.length; i++) {
      const base = clips[i].name.replace(/\.mp4$/i, '');
      if (have[base + '.jpg']) clips[i].poster = '_posters\\' + base + '.jpg';
      else need.push(clips[i]);
    }
    if (!need.length) return clips;
    // 先让 fs 层递归建出 _posters 目录（ffmpeg 不会自己建目录）
    try {
      await fs.writeText(await fs.resolve(abs(id + '\\_posters\\.keep')), '');
    } catch (e) { return clips; }
    const ff = await exePath('ffmpeg');
    for (let i = 0; i < need.length; i++) {
      const base = need[i].name.replace(/\.mp4$/i, '');
      const outAbs = abs(id + '\\_posters\\' + base + '.jpg');
      const inAbs = abs(id + '\\' + need[i].name);
      try {
        const r = await runCmd([ff, '-y', '-hide_banner', '-loglevel', 'error',
          '-ss', '0.5', '-i', inAbs, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', outAbs],
          ROOT, null);
        if (r && r.exitCode === 0) need[i].poster = '_posters\\' + base + '.jpg';
      } catch (e) { /* 抽帧失败就保持没有 poster */ }
    }
    return clips;
  }

  /** 参与合成的镜头：定稿 + 不是成片本身。 */
  function finalClips(clips) {
    const out = []
    for (let i = 0; i < clips.length; i++) {
      if (!clips[i].final && !clips[i].take) out.push(clips[i])
    }
    return out
  }

  async function projectIds() {
    const entries = await listDir('')
    const ids = []
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.type !== 'directory') continue
      if (e.name.charAt(0) === '_' || e.name.charAt(0) === '.') continue
      if (!ID_RE.test(e.name)) continue
      ids.push(e.name)
    }
    ids.sort()
    return ids
  }

  async function summary(id) {
    const meta = await readJson(id + '\\project.json', {})
    const doc = await readJson(id + '\\shots.json', { shots: [] })
    const assets = await readJson(id + '\\assets.json', EMPTY_ASSETS)
    const novel = await readText(id + '\\novel.md', '')
    const clips = clipsOf(await listDir(id))
    let assetCount = 0
    let cover = ''
    for (let k = 0; k < KINDS.length; k++) {
      const arr = assets[KINDS[k]]
      if (arr && arr.length) {
        assetCount += arr.length
        // 成品列表封面：优先角色定妆图，其次场景、物品
        if (!cover) {
          for (let i = 0; i < arr.length; i++) {
            if (arr[i] && arr[i].image) { cover = normRel(id, arr[i].image); break }
          }
        }
      }
    }
    let scriptCount = 0
    const sEntries = await listDir(id + '\\script')
    for (let i = 0; i < sEntries.length; i++) {
      if (sEntries[i].type === 'file' && /\.(md|txt)$/i.test(sEntries[i].name)) scriptCount += 1
    }
    return {
      id,
      title: meta.title || id,
      genre: meta.genre || '',
      style: meta.style || doc.style || '',
      shotCount: (doc.shots || []).length,
      assetCount,
      scriptCount,
      cover,
      novelChars: novel ? novel.length : 0,
      clipCount: clips.length,
      hasFinal: clips.some((c) => c.final),
    }
  }

  // ───────────────────── 媒体路径安全守卫 ─────────────────────

  function normRel(pid, rel) {
    let r = String(rel === undefined || rel === null ? '' : rel).replace(/\\/g, '/')
    while (r.length && r.charAt(0) === '/') r = r.slice(1)
    if (r.toLowerCase().indexOf(pid.toLowerCase() + '/') === 0) r = r.slice(pid.length + 1)
    return r
  }

  /**
   * 相对路径白名单。字符类排除了盘符冒号与通配符，再逐段拒绝空段、`.` 与 `..`。
   * 二者缺一不可：只靠前缀比较是无效的 —— 未解析的 `..` 会通过前缀检查，
   * 随后被 fs.resolve 的 realpath 解析到项目目录之外。
   */
  function relOk(clean) {
    if (!clean) return false
    if (!REL_RE.test(clean)) return false
    const segs = clean.split('/')
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      if (s === '' || s === '.' || s === '..') return false
    }
    return true
  }

  // ───────────────────── 渲染日志 → 结构化进度 ─────────────────────

  function jobLines(job) {
    return job.log ? job.log.split(/\r?\n/) : []
  }

  function parseJob(job) {
    const lines = jobLines(job)
    const prog = { index: 0, total: 0, shotId: '', shotElapsed: 0, done: [], failed: [], summary: '' }
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i]
      if (!L) continue
      let m = L.match(/^\[(\d+)\/(\d+)\]\s+(\S+)/)
      if (m) {
        prog.index = parseInt(m[1], 10)
        prog.total = parseInt(m[2], 10)
        prog.shotId = m[3]
        prog.shotElapsed = 0
        continue
      }
      m = L.match(/渲染中\s*(\d+)s/)
      if (m) { prog.shotElapsed = parseInt(m[1], 10); continue }
      m = L.match(/完成\s+([\d.]+)s\s+([\d.]+)\s*MB\s*->\s*(.+)$/)
      if (m) { prog.done.push({ id: prog.shotId, secs: parseFloat(m[1]), mb: parseFloat(m[2]) }); continue }
      m = L.match(/^\s*失败[:：]\s*(.+)$/)
      if (m) { prog.failed.push({ id: prog.shotId, err: m[1] }); continue }
      m = L.match(/^\s*FAIL\s+(\S+):\s*(.+)$/)
      if (m) { prog.failed.push({ id: m[1], err: m[2] }); continue }
      m = L.match(/==\s*汇总\s*==\s*(.+)$/)
      if (m) { prog.summary = m[1]; continue }
    }
    return prog
  }

  // ───────────────────────── 命令实现 ─────────────────────────

  // ───────────────────── 七阶段管线 ─────────────────────
  // 对齐 NiliX：环境·方案·资产·编码·渲染·质检·合成。
  // 日志契约同 NiliX：`━━━ 阶段 X ━━━` 分段 + `[i/n]` 驱动进度，不可破坏。

  const STAGES = [
    { key: 'env', name: '环境' },
    { key: 'plan', name: '方案' },
    { key: 'asset', name: '资产' },
    { key: 'encode', name: '编码' },
    { key: 'render', name: '渲染' },
    { key: 'judge', name: '质检' },
    { key: 'merge', name: '合成' },
  ]

  function defaultParams() {
    return {
      style: '写实',
      styleHit: [],              // 命中的风格预设 key，可组合
      provider: 'deepseek',
      llm: 'deepseek-chat',
      comfyUrl: 'http://127.0.0.1:8199',
      autoStart: true,           // 渲染前 ComfyUI 不在线就自动拉起
      idleExitMin: 0,            // 空闲多少分钟后自动退出 ComfyUI（0 = 不管）
      // ── 资产定妆的 Krea-2 配方（本机实测通过；换机器要按实际文件名改）──
      imgUnet: 'krea2_turbo_fp8_scaled.safetensors',
      imgClip: 'qwen3vl_4b_fp8_scaled.safetensors',
      imgClipType: 'krea2',
      imgVae: 'qwen_image_vae.safetensors',
      imgSteps: 8,
      imgCfg: 1.0,
      genTimeoutSec: 600,
      width: 1344,
      height: 768,
      fps: 24,
      defaultLength: 124,        // 17k+5 网格上的默认帧数，约 5.2 秒
      crf: 16,                   // 编码质量：crf 23 会糊，16 是实测清晰档
      steps: 8,
      seed: 20260920,            // 每镜种子的**基准**：模型没给 seed 时按 基准+i*7 派生
      // ── H3 官方采样契约（对齐 ComfyUI_RH_MinMaxH3 的 sampling 文档）──
      sampler: 'euler',          // euler = 官方默认；res_multistep = 二阶积分器
      shiftVideo: 12.0,          // 视频 flow shift：驱动采样器的 sigma 排程
      shiftAudio: 3.0,           // 音频 flow shift：由视频排程内部推导，**必须配套改**
      refImageSize: 'match',     // match = 缩到本次像素面积；max = 2048 短边（保真最好但慢数倍）
      transition: 'cut',         // cut / fade（dissolve 会被降级为 fade）
      loudness: -16,             // loudnorm 目标响度
      darkFail: 0.5,             // 黑场占比 ≥ 此值判不合格
      darkWarn: 0.15,            // 黑场占比 ≥ 此值给警告
      // ── 字幕 ──
      subtitles: true,           // 合成时烧录字幕（由 plan 的台词生成，按画布宽度折行）
      // 平台合规：''=关；'hongguo'=红果（画面常驻 AI 标注 + 预留右侧 5%/底部 8%，字幕自动上移让位）
      compliance: '',
      subtitleSize: 5,           // 字号 = 画布高度 × 此百分比（768p 下 5% ≈ 38px）
      // ── 加速（GPU）──
      // 加速机制：**步数与采样器由机制决定，不开放自由填** —— 各机制的安全步数不同
      // （注入式 6–8 / 后训练蒸馏 3–4 / 稀疏注意力 8 / 混合注意力 8），
      // 填错会喂给模型没训过的评估点，直接出重噪声。
      accel: 'pdd8',             // pdd8/pdd6/pdd4 = 官方 PDD 蒸馏；turbo4 = Turbo LoRA+配套采样器；none = 退路
      // 抽卡：一镜渲 N 个 seed 供挑选。1 = 不抽卡（行为与改造前一致）。
      // 成本线性（N 倍时间，显存峰值不变），所以默认 1，按需开。
      takes: 1,
      vaeInt8: true,             // int8 视频 VAE：解码约 -35%，换模型即生效
      // 显存优化：off / lowattn / chunkff / both。两个节点都声明"输出与未打补丁一致"，
      // 属纯内存布局优化。**刻意不含 SageAttention** —— 本机底模是 int8，而知识库两页
      // 独立记载「int8 的 QK 承载不了 H3 的 QK-RMSNorm + rope：Sage2 纯噪声、Sage1 丢高频」。
      vramMode: 'off',
      clipFail: -0.1,            // 音频峰值 ≥ 此值判削波（不可逆）
      clipWarn: -1.0,            // 音频峰值 ≥ 此值给警告（加速路径常见）
      minDuration: 1.0,          // 短于此时长判不合格（H3 产物不该低于 1 秒）
      maxDuration: 20,           // 长于此只给警告
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function setStage(job, key, state, note) {
    for (let i = 0; i < job.stages.length; i++) {
      if (job.stages[i].key === key) {
        job.stages[i].state = state
        if (note !== undefined) job.stages[i].note = note
      }
    }
  }

  async function runStreaming(job, argv, cwd) {
    const h = subprocess.spawn({
      argv: argv,
      cwd: cwd || SPAWN_BASE,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4194304 }, stderr: { maxBytes: 4194304 } },
      graceMs: 6000,
    })
    job.handle = h
    let offOut = 0
    let offErr = 0
    let finished = false
    let code = null
    h.done.then((o) => { finished = true; code = o ? o.exitCode : null }).catch(() => { finished = true; code = -1 })
    const drain = () => {
      try { if (h.collected.stdout) { const r = h.collected.stdout.readFrom(offOut); offOut = r.nextOffset; job.log += r.text } } catch (e) { /* 忽略 */ }
      try { if (h.collected.stderr) { const r2 = h.collected.stderr.readFrom(offErr); offErr = r2.nextOffset; job.log += r2.text } } catch (e) { /* 忽略 */ }
    }
    while (!finished && !job.stop) {
      drain()
      await sleep(700)
    }
    if (job.stop && !finished) {
      try { h.terminate() } catch (e) { /* 进程可能已退出 */ }
    }
    // 等终止真正落地，最多再等 6 秒，避免把「已停止」报成还在跑
    let waited = 0
    while (!finished && waited < 12) { await sleep(500); drain(); waited += 1 }
    drain()
    job.handle = null
    job.log = job.log.slice(-400000)
    return job.stop ? -2 : code
  }

  function parseProgress(lines) {
    let index = 0
    let total = 0
    let label = ''
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\[(\d+)\/(\d+)\]\s+(\S+)/)
      if (m) {
        index = parseInt(m[1], 10)
        total = parseInt(m[2], 10)
        label = m[3]
      }
    }
    return { index, total, label }
  }

  // 非自动化阶段：只留真正需要人工判断的。资产已由 Krea-2 自动生成，不在其中。
  const MANUAL = {
    encode: '编码：R2V 参考图预编码（缓存 .pt）随渲染自动完成',
  }

  // ───────────────────── 方案阶段：大模型直出分镜 ─────────────────────

  // ═══════════ H3 官方提示词契约（2026-09-20 对齐 ManJuX 实测定稿）═══════════
  //
  // 这一节是整套管线的地基：方案阶段产出的每一镜 h3_prompt 必须严格符合 H3 的官方格式，
  // 否则渲染出来的画面与提示词无关。以下规则逐条来自实测，改动前先想清楚代价。
  /** H3 官方运镜词表。**只许用这些** —— dolly / crane / whip pan 之类的行话 H3 不认。 */
  const H3_CAMERA = ['Push In', 'Pull Out', 'Pan', 'Truck', 'Tilt', 'Pedestal', 'Arc', 'Tracking', 'Static', 'POV', 'Roll', 'Shake']
  /** 景别用中文。情感戏与台词必须用近景/特写：H3 的面部 token 稀缺，近景才给得出表情。 */
  const H3_SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写']
  /** H3 官方保留度标记。 */
  const H3_RETENTION = 'fully_preserved / partially_preserved / attribute_transfer / weak_reference'
  /** 亮度护栏：写在每镜提示词最后一句，是**提示词侧**的黑屏防线（质检侧 blackdetect 是第二道）。 */
  const H3_BRIGHTNESS_GUARD = 'Subjects must remain clearly visible and adequately lit throughout the video; avoid rendering any frame nearly black or overly dark.'
  const H3_EXCLUSIONS = 'No on-screen text, no subtitles, no watermarks, no logos.'
  /** 普通话锁。H3 靠 <d> 里的语言标记决定说什么语言，漏标记就会出听不懂的"鸟语"。 */
  const H3_MANDARIN_LOCK = 'MANDARIN ONLY (mandatory language rule): every spoken line and voiceover MUST be Mandarin Chinese (普通话), '
    + 'matching the [Chinese] tag inside each <d>…</d>; no English, no Japanese, no invented or gibberish speech, no foreign accent. '
    + 'Ambient non-speech sound only where the soundscape asks for it.'
  /**
   * 中文台词语言标记兜底（幂等）。
   *
   * H3 靠 <d>…</d> 里的语言标记决定用哪种语言说话；提示词模板要求写 <d>[Chinese]台词</d>，
   * 但大模型经常漏，漏了就自己猜 —— 实测成片里出现听不懂的"鸟语"。
   * 做法与 ManJuX 一致：先把 <d>[任意语言] 归一成裸 <d>，再把裸 <d> 统一换成 <d>[Chinese]。
   * 两步之后所有台词都恰好带一个中文标记。幂等判据是 "MANDARIN ONLY" 这个标记串。
   */
  function ensureChineseDialogue(prompt) {
    const p = String(prompt || '')
    if (p.indexOf('<d>') < 0) return p
    let out = p.replace(/<d>\s*\[[A-Za-z][A-Za-z ]*\]\s*/g, '<d>')
    out = out.split('<d>').join('<d>[Chinese]')
    if (out.indexOf('MANDARIN ONLY') < 0) out += '\n\n' + H3_MANDARIN_LOCK
    return out
  }
  /** 风格预设：可组合。key → 提示词片段（全大写是有意的，H3 对前置强风格的响应最好）。 */
  const STYLE_PRESETS = {
    urban_xianxia: { name: '都市仙侠霓虹', prompt: 'CHINESE URBAN-XIANXIA, NEON-NOIR WET-STREET LIGHTING, CINEMATIC ANIMATION, GOD RAYS THROUGH SKYSCRAPERS' },
    guoman_2d: { name: '国漫二维动画', prompt: 'CHINESE 2D ANIME STYLE, CLEAN LINEWORK, VIBRANT CEL SHADING, DONGHUA QUALITY' },
    live_action: { name: '真人实拍质感', prompt: 'PHOTOREALISTIC LIVE-ACTION CINEMATOGRAPHY, 35MM FILM, SHALLOW DEPTH OF FIELD, NATURAL SKIN TEXTURE' },
    pixar_3d: { name: '3D 皮克斯', prompt: 'PIXAR-STYLE 3D RENDER, SOFT GLOBAL ILLUMINATION, EXPRESSIVE STYLIZED CHARACTERS, SUBSURFACE SCATTERING' },
    ink_wash: { name: '水墨国风', prompt: 'CHINESE INK WASH PAINTING STYLE, BRUSH TEXTURE, NEGATIVE SPACE, MISTY MOUNTAINS, TRADITIONAL AESTHETIC' },
    cyberpunk: { name: '赛博朋克', prompt: 'CYBERPUNK, RAIN-SOAKED STREETS, HOLOGRAPHIC ADS, CHROME AND NEON, BLADE RUNNER MOOD' },
    ghibli: { name: '吉卜力手绘', prompt: 'GHIBLI-INSPIRED HAND-PAINTED, WARM WATERCOLOR BACKGROUNDS, SOFT WIND AND LIGHT, WHIMSICAL SERENITY' },
    film_noir: { name: '黑色电影', prompt: 'FILM NOIR, HIGH CONTRAST BLACK AND WHITE WITH ONE ACCENT COLOR, VENETIAN BLIND SHADOWS, SMOKEY' },
    hongkong: { name: '港片胶片', prompt: 'HONG KONG CINEMA 1990s, SATURATED NEON, TEAL-ORANGE GRADE, ANAMORPHIC FLARES' },
    claymation: { name: '黏土定格', prompt: 'CLAYMATION STOP-MOTION STYLE, FINGERPRINT TEXTURE, TACTILE HANDMADE CHARM' },
  }
  /**
   * 风格块展开。**铁律：风格只描述渲染表面（材质 / 光泽 / 媒介），绝不含形状类词汇。**
   *
   * 实测事故：风格块里曾写 "large glossy stylized eyes"，与角色卡的"细长单眼皮"直接打架，
   * 定妆照被风格重新设计成圆软脸大眼，而视频按文字走 —— 同一个角色出三张脸。
   * 所以这里只允许材质与媒介词，形状/五官/年龄一律不进风格块。
   */
  function styleExpand(styleHit, freeHint) {
    const keys = Array.isArray(styleHit) ? styleHit : (styleHit ? [styleHit] : [])
    const parts = []
    for (let i = 0; i < keys.length; i++) {
      const p = STYLE_PRESETS[keys[i]]
      if (p) parts.push(p.prompt)
    }
    let terms = parts.join(' + ')
    if (freeHint && String(freeHint).trim()) {
      terms = terms ? terms + '; ' + String(freeHint).trim() : String(freeHint).trim()
    }
    return terms
  }
  /**
   * 项目最终生效的风格句。**宿主是唯一真源**：
   * 界面上勾选的风格预设（styleHit）在这里展开成提示词片段，再拼上自由文本（style）。
   * 之前界面自己也拼一份写回 style，会出现"预设被拼两遍"，而且两处真源必然漂移。
   */
  /** 旧机制名迁移：'pdd' → 'pdd<nfe>'。不迁移界面会显示"未设置"、渲染会退化。 */
  function normAccel(accel, nfe) {
    const a = String(accel || "").toLowerCase()
    if (a === "pdd") {
      const n = Number(nfe) || 8
      return "pdd" + ([4, 6, 8].indexOf(n) >= 0 ? n : 8)
    }
    return ["pdd8", "pdd6", "pdd4", "turbo4", "none"].indexOf(a) >= 0 ? a : "pdd8"
  }

  function effectiveStyle(params) {
    const hit = Array.isArray(params.styleHit) ? params.styleHit : []
    const free = String(params.style || '').trim()
    const presetOnly = styleExpand(hit, '')
    if (!presetOnly) return free
    if (!free) return presetOnly
    // 去重：自由文本已经被预设覆盖（或反过来）时不要拼两遍。
    // 老项目里 style 常被写成与预设相同的整句，不去重就会得到
    // "…DONGHUA QUALITY; …DONGHUA QUALITY" 这种重复前缀（实测踩过）。
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const nf = norm(free)
    const np = norm(presetOnly)
    if (!nf || nf === np || np.indexOf(nf) >= 0) return presetOnly
    if (nf.indexOf(np) >= 0) return free
    return presetOnly + '; ' + free
  }

  /** 忠实度硬约束：风格只改渲染表面，绝不允许改写角色长相（尤其防"美人先验"）。 */
  function identityFidelityBlock() {    return '\n\nIDENTITY FIDELITY (mandatory): the face must match the written brief EXACTLY — '
      + 'same face shape and jaw, same chin, same eye shape and eyelids, same brow shape, same nose, same hair length and style. '
      + 'Art style changes the RENDERING SURFACE only (material, sheen, shading); it must NEVER change the character\'s features. '
      + 'Do not beautify, do not enlarge or round the eyes, do not soften a sharp jaw, do not make the subject younger, prettier or more handsome than described. '
      + 'Do NOT add any lettering, name tag text or emblem text to the clothing unless the brief explicitly asks for it.'
  }
  /**
   * 方案阶段的系统提示词 = H3 官方导演契约。
   *
   * 结构：输出 JSON 骨架 → 分镜规则 → H3 提示词格式（ref2va 六段式 / t2va 三段式）
   *      → 硬约束 → 选角差异化。
   * 画质 / 步数等"会随项目变的值"必须插进提示词，否则模型按自己的默认值写，与 render 实际用的值打架。
   */
  function planSystem(params) {
    const W = params.width || 1344
    const H = params.height || 768
    const STEPS = params.steps || 8
    const SEC = Math.round(((params.defaultLength || 124) / (params.fps || 24)) * 10) / 10
    return [
      '你是漫剧分镜师兼 H3 提示词工程师。把用户给的小说 / 剧本正文拆成镜头，为每一镜写一条**完整的 MiniMax H3 提示词**。',
      '只输出一个 JSON 对象，不要任何解释文字，不要 Markdown 代码围栏。',
      '',
      '## 输出结构',
      '{',
      '  "style": "全局风格句（英文，见下方风格铁律）",',
      '  "characters": [{"id":"c1","name":"角色名","description":"中文形象设定：年龄/脸型/体型/发型发色/肤色/服装/一个标志性记号"}],',
      '  "scenes":     [{"id":"s1","name":"场景名","description":"中文场景设定：地点/时间/光线/氛围/关键陈设"}],',
      '  "shots": [{',
      '    "id": "s01",',
      '    "mode": "r2v",                       // 有角色或场景参考图用 r2v，纯文生用 t2v',
      '    "shot_size": "近景",                  // 远景/全景/中景/近景/特写',
      '    "camera": "Push In, small amplitude, slow",',
      '    "characters": ["c1"],                // 出场角色的 id，按出场顺序',
      '    "scene": "s1",',
      '    "dialogue": [{"speaker":"角色名","text":"中文台词原文"}],   // 无台词写 []',
      '    "length": ' + (params.defaultLength || 124) + ',',
      '    "seed": 101,',
      '    "h3_prompt": "……六段式或三段式全文……"',
      '  }]',
      '}',
      '',
      '## 分镜规则',
      // 平台合规的构图约束必须在**生成期**就写进提示词 —— 只在合成期贴遮罩的话，
      // 要么裁掉画面、要么盖住主体，两种都是坏的。
      (COMPLIANCE[params.compliance]
        ? '\n## 平台构图约束（硬性）\n' + COMPLIANCE[params.compliance].prompt
          + '\n把这条要求原样并入每一镜 h3_prompt 的 detailed_description 里。\n'
        : ''),
      '- 镜数由内容决定，**不设上限**：内容密的一章可以正当需要 15–30 镜。宁可多拆小镜，也不要把几个动作塞进一镜。',
      '- 每镜 4–8 秒。本地渲染成本随帧数**超线性**增长（10 秒镜的负载约为 6 秒镜的 2.8 倍），所以长节拍要拆成两镜，而不是把一镜拉长。',
      '- **连贯性（关键）**：每一镜的动作必须从上一镜**结束的地方**开始 —— 同一地点（除非刻意的转场）、承接的姿态/情绪/道具、一致的天光与光线。绝不跳过一个观众需要的叙事节拍。',
      '- 景别用中文。**情感节拍与台词必须用近景/特写**：H3 的面部 token 稀缺，近景才给得出表情。',
      '- 每镜**只允许一个**运镜，且只能从官方词表里选：' + H3_CAMERA.join(' / ')
        + '，可附幅度（small / large amplitude）与速度（slow / fast）。'
        + '**绝不使用行话**：dolly、crane、whip pan、steadicam 这类词 H3 不认。',
      '- 台词每句 ≤20 字，自然收尾于 。？！；每镜最多 2 个说话人。旁白是画外音，画面里的人物嘴唇保持闭合，少用。',
      '',
      '## H3 提示词格式（必须严格遵守）',
      'mode=r2v → **六段式**，按此顺序，段与段之间空一行：',
      '',
      'subject_definitions:',
      '参考图进入顺序即契约（官方定义）：**先图片，再视频，最后是独立音频**；每一类里的序号各自从 1 开始，所以提示词用 <Picture i> / <Video k> / <Audio j> 引用。',
      '本项目只会喂图片：按 characters 数组顺序，每个角色先给**正面定妆照**（锐利的锁脸锚点），若该角色有多视角转台图再紧跟着给一张；全部角色图之后，**场景图永远在最后一张**。道具不发 <Picture>，只在文字里描述。',
      '参考 token 会参与**每一个采样步**，所以图越精细越贵（2048 短边会比 match 模式慢数倍）——不要为了凑数塞无关图片。',
      '**按图片内容而非下标定位主体**：定妆照与转台图是**同一个人**，绝不把转台图当成第二个角色；绝不做"N 个角色所以场景是 <Picture N+1>"的推理 —— 有 N 个角色时场景是最后一张，只有当没有角色带转台图时才恰好是 N+1。',
      '<Subject 1> is [第一个角色的完整描述]；<Subject 2> is [第二个角色，或只有单角色时写场景] …… 每个 <Subject> 必须对应上面真实存在的一张图。',
      '',
      'summary:',
      '[reference generation]',
      '一段英文：这个视频是什么内容、参考素材怎么被使用。',
      '',
      'retention_analysis:',
      '每张参考图一行，编号与 subject_definitions 完全一致（）使用官方标记：' + H3_RETENTION + '）。',
      '角色图一律 fully_preserved 并写明 FACE LOCK：脸部特征必须逐帧照抄该角色自己的那张图，不得混合、平均或替换成别的脸。',
      '场景图写 weak_reference：只参考布局与氛围，镜头自由。',
      '多角色镜头里每个角色各占一行 fully_preserved；**没有参考图的角色不许借用任何参考图的五官**，只能用文字描述生成。',
      '有参考图时，参考图就是该角色长相的**唯一权威**：脸/发型/肤色/年龄感照抄参考图，文字只用于服装 / 道具 / 姿态 / 情绪；参考图上没有的面部标记（痣、疤、腮红、红鼻头）一律不得无中生有。',
      '',
      'detailed_description:',
      '[风格句置首]。然后逐镜：第一镜写 [Shot 1] 不带时间戳，其后写 [Shot 2] At 00:06.000 且时间戳严格递增。',
      '每镜段落写清：景别与构图 → 主体位置 → 该镜首次出现时重申服装/道具/姿态/状态 → **一个**主要动作 → 可见的情绪变化（演出来，不要贴标签）→ 带幅度与速度的运镜 → 声音事件。',
      '台词写法：<Subject 1> (S1) says in a [声音描述]: <d>[Chinese]台词原文</d>。按首次开口顺序分配 (S1)(S2)，全片不重编号。中文台词在 <d> 里**逐字照抄**，保留原标点，不改写不翻译。',
      '旁白写法：The narrator (S1) says in an off-screen voiceover: <d>[Chinese]旁白原文</d>，同时画面人物嘴唇保持完全闭合。',
      '本段末尾用散文写排除项，例如："' + H3_EXCLUSIONS + '"',
      '**最后一句必须是亮度护栏，逐字照抄**："' + H3_BRIGHTNESS_GUARD + '"',
      '',
      'overall_soundscape:',
      '1–4 句英文环境音（叙事内声音）。**不要在这里重复台词。**',
      '',
      'non_diegetic_music:',
      '乐器 + 速度 + 节奏 + 力度（英文），例如 "Guzheng and low strings, slow tempo, sparse rhythm, gradually building dynamics."；若该镜适合静默就写 "N/A"。',
      '',
      'mode=t2v → **三段式**，按此顺序，段间空一行：integrated_multimodal_description: / overall_soundscape: / non_diegetic_music:',
      '（integrated_multimodal_description 的写法与上面 detailed_description 完全相同，含台词标记、运镜词表、排除项与亮度护栏。）',
      '',
      '## 硬约束',
      '- 结构性文字用英文；中文台词在 <d>[Chinese]…</d> 里逐字保留。',
      '- **每一句台词与旁白都必须带 [Chinese] 标记**。漏了标记模型会即兴换成别的语言，成片出现听不懂的鸟语。每次都要写成 <d>[Chinese]台词原文</d>。',
      '- 外貌事实**只能来自原文**。原文没写的痣、疤、胎记、红鼻头、纹身、异色发/瞳一律不许发明 —— 发明出来的记号会出现在成片里，与固定的角色卡打架。',
      '- 同剧角色必须**一眼能分辨**：不要两个主角落在同一年龄段、同一体格、同一配色（例如两个褐袍白须老者）。用年龄 / 体格 / 发型 / 剪影 / 服装颜色拉开差异，每人给一个原文支持的记忆点。这是设计规则，不是发明的许可。',
      '- **一个角色 = 一张卡**。同一个人可能同时以名字和代号/编号出现（例如 机关人 / 阿枢 / 一三七四一号），那是同一个人：只保留一张角色卡，挑信息量最大的名字，每一镜逐字复用。',
      '- h3_prompt 总长 2500–6000 字符；detailed_description 正文 350–500 英文单词。',
      '- **不许写负面提示词语法**，不许写 CFG 或任何技术参数 —— 排除项一律用散文写在段末。（H3 是 CFG 蒸馏权重，负面词基本不生效，反而会照着名词画出来。）',
      '- 一致性：同一角色在每一镜用完全相同的形象用词；同一场景复用同一名字。',
      '- 声音分工不重复：台词只走 <d>；环境音走 overall_soundscape；配乐走 non_diegetic_music。',
      '- 画面里可读的文字必须逐字引用并保留原语言。**但 H3 画不出可读文字**：招牌 / 字幕 / 系统面板 / 属性窗一律不要写进提示词去赌，需要时后期合成。',
      '',
      '## 风格铁律',
      '- 风格句必须放在 detailed_description 的**最开头**并显式强化。放句尾强度不足，会跑成写实照片。',
      '- 风格块**只描述渲染表面（材质 / 光泽 / 媒介）**，绝不含形状类词汇。写 "large glossy stylized eyes" 这类词会让定妆照与视频各画一张脸。',
      '- 整片风格与 style 字段保持一致。',
      '',
      '## 画面规格（由项目参数决定，写进 shot 字段）',
      '- width/height = ' + W + '/' + H + '（短边 768 是 H3 原生分辨率，不要调小）。',
      '- length 必须落在 17k+5 网格上，默认 ' + (params.defaultLength || 124) + '（约 ' + SEC + ' 秒）。',
      '- steps = ' + STEPS + '。seed 每镜不同。',
    ].join('\n')
  }

  /** 帧数吸附到 17k+5 网格，并夹在实测可用的 124–362 区间。 */
  function snapLength(n) {
    const v = parseInt(n, 10)
    if (!v || isNaN(v)) return 124
    let k = Math.round((v - 5) / 17)
    if (k < 7) k = 7
    if (k > 21) k = 21
    return 17 * k + 5
  }

  /**
   * 把模型返回的方案规整成 shots.json 的确定形状；不合格就抛错，绝不写坏文件。
   *
   * 这一层是 H3 官方契约的**代码级兜底**：大模型写的东西不能直接信 ——
   *   * h3_prompt 落到 manju.py 认的 `prompt` 字段上；
   *   * 台词语言标记统一补齐（ensureChineseDialogue，幂等）；
   *   * 帧数吸附到 17k+5 网格；
   *   * mode 按"有没有角色/场景"推定，避免 LLM 写错权重分支；
   *   * 角色/场景 id 引用校验，悬空引用直接丢弃而不是留给渲染器炸。
   */
  function normalizeShots(raw, project, style, params) {
    let doc = raw
    if (typeof doc === 'string') {
      let t = doc.trim()
      t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
      const a = t.indexOf('{')
      const b = t.lastIndexOf('}')
      if (a < 0 || b <= a) throw new Error('模型没有返回 JSON 对象')
      doc = JSON.parse(t.slice(a, b + 1))
    }
    if (!doc || typeof doc !== 'object') throw new Error('方案不是对象')
    const arr = doc.shots
    if (!arr || !arr.length) throw new Error('方案的 shots 为空')
    const clean = (v) => String(v === undefined || v === null ? '' : v).trim()
    const normChars = []
    const rawChars = doc.characters || []
    for (let i = 0; i < rawChars.length; i++) {
      const c = rawChars[i] || {}
      let id = clean(c.id)
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) id = 'c' + (i + 1)
      const name = clean(c.name) || id
      normChars.push({ id: id, name: name, description: clean(c.description) })
    }
    const normScenes = []
    const rawScenes = doc.scenes || []
    for (let i = 0; i < rawScenes.length; i++) {
      const s = rawScenes[i] || {}
      let id = clean(s.id)
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) id = 's' + (i + 1)
      normScenes.push({ id: id, name: clean(s.name) || id, description: clean(s.description) })
    }
    const charId = {}
    for (let i = 0; i < normChars.length; i++) charId[normChars[i].id] = true
    const sceneId = {}
    for (let i = 0; i < normScenes.length; i++) sceneId[normScenes[i].id] = true
    const out = []
    let voiceFixed = 0
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i] || {}
      // h3_prompt 是官方字段名，prompt 是渲染器字段名；两者都认
      let prompt = clean(s.h3_prompt || s.prompt)
      if (prompt.length < 40) continue
      const fixed = ensureChineseDialogue(prompt)
      if (fixed !== prompt) voiceFixed += 1
      prompt = fixed
      let id = clean(s.id)
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) id = 's' + (i + 1 < 10 ? '0' : '') + (i + 1)
      // 参考图契约：角色按出场顺序在前，场景永远最后
      const ids = Array.isArray(s.characters) ? s.characters : []
      const keepChars = []
      for (let k = 0; k < ids.length; k++) {
        const c = clean(ids[k])
        if (charId[c] && keepChars.indexOf(c) < 0) keepChars.push(c)
      }
      const sc = clean(s.scene)
      const keepScene = sceneId[sc] ? sc : ''
      const shot = {
        id: id,
        prompt: prompt,
        // 有参考图就走 Ref2VA 权重分支；LLM 写错时以实际引用为准
        mode: (keepChars.length || keepScene) ? 'r2v' : 't2v',
        width: params.width || 1344,
        height: params.height || 768,
        length: snapLength(s.length || params.defaultLength),
        steps: params.steps || 8,
        // 模型没给 seed 时按项目基准派生：同一份方案配同一个基准可完全复现种子序列
        seed: Number.isFinite(Number(s.seed)) ? Number(s.seed) : ((params.seed || 20260920) + i * 7),
        characters: keepChars,
        scene: keepScene,
        shot_size: clean(s.shot_size),
        camera: clean(s.camera),
      }
      if (Array.isArray(s.dialogue) && s.dialogue.length) {
        const d = []
        for (let k = 0; k < s.dialogue.length; k++) {
          const line = s.dialogue[k] || {}
          const text = clean(line.text)
          if (text) d.push({ speaker: clean(line.speaker), text: text })
        }
        if (d.length) shot.dialogue = d
      }
      if (s.first_frame) shot.first_frame = clean(s.first_frame)
      out.push(shot)
    }
    if (!out.length) throw new Error('方案里没有一条可用提示词（每条至少 40 字符）')
    return {
      project: project,
      style: String(doc.style || style || '').trim(),
      characters: normChars,
      scenes: normScenes,
      shots: out,
      _voiceFixed: voiceFixed,
    }
  }

  /** 解析 provider / model 路由：配置项失效时退回第一个可用路由，绝不瞎猜。 */
  async function resolveRoute(params) {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('宿主未提供 llm 服务；方案阶段可改由 Agent 直出 shots.json')
    }
    let providers = []
    try { providers = llm.listProviders() || [] } catch (e) { providers = [] }
    if (!providers.length) throw new Error('没有已注册的大模型路由，请先在 DSH 设置里配置模型')

    let provider = String(params.provider || '')
    let hit = false
    for (let i = 0; i < providers.length; i++) if (providers[i].id === provider) hit = true
    if (!hit) {
      let fallback = providers[0].id
      for (let i = 0; i < providers.length; i++) if (providers[i].id === 'deepseek') fallback = 'deepseek'
      provider = fallback
    }

    let model = String(params.llm || '')
    if (!model) {
      try {
        const ms = await llm.listModels(provider)
        model = ms && ms.length ? ms[0].id : ''
      } catch (e) { model = '' }
    }
    if (!model) throw new Error('未指定模型（参数里的 LLM）')
    return { provider: provider, model: model }
  }

  /** 一次不带工具的纯文本调用，把流式增量拼成完整回复。 */
  async function callLlm(route, system, user, onDelta) {
    const llm = ctx.get('llm')
    const opts = {
      provider: route.provider,
      model: route.model,
      system: system,
      temperature: 0.7,
      maxTokens: 8192,
      messages: [{
        id: 'manju-plan-1',
        role: 'user',
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin', plugin: 'manju-studio', form: 'instructions' },
      }],
    }
    let text = ''
    const stream = llm.stream(opts)
    for await (const c of stream) {
      if (!c) continue
      if (c.type === 'text-delta') {
        text += c.text
        if (onDelta && text.length % 400 < c.text.length) onDelta(text.length)
      } else if (c.type === 'finish') {
        const r = c.reason || {}
        if (r.kind === 'error') {
          throw new Error('模型调用失败：' + String((r.failure && r.failure.message) || '未说明'))
        }
        if (r.kind === 'aborted') throw new Error('模型调用被中止')
      }
    }
    if (!text.trim()) throw new Error('模型返回了空内容')
    return text
  }

  /** 取方案阶段的输入正文：脚本直出优先取 script/，否则用 novel.md。 */
  async function planSource(job) {
    const entries = await listDir(job.project + '\\script')
    const files = []
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type === 'file' && /\.(md|txt)$/i.test(entries[i].name)) files.push(entries[i].name)
    }
    files.sort()
    if (files.length) {
      const rel = 'script/' + files[0]
      const t = await readText(job.project + '\\' + rel.replace(/\//g, '\\'), '')
      if (t && t.trim()) return { text: t, from: rel }
    }
    const novel = await readText(job.project + '\\novel.md', '')
    if (novel && novel.trim()) return { text: novel, from: 'novel.md' }
    return { text: '', from: '' }
  }

  /** 生成分镜并写盘。任何失败都在写盘之前抛出，shots.json 保持原样。 */
  async function genPlan(job) {
    const meta = await readJson(job.project + '\\project.json', {})
    const params = Object.assign(defaultParams(), meta.params || {})
    const src = await planSource(job)
    if (!src.text.trim()) {
      throw new Error('没有可用的正文：请先在「内容来源」导入小说或脚本')
    }
    const route = await resolveRoute(params)
    job.log += '  模型 ' + route.provider + '/' + route.model
      + ' · 输入 ' + src.from + '（' + src.text.length + ' 字）\n'

    const style = effectiveStyle(params)
    const user = [
      '项目名：' + job.project,
      '全局风格句（必须原样前置到每一镜 prompt 的最开头）：' + (style || '写实'),
      '正文如下：',
      '---',
      src.text.slice(0, 12000),
      '---',
      '现在只输出那个 JSON 对象。',
    ].join('\n')

    const raw = await callLlm(route, planSystem(params), user, (n) => {
      job.log += '  …已生成 ' + n + ' 字符\n'
    })
    const doc = normalizeShots(raw, job.project, style, params)

    // 备份原文件，便于回退
    const old = await readText(job.project + '\\shots.json', '')
    if (old && old.trim()) {
      try { await writeText(job.project + '\\shots.json.bak', old) } catch (e) { /* 备份失败不阻断 */ }
    }

    // 两份产物：plan.json 是"作者写的完整方案"（含角色/场景卡，供资产阶段与 UI 读），
    // shots.json 是"渲染器认的输入"（只留 manju.py 会读的字段）。
    const planDoc = {
      project: job.project,
      style: doc.style,
      characters: doc.characters,
      scenes: doc.scenes,
      shots: doc.shots,
    }
    await writeText(job.project + '\\plan.json', JSON.stringify(planDoc, null, 2))
    await writeText(job.project + '\\shots.json', JSON.stringify({
      project: doc.project,
      style: doc.style,
      shots: doc.shots,
    }, null, 2))

    // 统计参考图契约的覆盖面，让"有几镜其实没参考图"这件事可见
    let withRef = 0
    let r2v = 0
    for (let i = 0; i < doc.shots.length; i++) {
      if (doc.shots[i].mode === 'r2v') r2v += 1
      if ((doc.shots[i].characters && doc.shots[i].characters.length) || doc.shots[i].scene) withRef += 1
    }
    job.log += '  已写入 plan.json / shots.json：' + doc.shots.length + ' 镜'
      + ' · 角色 ' + doc.characters.length + ' · 场景 ' + doc.scenes.length
      + ' · 走 Ref2VA ' + r2v + ' 镜（有参考引用 ' + withRef + ' 镜）'
      + (doc._voiceFixed ? ' · 补齐中文台词标记 ' + doc._voiceFixed + ' 镜' : '')
      + (old && old.trim() ? ' · 原文件备份为 shots.json.bak' : '') + '\n'
    return doc.shots.length
  }

  function stageOf(job, key) {
    for (let i = 0; i < job.stages.length; i++) {
      if (job.stages[i].key === key) return job.stages[i]
    }
    return null
  }

  function stageCmds(job) {
    const out = abs(job.project)
    return {
      env: { argv: manjuArgv(['check']), cwd: SPAWN_BASE },
      render: {
        argv: manjuArgv(['render', '--shots', job.shotsArg || (out + '\\shots.json'), '--out', out]),
        cwd: out,
        need: 'shots.json',
      },
      // 注意：judge 与 merge 都不走这里 ——
      // 质检由 execStage 直接调 qcProject（含黑屏防线），
      // 合成由 execStage 直接调 composeFinal（禁流复制 + 响度归一 + faststart）。
    }
  }

  /**
   * 按「镜头范围 / 集数 / 章节」从 shots.json 里挑镜头。三者都没填 = 全本。
   * 镜头范围接受序号、`3-5` 区间与镜头 id，逗号或空格分隔。
   * 集数/章节按镜头自身的 episode(ep) / chapter 字段过滤 —— 没有该字段的项目等于全本。
   */
  function pickShots(doc, range) {
    const all = (doc && doc.shots) || []
    const r = range || {}
    const pick = []

    const only = String(r.shots || '').trim()
    if (only) {
      const parts = only.split(/[,，\s]+/)
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        if (!p) continue
        const m = p.match(/^(\d+)\s*[-~]\s*(\d+)$/)
        if (m) {
          const a = parseInt(m[1], 10)
          const b = parseInt(m[2], 10)
          for (let n = Math.min(a, b); n <= Math.max(a, b); n++) {
            if (n >= 1 && n <= all.length && pick.indexOf(all[n - 1]) < 0) pick.push(all[n - 1])
          }
          continue
        }
        if (/^\d+$/.test(p)) {
          const n = parseInt(p, 10)
          if (n >= 1 && n <= all.length && pick.indexOf(all[n - 1]) < 0) pick.push(all[n - 1])
          continue
        }
        for (let k = 0; k < all.length; k++) {
          if (String(all[k] && all[k].id) === p && pick.indexOf(all[k]) < 0) { pick.push(all[k]); break }
        }
      }
      return { shots: pick, filtered: true, by: '镜头范围 ' + only }
    }

    const ep = String(r.episode || '').trim()
    if (ep) {
      for (let k = 0; k < all.length; k++) {
        const s = all[k] || {}
        const v = s.episode === undefined ? s.ep : s.episode
        if (String(v) === ep) pick.push(s)
      }
      return { shots: pick, filtered: true, by: '集数 ' + ep }
    }

    const ch = String(r.chapter || '').trim()
    if (ch) {
      for (let k = 0; k < all.length; k++) {
        if (String((all[k] || {}).chapter) === ch) pick.push(all[k])
      }
      return { shots: pick, filtered: true, by: '章节 ' + ch }
    }

    return { shots: all, filtered: false, by: '全本' }
  }

  /** 由定妆照相对路径推导同目录的多视角转台图；不存在就返回空串。 */
  function turnaroundOf(rel) {
    const m = String(rel || '').match(/^(.*)(\.[A-Za-z0-9]+)$/)
    return m ? (m[1] + '_turnaround' + m[2]) : ''
  }

  /**
   * 把一个镜头引用的角色/场景解析成**有序的参考图绝对路径**。
   *
   * 顺序就是 H3 的契约（官方 MiniMaxH3ReferenceToVideo 定义）：
   *   按 characters 数组顺序，每个角色先给正面定妆照；若该角色有多视角转台图，
   *   紧跟着再给一张；全部角色之后，**场景图永远是最后一张**。
   * 提示词里的 <Picture i> 编号必须与这个顺序一致，否则画面与描述对不上。
   *
   * missing 必须上报而不是静默跳过：少一张图会让后续 <Picture> 编号整体前移，
   * 提示词里按角色顺序写的 subject_definitions 就会系统性错位。
   */
  async function resolveShotRefs(pid, shot, nameOf) {
    const assets = await readJson(pid + '\\assets.json', EMPTY_ASSETS)
    const refs = []
    const missing = []
    // 资产里存的是正斜杠相对路径；统一成反斜杠再拼绝对路径，
    // 免得 abs() 产出混合分隔符（Windows 能容忍，但日志与指纹都会脏）。
    const absRel = (rel) => abs(pid + '\\' + String(rel).replace(/\//g, '\\'))
    // 资产可能以方案 id 登记，也可能是手工导入时另起的 id —— 两边都认。
    // 只按 id 匹配会在"手工导入过定妆照"的项目上静默丢图（实测踩过）。
    const findAsset = (arr, id) => {
      const want = String(id)
      const wantName = nameOf && nameOf[want] ? String(nameOf[want]) : ''
      let byName = null
      for (let k = 0; k < arr.length; k++) {
        const a = arr[k]
        if (!a) continue
        if (String(a.id) === want) return a
        if (wantName && String(a.name) === wantName && a.image) byName = a
      }
      return byName
    }
    const chars = shot.characters || []
    for (let i = 0; i < chars.length; i++) {
      const hit = findAsset(assets.characters || [], chars[i])
      if (!hit || !hit.image) { missing.push(chars[i]); continue }
      refs.push(absRel(hit.image))
      const turn = turnaroundOf(hit.image)
      if (turn && (await exists(pid + '\\' + turn.replace(/\//g, '\\')))) refs.push(absRel(turn))
    }
    if (shot.scene) {
      const hit = findAsset(assets.scenes || [], shot.scene)
      if (hit && hit.image) refs.push(absRel(hit.image))
      else missing.push(shot.scene)
    }
    return { refs: refs, missing: missing }
  }

  /**
   * 渲染前把筛选结果与**解析好的参考图**落到 `_render.json`，render 只渲这个文件。
   *
   * 为什么不直接把 shots.json 交给渲染器：方案里的 characters/scene 只是 id 引用，
   * 渲染器要的是真实图片路径与固定顺序 —— 这一层解析必须发生在渲染前，而且要让
   * "哪一镜其实缺图"变得可见。
   */
  async function prepareRender(job) {
    const out = abs(job.project)
    job.shotsArg = out + '\\shots.json'
    const doc = await readJson(job.project + '\\shots.json', null)
    if (!doc || !doc.shots || !doc.shots.length) return

    const meta = await readJson(job.project + '\\project.json', {})
    const params = Object.assign(defaultParams(), meta.params || {})
    const p = pickShots(doc, job.range)
    if (p.filtered && !p.shots.length) {
      job.renderBlocked = '镜头范围（' + p.by + '）筛出 0 个镜头'
      job.log += '  ' + job.renderBlocked + '，无法渲染。\n'
      return
    }
    if (p.filtered) {
      job.log += '  镜头范围：' + p.by + ' → ' + p.shots.length + '/' + doc.shots.length + ' 镜\n'
    } else {
      job.log += '  镜头范围：全本（' + doc.shots.length + ' 镜）\n'
    }

    const planDoc = await readJson(job.project + '\\plan.json', null)
    const nameOf = {}
    if (planDoc && planDoc.characters) {
      for (let i = 0; i < planDoc.characters.length; i++) {
        const c = planDoc.characters[i]
        if (c && c.id) nameOf[String(c.id)] = c.name || ''
      }
    }
    const shots = []
    let refTotal = 0
    let refImgs = 0
    let refScenes = 0
    let withRef = 0
    const missingAll = []
    for (let i = 0; i < p.shots.length; i++) {
      const s = Object.assign({}, p.shots[i])
      const r = await resolveShotRefs(job.project, s, nameOf)
      delete s.characters
      delete s.scene
      delete s.dialogue
      delete s.shot_size
      delete s.camera
      if (r.refs.length) {
        s.ref_images = r.refs
        s.mode = 'r2v'
        withRef += 1
        refTotal += r.refs.length
        const nChar = (p.shots[i].characters || []).length
        refImgs += Math.min(nChar, r.refs.length)
        if (p.shots[i].scene) refScenes += 1
      } else if (s.first_frame) {
        s.mode = 't2v'          // FL2VA：由 first_frame 触发，走 fl2va 权重
      } else {
        s.mode = 't2v'
      }
      if (r.missing.length) missingAll.push(s.id + ' 缺 ' + r.missing.join('/'))
      shots.push(s)
    }

    const renderDoc = {
      project: doc.project || job.project,
      style: doc.style || params.style || '',
      shots: shots,
      // 顶层 defaults 会被渲染器当作 cfg 覆盖到每个镜头
      defaults: {
        sampler: params.sampler || 'euler',
        shift_video: params.shiftVideo === undefined ? 12.0 : params.shiftVideo,
        shift_audio: params.shiftAudio === undefined ? 3.0 : params.shiftAudio,
        ref_image_size: params.refImageSize || 'match',
        accel: normAccel(params.accel, params.nfe),
        vaeInt8: params.vaeInt8 !== false,
        takes: params.takes === undefined ? 1 : params.takes,
        vramMode: params.vramMode || 'off',
        crf: params.crf === undefined ? 16.0 : params.crf,
        steps: params.steps || 8,
        fps: params.fps || 24,
      },
    }
    await writeText(job.project + '\\_render.json', JSON.stringify(renderDoc, null, 2))
    job.shotsArg = out + '\\_render.json'
    job.log += '  参考图：' + refTotal + ' 张（角色 ' + refImgs + ' + 场景 ' + refScenes
      + '）· 走 Ref2VA ' + withRef + '/' + shots.length + ' 镜'
      + ' · ref_image_size=' + renderDoc.defaults.ref_image_size
      + ' · sampler=' + renderDoc.defaults.sampler
      + ' · shift ' + renderDoc.defaults.shift_video + '/' + renderDoc.defaults.shift_audio + '\n'
    if (missingAll.length) {
      job.log += '  ⚠ 缺参考图的镜头（编号会整体前移，务必先补齐资产）：'
        + missingAll.slice(0, 8).join('；') + (missingAll.length > 8 ? ' …' : '') + '\n'
    }
  }

  /**
   * 执行一个阶段。返回 { code, text, manual, missing }：
   *   code === 0 表示成功，-2 表示被用户停止，其余为失败退出码。
   *   text 只含本阶段新增日志 —— 质检要靠它解析不合格镜头，所以不能混入前序阶段输出。
   */
  /**
   * 给某个镜头换一个 seed 并写回 shots.json，返回新 seed（镜头不在方案里返回 null）。
   *
   * 为什么返修必须换 seed：**同一提示词配同一 seed 重跑大概率复现同样的坏结果**。
   * 只删文件不换种子，等于把同一个坏结果再算一遍，白烧几分钟显卡。
   */
  async function reseedShot(pid, shotId) {
    const doc = await readJson(pid + '\\shots.json', null)
    if (!doc || !doc.shots || !doc.shots.length) return null
    for (let i = 0; i < doc.shots.length; i++) {
      if (String(doc.shots[i].id) === String(shotId)) {
        const seed = 1000 + Math.floor(Math.random() * 999999)
        doc.shots[i].seed = seed
        await writeText(pid + '\\shots.json', JSON.stringify(doc, null, 2))
        return seed
      }
    }
    return null
  }

  async function execStage(job, key) {
    const st = stageOf(job, key)
    if (!st) return { code: 0, text: '' }
    job.log += '\n━━━ 阶段 ' + st.name + ' ━━━\n'
    if (MANUAL[key]) {
      setStage(job, key, 'manual', MANUAL[key])
      job.log += '  (跳过自动化) ' + MANUAL[key] + '\n'
      return { code: 0, text: '', manual: true }
    }

    // 方案：由 llm 服务直出分镜与提示词。一条龙里只补空缺，不覆盖已有成果。
    if (key === 'plan') {
      if (!job.forcePlan) {
        const doc = await readJson(job.project + '\\shots.json', null)
        if (doc && doc.shots && doc.shots.length) {
          const note = '已有 ' + doc.shots.length + ' 镜，未重写'
          setStage(job, key, 'done', note)
          job.log += '  shots.json 已有 ' + doc.shots.length
            + ' 个镜头，跳过方案（单独点「方案」可强制重写）。\n'
          return { code: 0, text: '' }
        }
      }
      setStage(job, key, 'running', '')
      const mark = job.log.length
      try {
        const n = await genPlan(job)
        setStage(job, key, 'done', n + ' 镜')
        return { code: 0, text: job.log.slice(Math.min(mark, job.log.length)) }
      } catch (e) {
        const msg = String((e && e.message) || e)
        setStage(job, key, 'failed', msg.slice(0, 90))
        job.log += '  方案失败：' + msg + '\n'
        return { code: 1, text: job.log.slice(Math.min(mark, job.log.length)) }
      }
    }
    // 质检：走插件自己的机械质检（时长/音轨/分辨率 + 黑屏防线），
    // 结果结构化存在 job.lastQc 里给返修循环用，同时把可读文本写进日志。
    if (key === 'judge') {
      setStage(job, key, 'running', '')
      const mark = job.log.length
      let rep
      try {
        rep = await qcProject(job.project, {
          darkFail: job.qcDarkFail,
          darkWarn: job.qcDarkWarn,
          minDuration: job.qcMinDuration,
          maxDuration: job.qcMaxDuration,
        })
      } catch (e) {
        const msg = String((e && e.message) || e)
        setStage(job, key, 'failed', msg.slice(0, 90))
        job.log += '  质检失败：' + msg + '\n'
        return { code: 1, text: job.log.slice(Math.min(mark, job.log.length)) }
      }
      job.lastQc = rep
      if (!rep.total) {
        setStage(job, key, 'failed', '没有可质检的镜头')
        job.log += '  没有可质检的镜头：请先渲染。\n'
        return { code: 1, text: job.log.slice(Math.min(mark, job.log.length)) }
      }
      for (let i = 0; i < rep.reports.length; i++) {
        const c = rep.reports[i]
        if (c.ok) {
          job.log += '  ✓ ' + c.file + '  ' + c.duration + 's  ' + c.width + 'x' + c.height
            + '  音轨' + (c.hasAudio ? '有' : '无') + '  黑场' + Math.round((c.darkRatio || 0) * 100) + '%\n'
        } else {
          job.log += '  ✕ ' + c.file + '  ' + c.problems.join('；') + '\n'
        }
        for (let k = 0; k < c.warnings.length; k++) {
          job.log += '    ⚠ ' + c.warnings[k] + '\n'
        }
      }
      const note = rep.failed > 0 ? (rep.failed + ' 镜不合格') : (rep.warned > 0 ? '通过（' + rep.warned + ' 镜有警告）' : '全部通过')
      setStage(job, key, rep.failed > 0 ? 'failed' : 'done', note)
      job.log += '  质检：' + rep.total + ' 镜检查完毕，' + note + '（报告 output/qc_report.json）\n'
      return { code: rep.failed > 0 ? 1 : 0, text: job.log.slice(Math.min(mark, job.log.length)) }
    }

    // 合成：走插件自己的 composeFinal（禁流复制 + 响度归一 + faststart），
    // 而不是 manju.py 的朴素 concat —— 后者既不归一响度也不加 faststart。
    if (key === 'merge') {
      setStage(job, key, 'running', '')
      const mark = job.log.length
      const meta = await readJson(job.project + '\\project.json', {})
      const pp = Object.assign(defaultParams(), meta.params || {})
      const res = await composeFinal(job.project, {
        transition: pp.transition, loudness: pp.loudness,
        subtitles: pp.subtitles, subtitleSize: pp.subtitleSize, compliance: pp.compliance,
      })
      if (res.ok) {
        job.log += '  成片 ' + res.file + ' · ' + res.clips + ' 镜 · ' + res.duration + 's · '
          + res.width + 'x' + res.height + ' · ' + (Math.round(res.size / 10485.76) / 100) + ' MB'
          + ' · 转场 ' + res.transition + ' · 响度 ' + res.loudness + '\n'
        setStage(job, key, 'done', res.duration + 's')
        return { code: 0, text: job.log.slice(Math.min(mark, job.log.length)) }
      }
      job.log += '  合成失败：' + String(res.error || '') + ' ' + String(res.text || '') + '\n'
      setStage(job, key, 'failed', String(res.error || '合成失败').slice(0, 90))
      return { code: 1, text: job.log.slice(Math.min(mark, job.log.length)) }
    }

    // 资产定妆：由本地 Krea-2 生成方案引用的角色定妆照与场景图。
    // 没有这一步，Ref2VA 的 <Picture i> 就是空指 —— 所以它必须是真的。
    if (key === 'asset') {
      setStage(job, key, 'running', '')
      const mark = job.log.length
      let res
      try {
        res = await genAssets(job, job.assetOnly || null)
      } catch (e) {
        const msg = String((e && e.message) || e)
        setStage(job, key, 'failed', msg.slice(0, 90))
        job.log += '  资产定妆失败：' + msg + '\n'
        return { code: 1, text: job.log.slice(Math.min(mark, job.log.length)) }
      }
      const text = job.log.slice(Math.min(mark, job.log.length))
      if (!res.ok && res.total === undefined) {
        setStage(job, key, 'failed', String(res.error || '').slice(0, 90))
        job.log += '  资产定妆失败：' + res.error + '\n'
        return { code: 1, text: text }
      }
      if (res.failed && res.failed.length) {
        setStage(job, key, 'failed', res.made + ' 张成功 / ' + res.failed.length + ' 张失败')
        job.log += '  ⚠ ' + res.failed.length + ' 张没生成出来；这几镜将没有参考图（锁脸失效）。\n'
        return { code: 1, text: text }
      }
      setStage(job, key, 'done', res.made ? ('生成 ' + res.made + ' 张') : '资产已齐')
      return { code: 0, text: text }
    }

    const def = stageCmds(job)[key]
    if (!def) {
      setStage(job, key, 'manual', '未定义')
      return { code: 0, text: '', manual: true }
    }
    if (def.need && !(await exists(job.project + '\\' + def.need))) {
      const why = '缺少 ' + def.need + '（需先完成方案阶段）'
      setStage(job, key, 'manual', why)
      job.log += '  (跳过) ' + why + '\n'
      return { code: 1, text: '', missing: true }
    }
    setStage(job, key, 'running', '')
    const mark = job.log.length
    const code = await runStreaming(job, def.argv, def.cwd)
    // 日志会被 runStreaming 截断，mark 可能落在截断点之前 —— 取不到就退化为全量
    const text = job.log.slice(Math.min(mark, job.log.length))
    if (code === -2) {
      setStage(job, key, 'failed', '已停止')
      return { code: -2, text: text }
    }
    setStage(job, key, code === 0 ? 'done' : 'failed', code === 0 ? '' : '退出码 ' + code)
    return { code: code === null ? -1 : code, text: text }
  }

  async function runPipeline(job) {
    const stop = (code, note) => {
      job.log += '\n' + note + '\n'
      job.running = false
      job.exitCode = code
    }

    // 一次性把项目参数读进来挂在 job 上 —— 质检阈值这些以前只在手动调 qc 时才生效，
    // 走管线时根本传不进去（等于摆设）。现在统一从这里取。
    const metaJ = await readJson(job.project + '\\project.json', {})
    const pj = Object.assign(defaultParams(), metaJ.params || {})
    job.qcDarkFail = pj.darkFail
    job.qcDarkWarn = pj.darkWarn
    job.qcMinDuration = pj.minDuration
    job.qcMaxDuration = pj.maxDuration

    // ── 单阶段执行：执行管线里的六个按钮 + 项目体检 ──
    if (job.only && job.only.length) {
      if (job.only.indexOf('render') >= 0) {
        // 单阶段点「渲染」也要预检与确保在线：宁可多花几秒，也不要跑到一半才炸
        const meta1 = await readJson(job.project + '\\project.json', {})
        const pp1 = Object.assign(defaultParams(), meta1.params || {})
        const cst = await ensureComfy(job, pp1)
        if (!cst.ok) return stop(1, '(' + (cst.error || 'ComfyUI 不可用') + ')')
        const pf = await preflight(job)
        if (!pf.ok) {
          setStage(job, 'render', 'failed', pf.missing.length ? ('缺节点 ' + pf.missing.join(', ')) : '预检未通过')
          return stop(1, '(节点预检未通过' + (pf.missing.length ? '：缺 ' + pf.missing.join(', ') : '') + ')')
        }
        await prepareRender(job)
        if (job.renderBlocked) return stop(1, '(' + job.renderBlocked + ')')
      }
      for (let i = 0; i < job.only.length; i++) {
        const r = await execStage(job, job.only[i])
        if (r.code === -2) return stop(-2, '(已停止)')
        if (r.code !== 0) return stop(r.code, '(阶段失败，中止)')
      }
      job.log += '\n=== 阶段执行完成 ===\n'
      job.running = false
      job.exitCode = 0
      return
    }

    // ── 一条龙 / AI 一条龙 ──
    for (let i = 0; i < job.stages.length; i++) {
      const st = job.stages[i]
      if (!MANUAL[st.key]) continue
      job.log += '\n━━━ 阶段 ' + st.name + ' ━━━\n  (跳过自动化) ' + MANUAL[st.key] + '\n'
      setStage(job, st.key, 'manual', MANUAL[st.key])
    }

    const ai = job.mode === 'ai'
    const maxRetries = ai ? Math.max(0, Math.min(4, job.aiRetries)) : 0

    const e = await execStage(job, 'env')
    if (e.code === -2) return stop(-2, '(已停止)')
    if (e.code !== 0) {
      // 环境体检最常见的失败就是 ComfyUI 没起来 —— 先按设置尝试拉起再判死
      const meta0 = await readJson(job.project + '\\project.json', {})
      const pp0 = Object.assign(defaultParams(), meta0.params || {})
      job.log += '  环境体检未通过，尝试确保 ComfyUI 在线…\n'
      const st = await ensureComfy(job, pp0)
      if (!st.ok) return stop(e.code, '(环境体检未通过' + (st.error ? '：' + st.error : '') + ')')
      const e2 = await execStage(job, 'env')
      if (e2.code === -2) return stop(-2, '(已停止)')
      if (e2.code !== 0) return stop(e2.code, '(环境体检仍未通过，管线中止)')
    }

    // 渲染前节点预检：缺 H3 根节点就当场拦住，不要跑到一半才炸 node_errors
    if (job.only === null || job.only === undefined) {
      const pf = await preflight(job)
      if (!pf.ok) {
        setStage(job, 'render', 'failed', pf.missing.length ? ('缺节点 ' + pf.missing.join(', ')) : '预检未通过')
        return stop(1, '(节点预检未通过' + (pf.missing.length ? '：缺 ' + pf.missing.join(', ') : '') + '，请先在 ComfyUI 装齐 H3 节点)')
      }
    }

    const pl = await execStage(job, 'plan')
    if (pl.code === -2) return stop(-2, '(已停止)')
    if (pl.code !== 0) return stop(pl.code, '(方案阶段失败，管线中止)')

    // 资产定妆：AI 一条龙的关键一环 —— 没有参考图，Ref2VA 的锁脸就是空话
    const as = await execStage(job, 'asset')
    if (as.code === -2) return stop(-2, '(已停止)')
    if (as.code !== 0) {
      if (ai) {
        job.log += '  ⚠ 资产未补齐。可选：修好图像模型后重跑「资产」，或先在「角色管理」手工导入定妆照。\n'
        job.log += '    继续渲染：这些角色不会有参考图（<Picture i> 编号会随实际图数变化）。\n'
      } else {
        return stop(as.code, '(资产定妆未完成，管线中止)')
      }
    }

    await prepareRender(job)
    if (job.renderBlocked) return stop(1, '(' + job.renderBlocked + ')')

    let attempt = 0
    for (;;) {
      const rr = await execStage(job, 'render')
      if (rr.code === -2) return stop(-2, '(已停止)')
      if (rr.missing) return stop(1, '(缺少 shots.json：需先完成方案阶段)')
      if (rr.code !== 0 && !ai) return stop(rr.code, '(渲染失败，管线中止)')

      const jr = await execStage(job, 'judge')
      if (jr.code === -2) return stop(-2, '(已停止)')
      if (jr.code === 0) {
        job.log += '  质检通过。\n'
        break
      }

      // 结构化的不合格清单（比解析日志文本可靠）
      const all = (job.lastQc && job.lastQc.reports) || []
      const bad = []
      for (let i = 0; i < all.length; i++) if (!all[i].ok) bad.push(all[i])

      if (attempt >= maxRetries) {
        job.log += ai
          ? '  仍有 ' + bad.length + ' 个镜头不合格，返修次数已用尽（上限 ' + maxRetries + '）。\n'
          : '  质检未通过。一条龙不做自动返修，可改用「AI 一条龙」。\n'
        break
      }
      if (!bad.length) {
        job.log += '  质检未通过，但未能定位到具体镜头，返修中止。\n'
        break
      }

      attempt += 1
      job.log += '\n—— 自动返修 第 ' + attempt + '/' + maxRetries + ' 轮：重渲 ' + bad.length + ' 个不合格镜头 ——\n'
      // 关键：**同一提示词配同一 seed 重跑大概率复现同样结果**（ManJuX 实测定调）。
      // 机械类不合格（无音轨/黑屏）往往与当次采样有关，所以返修必须同时换 seed，
      // 否则只是把同一个坏结果再算一遍、白烧几分钟显卡。
      for (let i = 0; i < bad.length; i++) {
        const shotId = String(bad[i].file).replace(/\.mp4$/i, '')
        job.log += '  删除 ' + bad[i].file + '（' + bad[i].problems.join('；') + '）'
        try {
          await runCmd(['cmd.exe', '/c', 'del', '/f', '/q', abs(job.project + '\\' + bad[i].file)], SPAWN_BASE)
        } catch (err) { /* 文件可能已不在 */ }
        const newSeed = await reseedShot(job.project, shotId)
        job.log += newSeed === null ? '；未能换 seed（shot 不在方案里）\n' : '；新 seed ' + newSeed + '\n'
      }
      // **必须重算渲染输入**：reseedShot 改的是 shots.json，而 render 读的是 _render.json。
      // 不重新解析的话，换掉的 seed 根本传不到渲染器 —— 返修等于白做（实测踩过）。
      await prepareRender(job)
      if (job.renderBlocked) return stop(1, '(' + job.renderBlocked + ')')
      // render 跳过已存在的 mp4，所以删掉坏镜头后再跑 render 就只重渲这几个
      setStage(job, 'render', 'pending', '等待返修重渲')
      setStage(job, 'judge', 'pending', '等待复检')
    }

    const m = await execStage(job, 'merge')
    if (m.code === -2) return stop(-2, '(已停止)')
    if (m.code !== 0) return stop(m.code, '(合成失败)')

    job.log += '\n=== 管线完成 ===\n'
    job.running = false
    job.exitCode = 0
  }

  // ═══════════ 管线精髓：质检 / 合成 / 预检 / 串行化 ═══════════
  /** 解析外部可执行文件的真实路径；解析不到就退回裸名交给 PATH。 */
  const exeCache = Object.create(null)
  async function exePath(name) {
    if (exeCache[name]) return exeCache[name]
    let p = name
    try {
      if (subprocess && typeof subprocess.resolveExecutable === 'function') {
        const r = await subprocess.resolveExecutable(name)
        if (r) p = r
      }
    } catch (e) { /* 退回裸名 */ }
    exeCache[name] = p
    return p
  }
  /** ffprobe 单文件元数据。拿不到就返回 null —— 调用方必须当作"不可探测"处理。 */
  async function ffprobeOne(file) {
    const r = await runCmd([
      await exePath('ffprobe'), '-v', 'error', '-print_format', 'json',
      '-show_format', '-show_streams', file,
    ], SPAWN_BASE)
    if (r.exitCode !== 0) return null
    let j = null
    try { j = JSON.parse(String(r.text || '').trim()) } catch (e) { return null }
    if (!j || !j.format) return null
    const streams = j.streams || []
    let v = null
    let a = null
    for (let i = 0; i < streams.length; i++) {
      if (!v && streams[i].codec_type === 'video') v = streams[i]
      if (!a && streams[i].codec_type === 'audio') a = streams[i]
    }
    return {
      duration: parseFloat(j.format.duration) || 0,
      size: parseInt(j.format.size, 10) || 0,
      bitrate: parseInt(j.format.bit_rate, 10) || 0,
      width: v ? (parseInt(v.width, 10) || 0) : 0,
      height: v ? (parseInt(v.height, 10) || 0) : 0,
      fps: v && v.r_frame_rate ? v.r_frame_rate : '',
      vcodec: v ? v.codec_name : '',
      hasAudio: !!a,
      acodec: a ? a.codec_name : '',
      achannels: a ? (parseInt(a.channels, 10) || 0) : 0,
      asample: a ? (parseInt(a.sample_rate, 10) || 0) : 0,
    }
  }
  /**
   * 黑屏防线。用 ffmpeg 自带的 blackdetect：≥50% 像素为暗、持续 ≥0.2s 的片段才算黑场。
   * 这是**质检侧**的黑屏防线；提示词侧的对应物是每镜末尾那句亮度护栏，两道都要有。
   */
  async function blackDetect(file) {
    const r = await runCmd([
      await exePath('ffmpeg'), '-hide_banner', '-nostats', '-i', file,
      '-vf', 'blackdetect=d=0.2:pix_th=0.50', '-an', '-f', 'null', '-',
    ], SPAWN_BASE)
    const text = String(r.text || '')
    let total = 0
    const re = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g
    let m = re.exec(text)
    while (m !== null) {
      total += parseFloat(m[3]) || 0
      m = re.exec(text)
    }
    return Math.round(total * 100) / 100
  }
  /**
   * 单镜机械质检。
   * 只做机械指标（时长/音轨/分辨率/黑场），不做内容理解 —— 内容级审片属于 VLM 的活。
   * 阈值口径与 ManJuX 一致：无音轨/时长过短/非 32 倍数是硬问题，偏长/偏暗是警告。
   */
  /**
   * 测音频峰值（dBFS）。ffprobe 不给这个，得用 ffmpeg 的 volumedetect 过一遍。
   *
   * 为什么必须查：加速 LoRA 会改变音频那条时间线 —— 实测 Turbo 4 步的峰值贴到
   * -0.1~-0.5 dBFS（比原版热约 10 dB），**削波是永久损失，后期 loudnorm 救不回来**
   * （它只能整体压电平，被削平的波形回不去）。所以要在单镜阶段就报出来。
   */
  async function peakDbOf(file) {
    const FF = await exePath('ffmpeg')
    const r = await runCmd([FF, '-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], ROOT)
    const m = String(r.text || '').match(/max_volume:\s*(-?[\d.]+)\s*dB/)
    return m ? parseFloat(m[1]) : null
  }

  async function qcOneClip(pid, rel, opts) {
    const o = opts || {}
    const file = abs(pid + '\\' + rel)
    const rec = { file: rel, ok: false, problems: [], warnings: [] }
    const info = await ffprobeOne(file)
    if (!info) {
      rec.problems.push('无法探测（文件损坏或不是视频）')
      return rec
    }
    rec.duration = Math.round(info.duration * 100) / 100
    rec.width = info.width
    rec.height = info.height
    rec.hasAudio = info.hasAudio
    rec.achannels = info.achannels
    rec.asample = info.asample
    if (!info.hasAudio) rec.problems.push('无音轨（H3 产物应自带 32kHz 立体声）')
    if (info.hasAudio) {
      const peak = await peakDbOf(file)
      if (peak !== null) {
        rec.peakDb = Math.round(peak * 10) / 10
        const clipFail = o.clipFail === undefined ? -0.1 : Number(o.clipFail)
        const clipWarn = o.clipWarn === undefined ? -1.0 : Number(o.clipWarn)
        if (peak >= clipFail) {
          rec.problems.push('音频已经削波（峰值 ' + rec.peakDb + ' dBFS）—— 不可逆，建议重渲或改用非涡轮机制')
        } else if (peak >= clipWarn) {
          rec.warnings.push('音频峰值贴顶 ' + rec.peakDb + ' dBFS（加速路径常见，留意是否发闷）')
        }
      }
    }
    if (info.duration < (o.minDuration === undefined ? 1.0 : o.minDuration)) {
      rec.problems.push('时长过短 ' + rec.duration + 's（应 ≥' + (o.minDuration === undefined ? 1.0 : o.minDuration) + 's）')
    }
    if (info.duration > (o.maxDuration === undefined ? 20 : o.maxDuration)) {
      rec.warnings.push('时长偏长 ' + rec.duration + 's')
    }
    if ((info.width % 32) || (info.height % 32)) {
      rec.problems.push('分辨率非 32 倍数 ' + info.width + 'x' + info.height)
    }
    const black = await blackDetect(file)
    const ratio = info.duration > 0 ? black / info.duration : 0
    rec.blackSeconds = black
    rec.darkRatio = Math.round(ratio * 1000) / 1000
    const fail = o.darkFail === undefined ? 0.5 : o.darkFail
    const warn = o.darkWarn === undefined ? 0.15 : o.darkWarn
    if (ratio >= fail) {
      rec.problems.push('疑似黑屏：黑场 ' + black + 's（占 ' + Math.round(ratio * 100) + '%）')
    } else if (ratio >= warn) {
      rec.warnings.push('画面偏暗：黑场 ' + black + 's（占 ' + Math.round(ratio * 100) + '%）')
    }
    rec.ok = rec.problems.length === 0
    return rec
  }
  /** 项目级质检：逐镜跑 qcOneClip，报告写进 output/qc_report.json。 */
  async function qcProject(pid, opts) {
    const clips = clipsOf(await listDir(pid))
    const names = []
    // 抽卡备选（<sid>_take<k>）不参与合成与质检 —— 否则成片里会出现
    // 同一镜的好几个版本，质检也会为备选白跑 N 倍
    for (let i = 0; i < clips.length; i++) if (!clips[i].final && !clips[i].take) names.push(clips[i].name)
    names.sort()
    const reports = []
    for (let i = 0; i < names.length; i++) reports.push(await qcOneClip(pid, names[i], opts))
    let failed = 0
    let warned = 0
    for (let i = 0; i < reports.length; i++) {
      if (!reports[i].ok) failed += 1
      else if (reports[i].warnings.length) warned += 1
    }
    const summary = {
      project: pid,
      checkedAt: new Date().toISOString(),
      total: reports.length,
      failed: failed,
      warned: warned,
      reports: reports,
    }
    if (opts && opts.save !== false) {
      try { await writeText(pid + '\\output\\qc_report.json', JSON.stringify(summary, null, 2)) } catch (e) { /* 写不进不阻断 */ }
    }
    return summary
  }
  // ── 字幕：按画布宽度自动折行，绝不让一行顶出画面 ──

  /** 一行的"视觉宽度"：全角算 1，半角算 0.5（中英混排才排得准）。 */
  function visualWidth(s) {
    let w = 0
    const str = String(s || '')
    for (let i = 0; i < str.length; i++) w += str.charCodeAt(i) < 0x2e80 ? 0.5 : 1
    return w
  }

  /**
   * 按视觉宽度折行，优先在标点处断。
   * ASS 的 WrapStyle=2 会关掉 libass 的自动折行 —— 折行位置必须我们自己算，
   * 否则它会把最后一个字单独挤到第二行（"显示不全/断得难看"的典型成因）。
   */
  function wrapAssText(text, maxUnits) {
    const s = String(text || '').replace(/\s+/g, ' ').trim()
    if (!s) return ''
    if (visualWidth(s) <= maxUnits) return s
    const lines = []
    let cur = ''
    let curW = 0
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      const w = ch.charCodeAt(0) < 0x2e80 ? 0.5 : 1
      cur += ch
      curW += w
      const brk = /[，。！？、；：…,\.!\?;:]/.test(ch)
      const over = curW >= maxUnits
      // 到硬上限就断；遇到标点且已过 72% 也可以提前断，读起来更自然
      if (over || (brk && curW >= maxUnits * 0.72)) {
        lines.push(cur)
        cur = ''
        curW = 0
      }
    }
    if (cur) lines.push(cur)
    // 最多三行：再多就占满画面了。把尾巴并进第三行。
    if (lines.length > 3) {
      const head = lines.slice(0, 2)
      head.push(lines.slice(2).join(''))
      return head.join('\\N')
    }
    return lines.join('\\N')
  }

  function assTime(sec) {
    const s = Math.max(0, Number(sec) || 0)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = Math.floor(s % 60)
    const cs = Math.min(99, Math.round((s - Math.floor(s)) * 100))
    const p2 = (n) => (n < 10 ? '0' + n : '' + n)
    return h + ':' + p2(m) + ':' + p2(ss) + '.' + p2(cs)
  }

  /**
   * 平台合规标注。
   *
   * 红果对 AI 剧集**强制**画面常驻标注，并要求预留右侧 5% / 底部 8% 构图边距。
   * 注意：**边距必须在生成期就预留**（提示词层的构图约束），合成期只能把标注"放进"
   * 那块已经留出来的区域 —— 只贴遮罩的话要么裁掉画面、要么盖住主体。
   * 这里负责合成期的两件事：把标注烧进去、把字幕顶到预留区之上。
   */
  const COMPLIANCE = {
    hongguo: {
      name: '红果',
      bottom: '片段存在危险动作，禁止现实模仿',
      side: '故事为AI架空世界 所有角色均是虚拟异能成年人',
      // 生成期要写进提示词的构图约束（由 planSystem 使用）
      prompt: 'IMPORTANT COMPOSITION SAFETY: keep every important subject (faces, hands, key props) '
        + 'inside the central safe area — leave the outer 5% of the right edge and the bottom 8% of '
        + 'the frame free of critical content, because platform overlays occupy those zones. '
        + 'Compose accordingly; do not place faces or story-critical action there.',
    },
  }

  /**
   * 生成 ASS 字幕。时间轴按各镜真实时长累加（cut 为直接相加；叠化由调用方给压缩后的起点）。
   * 一镜多句台词时按句子数均分该镜时长，避免两句重叠在同一时间。
   * 旁白用独立样式（斜体 + 暖色），与画面对白区分开。
   */
  function buildAss(shots, starts, opts) {
    const o = opts || {}
    const W = o.width || 1344
    const H = o.height || 768
    const comp = o.compliance && COMPLIANCE[o.compliance] ? COMPLIANCE[o.compliance] : null
    // 有合规标注时，字幕必须顶到"底部 8% 预留区"之上，否则会和平台标注叠在一起
    const marginV = Math.round(H * (comp ? 0.12 : (o.marginVPct === undefined ? 0.06 : o.marginVPct)))
    const size = Math.max(18, Math.round(H * (o.sizePct === undefined ? 5 : o.sizePct) / 100))
    const marginLR = Math.round(W * 0.07)
    // 一行最多放几个全角单位：可用宽度 / 字号，留 4% 安全余量
    const maxUnits = Math.max(6, Math.floor(((W - marginLR * 2) / size) * 0.96))
    const outline = Math.max(2, Math.round(size * 0.09))
    const shadow = Math.max(1, Math.round(size * 0.05))

    const style = (name, color, italic) =>
      'Style: ' + name + ',Microsoft YaHei,' + size + ',' + color + ',&H000000FF,&H00000000,&H96000000,'
      + '0,' + (italic ? '1' : '0') + ',0,0,100,100,0,0,1,' + outline + ',' + shadow + ',2,'
      + marginLR + ',' + marginLR + ',' + marginV + ',134'

    const lines = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: ' + W,
      'PlayResY: ' + H,
      'WrapStyle: 2',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      style('对白', '&H00FFFFFF', false),
      style('旁白', '&H00D8E8F5', true),
    ]
    if (comp) {
      // 合规标注样式：小一号、半透明，不抢画面注意力但要常驻
      const csize = Math.max(14, Math.round(size * 0.62))
      lines.push('Style: 合规,Microsoft YaHei,' + csize + ',&H55FFFFFF,&H000000FF,&H00000000,&H00000000,'
        + '0,0,0,0,100,100,0,0,1,' + Math.max(1, Math.round(csize * 0.12)) + ',0,2,'
        + Math.round(W * 0.05) + ',' + Math.round(W * 0.05) + ',' + Math.round(H * 0.015) + ',134')
    }
    lines.push(
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')

    if (comp) {
      // 两条覆盖全片的常驻标注：底部一行 + 右侧竖排（libass 没有 CJK 竖排，
      // 通行做法是旋转 270°，字符会侧躺 —— 这是该方案已知的取舍，不是 bug）
      const end = '9:59:59.99'
      lines.push('Dialogue: 0,0:00:00.00,' + end + ',合规,,0,0,0,,'
        + (comp.bottom || ''))
      if (comp.side) {
        const rx = W - Math.round(W * 0.025)
        const ry = Math.round(H * 0.5)
        lines.push('Dialogue: 0,0:00:00.00,' + end + ',合规,,0,0,0,,'
          + '{\\an5\\pos(' + rx + ',' + ry + ')\\frz270}' + comp.side)
      }
    }

    let n = 0
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i] || {}
      const dlg = s.dialogue || []
      if (!dlg.length) continue
      const start = starts[i] || 0
      const dur = (s._dur || 0)
      if (dur <= 0.05) continue
      const each = dur / dlg.length
      for (let k = 0; k < dlg.length; k++) {
        const d = dlg[k] || {}
        const txt = String(d.text || '').trim()
        if (!txt) continue
        const isNarr = /旁白|narrator|voiceover/i.test(String(d.speaker || ''))
        // 留 0.06s 空隙，避免相邻字幕首尾相接显得粘连
        const t0 = start + each * k
        const t1 = start + each * (k + 1) - 0.06
        if (t1 - t0 < 0.2) continue
        lines.push('Dialogue: 0,' + assTime(t0) + ',' + assTime(t1) + ','
          + (isNarr ? '旁白' : '对白') + ',' + String(d.speaker || '') + ',0,0,0,,'
          + wrapAssText(txt, maxUnits))
        n += 1
      }
    }
    return { ass: lines.join('\n'), count: n, size: size, maxUnits: maxUnits }
  }

  /**
   * 合成成片。
   *
   * 精髓（与 ManJuX 一致）：
   *   * **禁止流复制** —— 逐段重编码，否则不同来源的片段拼出来会花屏/音画不同步；
   *   * 响度归一 loudnorm(I=-16:TP=-1.5:LRA=11)，否则各镜音量忽大忽小；
   *   * **必须 +faststart** —— 否则微信/播放器起播要等整段下载；
   *   * crf 18 / preset medium：crf 23 会糊，16 又太慢，18 是性价比点；
   *   * 转场只保留 hard cut 与 闪黑叠化（像素溶解已被否决：颗粒噪点观感）；
   *   * 字幕由 plan 的台词生成，按画布宽度自己折行（WrapStyle=2 关掉 libass 自动折行）。
   */
  async function composeFinal(pid, opts) {
    const o = opts || {}
    const clips = clipsOf(await listDir(pid))
    const names = []
    // 抽卡备选（<sid>_take<k>）不参与合成与质检 —— 否则成片里会出现
    // 同一镜的好几个版本，质检也会为备选白跑 N 倍
    for (let i = 0; i < clips.length; i++) if (!clips[i].final && !clips[i].take) names.push(clips[i].name)
    names.sort()
    if (!names.length) return { ok: false, error: '没有可合成的镜头（成片不计入）' }
    const dir = abs(pid)
    const target = abs(pid + '\\成片.mp4')
    const FF = await exePath('ffmpeg')
    const metaC = await readJson(pid + '\\project.json', {})
    const pc = Object.assign(defaultParams(), metaC.params || {})
    const canvasW = Number(pc.width) || 1344
    const canvasH = Number(pc.height) || 768
    const loud = Number.isFinite(Number(o.loudness)) ? Number(o.loudness) : -16
    const af = 'loudnorm=I=' + loud + ':TP=-1.5:LRA=11'
    const venc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p']
    const aenc = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']
    let transition = String(o.transition || 'cut')
    // 像素溶解观感是颗粒噪点，一律降级为闪黑叠化
    if (transition === 'dissolve') transition = 'fade'
    if (transition !== 'fade') transition = 'cut'

    // ── 字幕：先量出每镜真实时长与起点，再生成 .ass ──
    const dur = []
    for (let i = 0; i < names.length; i++) {
      const info = await ffprobeOne(dir + '\\' + names[i])
      dur.push(info && info.duration > 0 ? info.duration : 5)
    }
    const F = 0.5
    const starts = []
    let acc = 0
    for (let i = 0; i < names.length; i++) {
      starts.push(acc)
      acc = acc + dur[i] - (transition === 'fade' && i < names.length - 1 ? F : 0)
    }
    const planDoc = await readJson(pid + '\\plan.json', null)
    const planShots = (planDoc && planDoc.shots) || (await readJson(pid + '\\shots.json', { shots: [] })).shots || []
    // 镜头产物名 s01.mp4 ↔ 方案 id s01，顺序一致（都按文件名排序）
    const boardShots = names.map((nm, i) => {
      const sid = nm.replace(/\.mp4$/i, '')
      let hit = null
      for (let k = 0; k < planShots.length; k++) {
        if (String(planShots[k] && planShots[k].id) === sid) { hit = planShots[k]; break }
      }
      return Object.assign({}, hit || {}, { id: sid, _dur: dur[i] })
    })
    let subtitleCount = 0
    let subtitleInfo = ''
    const wantSubs = o.subtitles !== false
    if (wantSubs) {
      const built = buildAss(boardShots, starts, {
        width: canvasW,
        height: canvasH,
        sizePct: o.subtitleSize,
        compliance: o.compliance,
      })
      subtitleCount = built.count
      subtitleInfo = '字号 ' + built.size + 'px / 每行最多 ' + built.maxUnits + ' 个全角字'
      await writeText(pid + '\\output\\final.ass', built.ass)
    }
    // 字幕滤镜：cwd 是项目根，.ass 落在 output/ 下，所以引用要带上相对目录。
    // 用**相对路径**是有意的 —— libass 不认带引号的 Windows 盘符绝对路径。
    const subFilter = (wantSubs && subtitleCount > 0) ? 'subtitles=filename=output/final.ass' : ''

    let r
    if (transition === 'cut' || names.length === 1) {
      let body = ''
      for (let i = 0; i < names.length; i++) {
        body += "file '" + (dir + '\\' + names[i]).replace(/\\/g, '/') + "'\n"
      }
      await writeText(pid + '\\_concat.txt', body)
      const cmd = [FF, '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0', '-i', dir + '\\_concat.txt']
      if (subFilter) cmd.push('-vf', subFilter)
      r = await runCmd(cmd.concat(venc, ['-af', af], aenc, ['-movflags', '+faststart', target]), dir)
      if (r.exitCode !== 0) {
        return { ok: false, exitCode: r.exitCode, error: '合成失败', text: String(r.text).slice(-2000) }
      }
    } else {
      const parts = []
      const args = [FF, '-y', '-hide_banner', '-loglevel', 'error']
      for (let i = 0; i < names.length; i++) {
        args.push('-i', dir + '\\' + names[i])
      }
      let vLabel = '0:v'
      let aLabel = '0:a'
      let acc2 = dur[0]
      for (let i = 1; i < names.length; i++) {
        const off = Math.max(0, acc2 - F)
        parts.push('[' + vLabel + '][' + i + ':v]xfade=transition=fade:duration=' + F + ':offset=' + off.toFixed(3) + '[v' + i + ']')
        parts.push('[' + aLabel + '][' + i + ':a]acrossfade=d=' + F + '[a' + i + ']')
        vLabel = 'v' + i
        aLabel = 'a' + i
        acc2 = acc2 + dur[i] - F
      }
      // 字幕接在 xfade 链的末尾，再输出
      if (subFilter) {
        parts.push('[' + vLabel + ']' + subFilter + '[vsub]')
        vLabel = 'vsub'
      }
      args.push('-filter_complex', parts.join(';'))
      args.push('-map', '[' + vLabel + ']', '-map', '[' + aLabel + ']')
      args.push('-af', af)
      args.push.apply(args, venc)
      args.push.apply(args, aenc)
      args.push('-movflags', '+faststart', target)
      r = await runCmd(args, dir)
      if (r.exitCode !== 0) {
        return { ok: false, exitCode: r.exitCode, error: '叠化合成失败', text: String(r.text).slice(-2000) }
      }
    }
    const info = await ffprobeOne(target)
    return {
      ok: true,
      file: '成片.mp4',
      clips: names.length,
      transition: transition,
      loudness: loud,
      duration: info ? Math.round(info.duration * 100) / 100 : 0,
      width: info ? info.width : 0,
      height: info ? info.height : 0,
      size: info ? info.size : 0,
      text: String(r.text || '').slice(-800),
    }
  }
  /**
   * 渲染前节点预检。
   * 缺 H3 根节点就直接阻止，而不是跑到一半炸 node_errors —— 那会白等几分钟。
   */
  async function preflight(job) {
    const r = await runCmd(manjuArgv(['check']), SPAWN_BASE)
    const text = String(r.text || '')
    // **退出码才是判据**。check 成功时输出并不逐个列举节点名，
    // 拿"名字没出现"当缺节点会把全部 19 个节点都报成缺失（实测踩过）。
    const okEnv = r.exitCode === 0
    const missing = []
    if (!okEnv) {
      // 只在失败时去文本里找它点名的节点：要求节点名附近有"缺失"类字眼
      for (let i = 0; i < REQUIRED_NODES.length; i++) {
        const n = REQUIRED_NODES[i]
        const idx = text.indexOf(n)
        if (idx < 0) continue
        const around = text.slice(Math.max(0, idx - 48), idx + 48)
        if (/缺|missing|未注册|未安装|not\s+found/i.test(around)) missing.push(n)
      }
    }
    if (job) {
      job.log += '  节点预检：' + (okEnv ? '通过' : '未通过')
        + (missing.length ? '（缺 ' + missing.join(', ') + '）' : '') + '\n'
      if (!okEnv) {
        const tail = text.split(/\r?\n/).filter((L) => L.trim()).slice(-6)
        if (tail.length) job.log += '    ' + tail.join('\n    ') + '\n'
      }
    }
    return { ok: okEnv, missing: missing, exitCode: r.exitCode, text: text.slice(-2000) }
  }

  // ═══════════ ComfyUI 启动管理 ═══════════
  //
  // 为什么不让插件直接跑 start-comfyui.cmd：那个脚本末尾有 pause，程序代管时会
  // 卡在一个等按键的进程上；而且它不带资源治理参数。这里直接拉起 python，并补上
  //   --cache-none            不缓存节点产物（否则跑几轮磁盘就被中间张量堆满）
  //   --disable-smart-memory  用不到就卸载，别跟别的程序抢显存
  //   --vram-headroom 1.5     连别的程序占掉的显存也算进余量
  const COMFY_DIR = 'D:\\Ai\\ComfyUI\\ComfyUI'
  const COMFY_PY = 'D:\\Ai\\ComfyUI\\standalone-env\\python.exe'
  const COMFY_FLAGS = ['--cache-none', '--disable-smart-memory', '--vram-headroom', '1.5']
  let comfyPid = null        // 我们代管时记下的 PID
  let comfyStartedAt = 0
  let comfyHandle = null
  let comfyLastLog = ''      // 启动过程的标准输出尾巴，失败时要给用户看
  function comfyUrlOf(p) {
    return String((p && p.comfyUrl) || 'http://127.0.0.1:8199').replace(/\/+$/, '')
  }
  function comfyPortOf(url) {
    const m = String(url || '').match(/:(\d+)/)
    return m ? m[1] : '8199'
  }
  /** 问一次 /system_stats。超时必须短 —— 它被轮询调用，不能把界面拖住。 */
  async function comfyAlive(url, timeoutMs) {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeoutMs || 1500)
      const res = await fetch(comfyUrlOf({ comfyUrl: url }) + '/system_stats', { signal: ctl.signal })
      clearTimeout(timer)
      return !!res.ok
    } catch (e) { return false }
  }
  /** 谁在监听这个端口。用 netstat 而不是 PowerShell，避免再套一层进程。 */
  async function procsOnPort(port) {
    const r = await runCmd(['cmd.exe', '/c', 'netstat -ano | findstr LISTENING | findstr :' + port], SPAWN_BASE)
    const out = []
    const lines = String(r.text || '').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/)
      if (m && m[1] === port && out.indexOf(m[2]) < 0) out.push(m[2])
    }
    return out
  }
  async function comfyVram() {
    try {
      const r = await runCmd([
        'nvidia-smi', '--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits',
      ], SPAWN_BASE)
      const line = String(r.text || '').trim().split(/\r?\n/)[0]
      if (!line) return null
      const p = line.split(',').map((x) => parseFloat(x))
      if (!isFinite(p[0]) || !isFinite(p[1])) return null
      return { usedMB: p[0], totalMB: p[1], freeMB: p[1] - p[0] }
    } catch (e) { return null }
  }
  /** 启动并等到真的可用。返回 waitedSec 让用户知道等了多久。 */
  async function comfyStart(url, opts) {
    const o = opts || {}
    const port = comfyPortOf(url)
    if (await comfyAlive(url)) return { ok: true, already: true, port: port, waitedSec: 0 }
    // 端口被野进程占着但又不响应 —— 先清掉，否则新进程起不来
    const stale = await procsOnPort(port)
    for (let i = 0; i < stale.length; i++) {
      try { await runCmd(['cmd.exe', '/c', 'taskkill /PID ' + stale[i] + ' /T /F'], SPAWN_BASE) } catch (e) { /* 忽略 */ }
    }
    comfyLastLog = ''
    try {
      // **直接拉起 python，不过 cmd.exe**。subprocess 的 spawn 支持 env，
      // 所以 UTF-8 用环境变量给，不必拼一条内嵌引号的 shell 命令 ——
      // 那样实测会被转义成 \" 导致 cmd 报"不是内部或外部命令"。
      comfyHandle = subprocess.spawn({
        argv: [COMFY_PY, 'main.py', '--port', port, '--listen', '127.0.0.1'].concat(COMFY_FLAGS),
        cwd: COMFY_DIR,
        env: Object.assign({}, process.env, PY_ENV),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 2097152 }, stderr: { maxBytes: 2097152 } },
        graceMs: 10000,
      })
    } catch (e) {
      return { ok: false, error: '拉起 ComfyUI 失败：' + String((e && e.message) || e) }
    }
    comfyStartedAt = Date.now()
    const timeoutMs = (o.timeoutSec || 240) * 1000
    let offOut = 0
    let offErr = 0
    while (Date.now() - comfyStartedAt < timeoutMs) {
      try {
        if (comfyHandle.collected && comfyHandle.collected.stdout) {
          const r = comfyHandle.collected.stdout.readFrom(offOut)
          offOut = r.nextOffset
          if (r.text) comfyLastLog = (comfyLastLog + r.text).slice(-4000)
        }
        if (comfyHandle.collected && comfyHandle.collected.stderr) {
          const r2 = comfyHandle.collected.stderr.readFrom(offErr)
          offErr = r2.nextOffset
          if (r2.text) comfyLastLog = (comfyLastLog + r2.text).slice(-4000)
        }
      } catch (e) { /* 读不到就算了 */ }
      if (await comfyAlive(url, 2500)) {
        const ps = await procsOnPort(port)
        comfyPid = ps.length ? ps[0] : null
        return {
          ok: true, port: port, pid: comfyPid,
          waitedSec: Math.round((Date.now() - comfyStartedAt) / 1000),
          flags: COMFY_FLAGS.join(' '),
        }
      }
      await sleep(2000)
    }
    return {
      ok: false, port: port,
      error: '启动超时（' + ((timeoutMs / 1000) | 0) + ' 秒）',
      tail: comfyLastLog.slice(-1500),
    }
  }
  /** 全进程树杀，并确认端口真的释放了 —— 只发 kill 不确认等于没管。 */
  async function comfyStop(url) {
    const port = comfyPortOf(url)
    const killed = []
    const pids = await procsOnPort(port)
    if (comfyPid && pids.indexOf(comfyPid) < 0) pids.push(comfyPid)
    for (let i = 0; i < pids.length; i++) {
      const r = await runCmd(['cmd.exe', '/c', 'taskkill /PID ' + pids[i] + ' /T /F'], SPAWN_BASE)
      killed.push({ pid: pids[i], ok: r.exitCode === 0, text: String(r.text || '').trim().slice(0, 120) })
    }
    if (comfyHandle) {
      try { comfyHandle.terminate() } catch (e) { /* 已经退了 */ }
      comfyHandle = null
    }
    let waited = 0
    while (waited < 20) {
      if ((await procsOnPort(port)).length === 0) break
      await sleep(1000)
      waited += 1
    }
    const left = await procsOnPort(port)
    const free = left.length === 0
    if (free) { comfyPid = null; comfyStartedAt = 0 }
    return { ok: free, killed: killed, portFree: free, waitedSec: waited, leftPids: left }
  }
  /**
   * 空闲自动退出。
   *
   * 这一项之前只加了参数和界面开关却没实现 —— 属于"假控件"，已补上。
   * 语义：最近一次碰过 ComfyUI 的项目作为当前项目，按它的 idleExitMin 计时；
   * 有任何管线在跑就绝不退；到点先复查一次在线状态再停，避免误杀手工启动的实例。
   */
  let activeProject = ''
  let lastComfyActivity = 0
  function touchComfy(id) {
    if (id) activeProject = String(id)
    lastComfyActivity = Date.now()
  }

  ctx.effect(() => {
    const timer = setInterval(async () => {
      try {
        if (!activeProject || !lastComfyActivity) return
        const keys = Object.keys(jobs)
        for (let i = 0; i < keys.length; i++) if (jobs[keys[i]].running) return
        const meta = await readJson(activeProject + '\\project.json', {})
        const p = Object.assign(defaultParams(), meta.params || {})
        const min = Number(p.idleExitMin) || 0
        if (min <= 0) return
        if (Date.now() - lastComfyActivity < min * 60000) return
        const url = comfyUrlOf(p)
        if (!(await comfyAlive(url, 1500))) { lastComfyActivity = Date.now(); return }
        const st = await comfyStatus(url)
        // 只在"没人在排队"时退；有队列说明还有别的东西在用
        const q = await comfyGet(url, '/queue', 5000)
        if (q && q.ok) {
          try {
            const qj = await q.json()
            if (qj && ((qj.queue_running || []).length || (qj.queue_pending || []).length)) return
          } catch (e) { /* 读不到就当空 */ }
        }
        await comfyStop(url)
        lastComfyActivity = 0
        const lg = ctx.get('logger')
        if (lg && typeof lg.info === 'function') {
          lg.info('manju-studio: ComfyUI 空闲 ' + min + ' 分钟，已自动退出（原 pid ' + JSON.stringify(st.pids) + '）')
        }
      } catch (e) { /* 空闲检查失败不该影响任何东西 */ }
    }, 60000)
    return () => clearInterval(timer)
  })

  async function comfyStatus(url) {
    const port = comfyPortOf(url)
    const up = await comfyAlive(url, 1200)
    const pids = await procsOnPort(port)
    const vram = await comfyVram()
    return {
      url: comfyUrlOf({ comfyUrl: url }),
      port: port,
      up: up,
      pids: pids,
      managed: pids.length > 0 && comfyPid !== null && pids.indexOf(comfyPid) >= 0,
      uptimeSec: comfyStartedAt && pids.length ? Math.round((Date.now() - comfyStartedAt) / 1000) : 0,
      vram: vram,
      lastLog: comfyLastLog.slice(-600),
    }
  }
  /**
   * 渲染前确保 ComfyUI 在线。
   * 关掉自动启动的用户会拿到一条明确的错误而不是"跑到一半炸"。
   */
  async function ensureComfy(job, params) {
    touchComfy(job && job.project)
    const url = comfyUrlOf(params)
    if (await comfyAlive(url)) return { ok: true, already: true }
    if (params.autoStart === false) {
      return { ok: false, error: 'ComfyUI 未运行，且已关闭「自动启动」。请先在「ComfyUI」页启动，或打开自动启动。' }
    }
    const st = await comfyStart(url)
    if (st.ok) {
      job.log += '  ComfyUI 已自动启动并就绪（等了 ' + st.waitedSec + ' 秒'
        + (st.pid ? '，PID ' + st.pid : '') + '）\n'
      job.log += '    启动参数 ' + st.flags + '\n'
    } else {
      job.log += '  ✕ ComfyUI 自动启动失败：' + (st.error || '') + '\n'
      if (st.tail) job.log += '    ' + String(st.tail).split(/\r?\n/).slice(-6).join('\n    ') + '\n'
    }
    return st
  }

  // ═══════════ 资产定妆：Krea-2 自动生成参考图 ═══════════
  //
  // 这一环以前是纯手工，导致 Ref2VA 的六段式提示词里 <Subject 1>/<Picture 1> 全是空指。
  // 现在补上：没有定妆照的角色由本地 Krea-2 生成，生成后回写资产库。
  //
  // **配方是实测出来的，别凭直觉改**（2026-09-21 在本机逐一验证）：
  //   * Krea2 的 latent_format = Wan21，**不是 Flux**；用 ae.safetensors 解码会出
  //     满屏规则网格伪影 —— 必须用 qwen_image_vae.safetensors。
  //   * 文本编码器是 Qwen3-VL-4B 的 12 层抽取，CLIPLoader 类型必须写 `krea2`。
  //   * krea2_turbo 是蒸馏权重（CFG 1.0）+ 8 步，步数给多反而糊。
  // 提示词末尾强制追加身份保真块：Krea-2 有很强的"美人先验"，
  // 不写死"按描述画、不许美化"就会把清瘦长脸画成圆脸大眼。
  function imageRecipe(params) {
    return {
      unet: params.imgUnet || 'krea2_turbo_fp8_scaled.safetensors',
      clip: params.imgClip || 'qwen3vl_4b_fp8_scaled.safetensors',
      clipType: params.imgClipType || 'krea2',
      vae: params.imgVae || 'qwen_image_vae.safetensors',
      steps: params.imgSteps === undefined ? 8 : params.imgSteps,
      cfg: params.imgCfg === undefined ? 1.0 : params.imgCfg,
    }
  }
  /** Krea-2 文生图图。画布按 32 取整，竖幅半身给角色、横幅给场景。 */
  function buildImageGraph(recipe, prompt, width, height, seed) {
    return {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: recipe.unet, weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: recipe.clip, type: recipe.clipType, device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: recipe.vae } },
      '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: prompt } },
      '5': { class_type: 'EmptySD3LatentImage', inputs: { width: width, height: height, batch_size: 1 } },
      '6': { class_type: 'KSampler', inputs: {
        model: ['1', 0], positive: ['4', 0], negative: ['4', 0], latent_image: ['5', 0],
        seed: seed, steps: recipe.steps, cfg: recipe.cfg,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
      } },
      '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
      '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'manju_assets/gen' } },
    }
  }
  async function comfyPost(url, path, payload, timeoutMs) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 60000)
    try {
      const res = await fetch(comfyUrlOf({ comfyUrl: url }) + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      })
      clearTimeout(timer)
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch (e) { json = null }
      return { ok: res.ok, status: res.status, json: json, text: text.slice(0, 1200) }
    } catch (e) {
      clearTimeout(timer)
      return { ok: false, status: 0, error: String((e && e.message) || e) }
    }
  }
  async function comfyGet(url, path, timeoutMs) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 30000)
    try {
      const res = await fetch(comfyUrlOf({ comfyUrl: url }) + path, { signal: ctl.signal })
      clearTimeout(timer)
      return res
    } catch (e) {
      clearTimeout(timer)
      return null
    }
  }
  /** 提交图 → 等完成 → 返回产出文件列表。失败时带上 ComfyUI 给的原始原因。 */
  async function comfyRunGraph(url, graph, timeoutMs, onTick) {
    const sub = await comfyPost(url, '/prompt', { prompt: graph, client_id: 'manju-studio' })
    if (!sub.ok) {
      let why = sub.text || sub.error || ('HTTP ' + sub.status)
      if (sub.json && sub.json.node_errors) why = JSON.stringify(sub.json.node_errors).slice(0, 600)
      if (sub.json && sub.json.error) why = JSON.stringify(sub.json.error).slice(0, 600)
      return { ok: false, error: 'ComfyUI 拒绝该图：' + why }
    }
    const pid = sub.json && sub.json.prompt_id
    if (!pid) return { ok: false, error: 'ComfyUI 未返回 prompt_id' }
    const deadline = Date.now() + (timeoutMs || 600000)
    let lastNote = 0
    while (Date.now() < deadline) {
      await sleep(3000)
      const res = await comfyGet(url, '/history/' + pid, 20000)
      if (!res || !res.ok) continue
      let h = null
      try { h = await res.json() } catch (e) { continue }
      const entry = h && h[pid]
      if (!entry) {
        if (onTick && Date.now() - lastNote > 30000) { lastNote = Date.now(); onTick('等待中…') }
        continue
      }
      const st = entry.status || {}
      if (st.status_str !== 'success' && st.completed !== true) {
        if (st.status_str === 'error') {
          return { ok: false, error: 'ComfyUI 执行报错：' + JSON.stringify(st).slice(0, 600) }
        }
        continue
      }
      const out = []
      const outs = entry.outputs || {}
      const keys = Object.keys(outs)
      for (let i = 0; i < keys.length; i++) {
        const o = outs[keys[i]]
        if (o && o.images) {
          for (let k = 0; k < o.images.length; k++) out.push(o.images[k])
        }
      }
      if (!out.length) return { ok: false, error: 'ComfyUI 完成但没有产出图片' }
      return { ok: true, files: out }
    }
    return { ok: false, error: '生成超时（' + Math.round((timeoutMs || 600000) / 1000) + ' 秒）' }
  }
  /**
   * 生成一张资产图并放进项目。
   * 图片先由 ComfyUI 落在它自己的 output 目录，再用 copy 搬进项目 ——
   * fs 服务没有写二进制的接口，走 copy 是最稳的。
   */
  async function genOneAsset(pid, item, kind, params, job) {
    const recipe = imageRecipe(params)
    const url = comfyUrlOf(params)
    const style = effectiveStyle(params)
    const isChar = kind === 'characters'
    const w = 832
    const h = isChar ? 1248 : Math.max(512, Math.round(832 * (params.height || 768) / (params.width || 1344) / 32) * 32)
    // 身份特征必须**前置**主导渲染；风格块放在后面，且只描述渲染表面。
    // 末尾追加身份保真硬约束，专治 Krea-2 的"美人先验"。
    const brief = String(item.image_prompt || item.description || item.name || '').trim()
    let prompt = brief
    prompt += '\n\nFRAMING: ' + (isChar
      ? 'single character, upper-body framing, front-facing, plain neutral background, no other people, no text or lettering.'
      : 'environment plate only, no people, no characters, no text or lettering.')
    prompt += '\n\nIDENTITY FIDELITY (mandatory): the face must match the written brief EXACTLY — same face shape and jaw, '
      + 'same eye shape and eyelids, same brow shape, same hair length and style. Do not beautify, do not enlarge or round the eyes, '
      + 'do not soften a sharp jaw, do not make the subject younger, prettier or more handsome than described.'
    if (style) prompt += '\n\nRENDER STYLE (surface only, never changes features): ' + style
    const seed = 1000 + Math.floor(Math.random() * 900000)
    const graph = buildImageGraph(recipe, prompt, w, h, seed)
    if (job) job.log += '    生成「' + (item.name || item.id) + '」' + w + '×' + h + ' seed=' + seed + ' …\n'
    const run = await comfyRunGraph(url, graph, (params.genTimeoutSec || 600) * 1000, (note) => {
      if (job) job.log += '      ' + note + '\n'
    })
    if (!run.ok) return { ok: false, error: run.error }
    const f = run.files[0]
    const src = COMFY_DIR + '\\output' + (f.subfolder ? '\\' + String(f.subfolder).replace(/\//g, '\\') : '')
      + '\\' + f.filename
    // 项目内文件名：kind_角色名.png，避免中文以外的不安全字符
    const safe = String(item.name || item.id || 'asset').replace(/[^0-9A-Za-z_\-\u4e00-\u9fa5]/g, '_')
    const rel = 'assets/img/' + kind + '_gen_' + safe + '_' + seed + '.png'
    const dst = abs(pid + '\\' + rel.replace(/\//g, '\\'))
    // 用 Node 的文件 API 搬运，**不走 cmd copy** —— 实测 `cmd /c copy` 在多段参数下
    // 会被引号规则搞坏（错误里出现 `\D:\...\png\*`、复制 0 个文件）。宿主半本来就是
    // Node 进程，直接 copyFile 既没有引号问题，也没有编码问题。
    try {
      const fsp = await import('node:fs/promises')
      const npath = await import('node:path')
      await fsp.mkdir(npath.dirname(dst), { recursive: true })
      await fsp.copyFile(src, dst)
      const stt = await fsp.stat(dst)
      if (!stt || stt.size < 1024) throw new Error('复制出来的文件过小（' + (stt ? stt.size : 0) + ' 字节）')
    } catch (e) {
      return { ok: false, error: '图片搬运失败：' + String((e && e.message) || e) + '（源：' + src + '）' }
    }
    const assets = await readJson(pid + '\\assets.json', EMPTY_ASSETS)
    if (!assets[kind]) assets[kind] = []
    const arr = assets[kind]
    let hit = -1
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i]) continue
      if (String(arr[i].id) === String(item.id || '') || String(arr[i].name) === String(item.name || '')) hit = i
    }
    const entry = {
      // **id 必须沿用方案里的 id**：镜头引用的是 plan.shots[].characters 里的 id，
      // 用合成 id 存进去的话，渲染前解析参考图会一张都找不到（实测踩过）。
      id: (arr[hit] && arr[hit].id) || String(item.id || (kind + '_gen_' + safe)),
      name: String(item.name || item.id || ''),
      desc: String(item.description || '').slice(0, 200),
      image: rel,
      generated: true,
      seed: seed,
    }
    if (hit >= 0) arr[hit] = Object.assign({}, arr[hit], entry)
    else arr.push(entry)
    await writeText(pid + '\\assets.json', JSON.stringify(assets, null, 2))
    if (job) job.log += '      ✓ ' + rel + '\n'
    return { ok: true, rel: rel, seed: seed }
  }
  /**
   * 资产定妆阶段：把方案里引用了但还没有图的角色/场景补齐。
   * **绝不静默降级**：生成失败就把失败清单交出去，让用户看到"这几镜没锁脸"。
   */
  async function genAssets(job, only) {
    const meta = await readJson(job.project + '\\project.json', {})
    const params = Object.assign(defaultParams(), meta.params || {})
    const plan = await readJson(job.project + '\\plan.json', null)
    const doc = plan || (await readJson(job.project + '\\shots.json', { shots: [] }))
    if (!doc || !doc.shots || !doc.shots.length) {
      return { ok: false, error: '还没有方案：先跑「方案」阶段' }
    }
    const assets = await readJson(job.project + '\\assets.json', EMPTY_ASSETS)
    const have = {}
    for (let k = 0; k < KINDS.length; k++) {
      const arr = assets[KINDS[k]] || []
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].image) have[KINDS[k] + ':' + String(arr[i].id)] = true
      }
    }
    // 只补方案里真正被引用到的条目 —— 生成一张要几十秒，不能全量瞎跑
    const needChar = {}
    const needScene = {}
    for (let i = 0; i < doc.shots.length; i++) {
      const s = doc.shots[i] || {}
      const chs = s.characters || []
      for (let c = 0; c < chs.length; c++) needChar[chs[c]] = true
      if (s.scene) needScene[s.scene] = true
    }
    const todo = []
    const chars = doc.characters || []
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]
      if (!c || !needChar[c.id]) continue
      if (have['characters:' + c.id]) continue
      if (only && only.indexOf(c.id) < 0) continue
      todo.push({ kind: 'characters', item: c })
    }
    const scenes = doc.scenes || []
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i]
      if (!s || !needScene[s.id]) continue
      if (have['scenes:' + s.id]) continue
      if (only && only.indexOf(s.id) < 0) continue
      todo.push({ kind: 'scenes', item: s })
    }
    if (!todo.length) {
      job.log += '  资产齐全：方案引用的角色/场景都已有图，无需生成。\n'
      return { ok: true, made: 0, failed: [], total: 0 }
    }
    // 生成前确保 ComfyUI 在线
    const cst = await ensureComfy(job, params)
    if (!cst.ok) return { ok: false, error: cst.error }
    job.log += '  待生成 ' + todo.length + ' 张（' + recipeLabel(params) + '）\n'
    const made = []
    const failed = []
    for (let i = 0; i < todo.length; i++) {
      if (job.stop) break
      const t = todo[i]
      const r = await genOneAsset(job.project, t.item, t.kind, params, job)
      if (r.ok) made.push({ kind: t.kind, name: t.item.name })
      else {
        failed.push({ kind: t.kind, name: t.item.name, error: r.error })
        job.log += '      ✕ ' + (t.item.name || t.item.id) + '：' + r.error + '\n'
      }
    }
    return { ok: failed.length === 0, made: made.length, failed: failed, total: todo.length }
  }
  function recipeLabel(params) {
    const r = imageRecipe(params)
    return r.unet.split('.')[0] + ' + ' + r.clipType + ' + ' + r.vae.split('.')[0]
  }

  // ═══════════ 小说库：目录浏览与扫描 ═══════════
  //
  // 「小说管理」要让用户自己指定小说目录，而不是每次手打一个文件路径。
  // 这里提供两件事：
  //   * dir.list  —— 目录浏览（只列子目录 + 驱动器，供界面点选）
  //   * novel.scan —— 扫出该目录下的可导入文本（.txt/.md），带大小与字数估算
  const TEXT_EXT = /\.(txt|md|markdown)$/i
  async function listDirs(absPath) {
    const out = []
    const entries = await listDirEntries(absPath)
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type === 'directory') out.push(entries[i].name)
    }
    out.sort()
    return out
  }
  /** 直接列任意绝对目录（listDir 走的是项目相对路径，这里要绝对路径）。 */
  async function listDirEntries(absPath) {
    try {
      const t = await fs.resolve(absPath)
      const st = await fs.stat(t)
      if (!st || st.type !== 'directory') return []
      return await fs.listDir(t)
    } catch (e) { return [] }
  }
  /** 可用的盘符，供目录浏览器回到顶层。 */
  async function listDrives() {
    const out = []
    const r = await runCmd(['cmd.exe', '/c', 'wmic logicaldisk get name'], SPAWN_BASE)
    const m = String(r.text || '').match(/[A-Za-z]:/g)
    if (m) {
      for (let i = 0; i < m.length; i++) {
        const d = m[i].toUpperCase()
        if (out.indexOf(d) < 0) out.push(d)
      }
    }
    if (!out.length) {
      for (let i = 0; i < fsDrives.length; i++) out.push(fsDrives[i])
    }
    out.sort()
    return out
  }
  // wmic 在新系统上可能缺失时的兜底
  const fsDrives = (() => {
    const out = []
    for (let i = 67; i <= 90; i++) out.push(String.fromCharCode(i) + ':')
    return out
  })()
  /**
   * 扫描小说目录。只认文本文件，深度可控（默认 2 层），
   * 数量与单文件大小都设上限 —— 目录浏览不该因为一个巨大的素材盘而卡死。
   */
  async function scanNovels(dir, depth, maxFiles) {
    const max = maxFiles || 300
    const out = []
    const walk = async (p, level) => {
      if (out.length >= max || level > (depth === undefined ? 2 : depth)) return
      const entries = await listDirEntries(p)
      for (let i = 0; i < entries.length; i++) {
        if (out.length >= max) return
        const e = entries[i]
        if (e.type === 'directory') {
          if (e.name.charAt(0) === '.' || e.name.charAt(0) === '_') continue
          await walk(p + '\\' + e.name, level + 1)
        } else if (TEXT_EXT.test(e.name)) {
          out.push({
            name: e.name,
            path: p + '\\' + e.name,
            size: e.size || 0,
            chars: Math.max(1, Math.round((e.size || 0) / 3)), // UTF-8 中文约 3 字节/字
          })
        }
      }
    }
    await walk(dir, 0)
    out.sort((a, b) => (a.path < b.path ? -1 : 1))
    return out
  }
  /**
   * 开跑前的「内容体检」。
   * 一条龙最常见的失败是"项目里根本没正文"，与其跑到方案阶段才报错，
   * 不如在点下按钮的那一刻就说清楚缺什么。
   */
  async function contentCheck(pid) {
    const novel = await readText(pid + '\\novel.md', '')
    const scripts = []
    const entries = await listDir(pid + '\\script')
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type === 'file' && TEXT_EXT.test(entries[i].name)) scripts.push(entries[i].name)
    }
    const shotsDoc = await readJson(pid + '\\shots.json', { shots: [] })
    const shotCount = (shotsDoc.shots || []).length
    const problems = []
    if (!(novel && novel.trim()) && !scripts.length && !shotCount) {
      problems.push('项目里还没有正文：请到「内容」导入小说或分镜脚本（也可以直接跳到「方案」之前先建好 shots.json）')
    }
    return {
      ok: problems.length === 0,
      problems: problems,
      novelChars: novel ? novel.length : 0,
      scripts: scripts,
      shotCount: shotCount,
    }
  }

  const handlers = {
    async boot() {
      await mkdirp(ROOT)
      const ids = await projectIds()
      const projects = []
      for (let i = 0; i < ids.length; i++) projects.push(await summary(ids[i]))
      return { root: ROOT, projects, kinds: KINDS, version: await pluginVersion() }
    },

    /**
     * 删除项目 —— **软删除**：整个目录移进 .trash/<id>_<时间戳>，可恢复。
     * 一个项目目录里可能有几十个渲染好的 mp4，一键硬删是不可逆的破坏，
     * 不该做成一次点击就发生的事。
     */
    async 'remove'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const st = await fs.stat(await fs.resolve(abs(id)))
      if (!st || st.type !== 'directory') return { error: '项目不存在：' + id }
      const fsp = await import('node:fs/promises')
      const npath = await import('node:path')
      const trash = abs('_trash')
      await fsp.mkdir(trash, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const dest = npath.join(trash, id + '_' + stamp)
      try {
        await fsp.rename(abs(id), dest)
      } catch (e) {
        // 跨卷或占用时 rename 会失败，退回"复制 + 删源"
        await fsp.cp(abs(id), dest, { recursive: true })
        await fsp.rm(abs(id), { recursive: true, force: true })
      }
      return { ok: true, id: id, movedTo: dest }
    },

    /** 复制项目（连同已渲染的片段），用于"以这个项目为模板再开一部"。 */
    async 'duplicate'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const st = await fs.stat(await fs.resolve(abs(id)))
      if (!st || st.type !== 'directory') return { error: '项目不存在：' + id }
      const fsp = await import('node:fs/promises')
      // 找一个没占用的新 id：xxx-copy、xxx-copy2 …
      const ids = await projectIds()
      let nid = id + '-copy'
      let n = 2
      while (ids.indexOf(nid) >= 0) { nid = id + '-copy' + n; n += 1 }
      await fsp.cp(abs(id), abs(nid), { recursive: true })
      // 标题也加后缀，否则列表里两个一模一样的名字分不清
      const meta = await readJson(nid + '\\project.json', {})
      meta.title = String(meta.title || id) + ' 副本'
      await writeText(nid + '\\project.json', JSON.stringify(meta, null, 2))
      return { ok: true, id: nid, from: id }
    },

    /** 重命名项目：只改显示标题（不动目录名，避免打断已有引用）。 */
    async 'rename'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const title = String((a && a.title) || '').trim()
      if (!title) return { error: '标题不能为空' }
      if (title.length > 60) return { error: '标题过长（上限 60 字）' }
      const meta = await readJson(id + '\\project.json', {})
      meta.title = title
      await writeText(id + '\\project.json', JSON.stringify(meta, null, 2))
      return { ok: true, id: id, title: title }
    },

    async read(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const meta = await readJson(id + '\\project.json', {})
      const doc = await readJson(id + '\\shots.json', { project: id, style: '', shots: [] })
      const assets = await readJson(id + '\\assets.json', EMPTY_ASSETS)
      const novel = await readText(id + '\\novel.md', '')
      // plan.json 是作者方案（含角色卡/场景卡）；故事板要靠它显示参考图
      const plan = await readJson(id + '\\plan.json', null)
      for (let k = 0; k < KINDS.length; k++) {
        const arr = assets[k] || []
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] && arr[i].image) arr[i].image = normRel(id, arr[i].image)
        }
      }
      return {
        id, meta, novel, shotsDoc: doc, assets, plan: plan,
        files: filesOf(await listDir(id)),
        clips: clipsOf(await listDir(id)),
      }
    },

    async create(a) {
      const id = String((a && a.id) || '').trim()
      if (!ID_RE.test(id)) return { error: '项目名只能用字母/数字/下划线/连字符，1-40 字符' }
      if (await exists(id + '\\project.json')) return { error: '项目已存在' }
      await mkdirp(abs(id) + '\\assets\\img')
      const meta = {
        title: String((a && a.title) || id),
        genre: String((a && a.genre) || ''),
        style: String((a && a.style) || ''),
        synopsis: String((a && a.synopsis) || ''),
      }
      await writeText(id + '\\project.json', JSON.stringify(meta, null, 2))
      await writeText(id + '\\novel.md', '')
      await writeText(id + '\\assets.json', JSON.stringify(EMPTY_ASSETS, null, 2))
      await writeText(id + '\\shots.json', JSON.stringify({ project: id, style: meta.style, shots: [] }, null, 2))
      return { ok: true, id }
    },

    async saveNovel(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      await writeText(id + '\\novel.md', String((a && a.text) || ''))
      return { ok: true }
    },

    async saveShots(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      let doc
      try {
        doc = typeof a.doc === 'string' ? JSON.parse(a.doc) : a.doc
      } catch (e) { return { error: '分镜 JSON 解析失败: ' + String(e && e.message) } }
      if (!doc || typeof doc !== 'object') return { error: '分镜必须是一个对象' }
      if (!doc.shots || !doc.shots.length) return { error: 'shots 为空' }
      doc.project = id
      await writeText(id + '\\shots.json', JSON.stringify(doc, null, 2))
      return { ok: true, count: doc.shots.length }
    },

    async saveMeta(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const meta = (a && a.meta) || {}
      await writeText(id + '\\project.json', JSON.stringify(meta, null, 2))
      if (meta.style !== undefined) {
        const doc = await readJson(id + '\\shots.json', { project: id, style: '', shots: [] })
        doc.style = meta.style
        await writeText(id + '\\shots.json', JSON.stringify(doc, null, 2))
      }
      return { ok: true }
    },

    async addAsset(a) {
      const id = String((a && a.id) || '')
      const kind = String((a && a.kind) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      if (KINDS.indexOf(kind) < 0) return { error: 'kind 必须是 characters/scenes/props' }
      const src = String((a && a.srcPath) || '').trim()
      if (!src) return { error: '请填写源图片的绝对路径' }
      try {
        const st = await fs.stat(await fs.resolve(src))
        if (!st) return { error: '源文件不存在：' + src }
      } catch (e) { return { error: '源文件不可读：' + src } }
      const m = src.match(/\.[A-Za-z0-9]+$/)
      const ext = m ? m[0] : '.png'
      let label = String((a && a.name) || 'asset').replace(/[^0-9A-Za-z_\-\u4e00-\u9fa5]/g, '_')
      if (!label) label = 'asset'
      seq += 1
      const stamp = 'a' + seq
      const fileName = kind + '_' + stamp + '_' + label + ext
      await mkdirp(abs(id) + '\\assets\\img')
      const r = await runCmd(
        ['cmd.exe', '/c', 'copy', '/Y', src, abs(id + '\\assets\\img\\' + fileName)],
        SPAWN_BASE,
      )
      if (r.exitCode !== 0) return { error: '复制失败：' + String(r.text).slice(0, 240) }
      const assets = await readJson(id + '\\assets.json', EMPTY_ASSETS)
      if (!assets[kind]) assets[kind] = []
      assets[kind].push({
        id: kind + '_' + stamp,
        name: String((a && a.name) || ''),
        desc: String((a && a.desc) || ''),
        image: 'assets/img/' + fileName,
      })
      await writeText(id + '\\assets.json', JSON.stringify(assets, null, 2))
      return { ok: true, assets }
    },

    async removeAsset(a) {
      const id = String((a && a.id) || '')
      const kind = String((a && a.kind) || '')
      const aid = String((a && a.assetId) || '')
      if (!ID_RE.test(id) || KINDS.indexOf(kind) < 0) return { error: '参数非法' }
      const assets = await readJson(id + '\\assets.json', EMPTY_ASSETS)
      const arr = assets[kind] || []
      const keep = []
      for (let i = 0; i < arr.length; i++) { if (!arr[i] || arr[i].id !== aid) keep.push(arr[i]) }
      assets[kind] = keep
      await writeText(id + '\\assets.json', JSON.stringify(assets, null, 2))
      return { ok: true, assets }
    },

    async renderStart(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      if (!(await exists(id + '\\shots.json'))) return { error: '缺少 shots.json' }
      let handle
      try {
        handle = subprocess.spawn({
          argv: manjuArgv(['render', '--shots', abs(id) + '\\shots.json', '--out', abs(id)]),
          cwd: abs(id),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 2097152 }, stderr: { maxBytes: 2097152 } },
          graceMs: 6000,
        })
      } catch (e) { return { error: '启动渲染失败：' + String(e && e.message) } }
      seq += 1
      const jobId = 'job' + seq
      const job = { id: jobId, project: id, handle, running: true, exitCode: null, offOut: 0, offErr: 0, log: '' }
      jobs[jobId] = job
      handle.done
        .then((o) => { job.running = false; job.exitCode = o ? o.exitCode : null })
        .catch(() => { job.running = false; job.exitCode = -1 })
      return { ok: true, jobId }
    },

    async renderPoll(a) {
      const job = jobs[String((a && a.jobId) || '')]
      if (!job) return { error: '任务不存在' }
      let chunk = ''
      try {
        if (job.handle.collected.stdout) {
          const r = job.handle.collected.stdout.readFrom(job.offOut)
          job.offOut = r.nextOffset
          chunk += r.text
        }
      } catch (e) { /* 忽略 */ }
      try {
        if (job.handle.collected.stderr) {
          const r2 = job.handle.collected.stderr.readFrom(job.offErr)
          job.offErr = r2.nextOffset
          chunk += r2.text
        }
      } catch (e) { /* 忽略 */ }
      if (chunk) job.log = (job.log + chunk).slice(-200000)
      const lines = jobLines(job)
      return {
        jobId: job.id,
        project: job.project,
        running: job.running,
        exitCode: job.exitCode,
        progress: parseJob(job),
        lines: lines.length > 400 ? lines.slice(lines.length - 400) : lines,
      }
    },

    async renderStop(a) {
      const job = jobs[String((a && a.jobId) || '')]
      if (job) { try { job.handle.terminate() } catch (e) { /* 忽略 */ } }
      return { ok: true }
    },

    async 'jobs.list'() {
      const out = []
      const keys = Object.keys(jobs)
      for (let i = 0; i < keys.length; i++) {
        const j = jobs[keys[i]]
        out.push({ jobId: j.id, project: j.project, running: j.running, exitCode: j.exitCode })
      }
      return { jobs: out }
    },

    // 合成成片：禁流复制 + 响度归一 + faststart（见 composeFinal 的注释）
    async assemble(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const meta = await readJson(id + '\\project.json', {})
      const pp = Object.assign(defaultParams(), meta.params || {})
      return await composeFinal(id, {
        transition: (a && a.transition) || pp.transition || 'cut',
        loudness: a && a.loudness !== undefined ? a.loudness : pp.loudness,
        subtitles: a && a.subtitles !== undefined ? a.subtitles : pp.subtitles,
        subtitleSize: (a && a.subtitleSize) || pp.subtitleSize,
        compliance: a && a.compliance !== undefined ? a.compliance : pp.compliance,
      })
    },

    // 机械质检：时长/音轨/分辨率 + 黑屏防线，报告落 output/qc_report.json
    async qc(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const rep = await qcProject(id, {
        darkFail: a && a.darkFail,
        darkWarn: a && a.darkWarn,
        minDuration: a && a.minDuration,
      })
      rep.ok = rep.failed === 0 && rep.total > 0
      if (rep.total === 0) rep.error = '没有可质检的镜头：请先渲染'
      return rep
    },

    /** 读上次质检报告，供故事板直接显示每镜的合格状态（不重跑质检）。 */
    async 'qc.report'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const rep = await readJson(id + '\\output\\qc_report.json', null)
      if (!rep || !rep.reports) return { total: 0, failed: 0, warned: 0, byFile: {} }
      const byFile = {}
      for (let i = 0; i < rep.reports.length; i++) {
        const r = rep.reports[i]
        if (r && r.file) byFile[r.file] = r
      }
      return { total: rep.total || 0, failed: rep.failed || 0, warned: rep.warned || 0,
        checkedAt: rep.checkedAt || '', byFile: byFile }
    },

    // 渲染前节点预检（供 UI 单独调用；管线里也会自动跑）
    async 'render.preflight'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      return await preflight(null)
    },

    // 风格预设表（供 UI 下拉；组合后写进 params.styleHit）
    async 'style.presets'() {
      const out = []
      const keys = Object.keys(STYLE_PRESETS)
      for (let i = 0; i < keys.length; i++) {
        out.push({ key: keys[i], name: STYLE_PRESETS[keys[i]].name, prompt: STYLE_PRESETS[keys[i]].prompt })
      }
      return { presets: out }
    },

    // ── ComfyUI 启动管理 ──
    async 'comfy.status'(a) {
      const id = String((a && a.id) || '')
      let url = 'http://127.0.0.1:8199'
      if (ID_RE.test(id)) {
        const meta = await readJson(id + '\\project.json', {})
        url = comfyUrlOf(Object.assign(defaultParams(), meta.params || {}))
      }
      return await comfyStatus(url)
    },

    async 'comfy.start'(a) {
      const id = String((a && a.id) || '')
      let url = 'http://127.0.0.1:8199'
      if (ID_RE.test(id)) {
        const meta = await readJson(id + '\\project.json', {})
        url = comfyUrlOf(Object.assign(defaultParams(), meta.params || {}))
      }
      const st = await comfyStart(url, { timeoutSec: (a && a.timeoutSec) || 240 })
      touchComfy(ID_RE.test(id) ? id : activeProject)   // 让空闲退出从这里开始计时
      if (st.ok && !st.already) {
        try { await logger.info('manju-studio: ComfyUI started pid=' + st.pid + ' in ' + st.waitedSec + 's') } catch (e) { /* 忽略 */ }
      }
      return st
    },

    async 'comfy.stop'(a) {
      const id = String((a && a.id) || '')
      let url = 'http://127.0.0.1:8199'
      if (ID_RE.test(id)) {
        const meta = await readJson(id + '\\project.json', {})
        url = comfyUrlOf(Object.assign(defaultParams(), meta.params || {}))
      }
      return await comfyStop(url)
    },

    async 'comfy.restart'(a) {
      const id = String((a && a.id) || '')
      let url = 'http://127.0.0.1:8199'
      if (ID_RE.test(id)) {
        const meta = await readJson(id + '\\project.json', {})
        url = comfyUrlOf(Object.assign(defaultParams(), meta.params || {}))
      }
      const st = await comfyStop(url)
      const up = await comfyStart(url, { timeoutSec: (a && a.timeoutSec) || 240 })
      return { ok: up.ok, stopped: st, started: up }
    },

    // ── 小说库：目录配置 / 浏览 / 扫描 ──
    async 'dir.list'(a) {
      const p = String((a && a.path) || '').trim()
      if (!p) {
        return { path: '', parent: '', dirs: await listDrives(), drives: await listDrives(), atRoot: true }
      }
      if (!/^[A-Za-z]:\\?$/.test(p) && !/^[A-Za-z]:\\/.test(p)) {
        return { error: '请填绝对路径，例如 D:\\Ai\\小说' }
      }
      const norm = p.replace(/[\\/]+$/, '') || p
      const dirs = await listDirs(norm)
      let parent = ''
      const cut = norm.lastIndexOf('\\')
      if (cut > 2) parent = norm.slice(0, cut)
      else if (/^[A-Za-z]:$/.test(norm)) parent = ''
      return {
        path: norm,
        parent: parent,
        dirs: dirs,
        drives: await listDrives(),
        atRoot: /^[A-Za-z]:$/.test(norm),
        files: (await scanNovels(norm, 0, 60)),
      }
    },

    async 'novel.scan'(a) {
      const dir = String((a && a.dir) || '').trim()
      if (!dir) return { error: '请先在「小说管理」里配置小说目录' }
      const files = await scanNovels(dir, (a && a.depth) === undefined ? 2 : a.depth, 300)
      return { dir: dir, files: files, count: files.length }
    },

    /** 开跑前的内容体检，让一条龙在按钮按下的那一刻就报缺什么。 */
    async 'content.check'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      return await contentCheck(id)
    },

    async envCheck() {
      const r = await runCmd(manjuArgv(['check']), SPAWN_BASE)
      return { ok: r.exitCode === 0, text: String(r.text).slice(-6000) }
    },

    /** 资产定妆（供 UI 单独调用）。only 给了就只补这几条。 */
    /**
     * 抽卡「选用」：把某个备选提升为该镜的定稿。
     *
     * 做法是把定稿原文件改名成 `<sid>_take<原号>.mp4`（保号不丢），再把被选中的
     * 备选改名成 `<sid>.mp4`。**用改名而不是复制**，所以磁盘不涨；
     * 而保留旧定稿意味着"选错了还能换回来"，不是单向操作。
     */
    async 'shot.pick'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const src = String((a && a.src) || '')
      const m = src.match(/^(.+)_take(\d+)\.mp4$/i)
      if (!m || !REL_RE.test(src)) return { error: '只能选用抽卡备选（<镜头>_take<号>.mp4）' }
      const sid = m[1]
      const fsp = await import('node:fs/promises')
      const cur = abs(id + '\\' + sid + '.mp4')
      const pick = abs(id + '\\' + src)
      const stp = await fs.stat(await fs.resolve(pick))
      if (!stp) return { error: '备选不存在：' + src }
      // 找一个没被占用的编号安置旧定稿
      let slot = 2
      while (true) {
        const cand = abs(id + '\\' + sid + '_take' + slot + '.mp4')
        const cs = await fs.stat(await fs.resolve(cand))
        if (!cs) break
        slot += 1
        if (slot > 99) return { error: '该镜备选编号已满' }
      }
      try {
        const curStat = await fs.stat(await fs.resolve(cur))
        if (curStat) await fsp.rename(cur, abs(id + '\\' + sid + '_take' + slot + '.mp4'))
        await fsp.rename(pick, cur)
      } catch (e) {
        return { error: '选用失败：' + String((e && e.message) || e) }
      }
      return { ok: true, shot: sid, picked: src, demoted: sid + '_take' + slot + '.mp4' }
    },

    /** 丢弃某镜的全部抽卡备选（定稿不动）。 */
    async 'shot.dropTakes'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const sid = String((a && a.shot) || '')
      if (!ID_RE.test(sid)) return { error: '镜头 id 非法' }
      const fsp = await import('node:fs/promises')
      const entries = await listDir(id)
      const gone = []
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        const m = e.type === 'file' && e.name.match(/^(.+)_take(\d+)\.mp4$/i)
        if (!m || m[1] !== sid) continue
        try { await fsp.rm(abs(id + '\\' + e.name), { force: true }); gone.push(e.name) } catch (err) { /* */ }
      }
      return { ok: true, shot: sid, removed: gone }
    },

    async 'asset.gen'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const job = {
        project: id, log: '', stop: false, handle: null,
        stages: [], only: null, running: false,
      }
      const only = Array.isArray(a && a.only) && a.only.length ? a.only : null
      try {
        const res = await genAssets(job, only)
        return Object.assign({}, res, { log: job.log })
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e), log: job.log }
      }
    },

    /** 看一眼本机 ComfyUI 里到底有哪些图像模型可用，免得配方写错文件名。 */
    async 'asset.models'(a) {
      const id = String((a && a.id) || '')
      let url = 'http://127.0.0.1:8199'
      if (ID_RE.test(id)) {
        const meta = await readJson(id + '\\project.json', {})
        url = comfyUrlOf(Object.assign(defaultParams(), meta.params || {}))
      }
      if (!(await comfyAlive(url))) {
        return { ok: false, error: 'ComfyUI 未运行，先启动再看可用模型', unets: [], clips: [], vaes: [], clipTypes: [] }
      }
      const res = await comfyGet(url, '/object_info', 60000)
      if (!res || !res.ok) return { ok: false, error: '读取 object_info 失败', unets: [], clips: [], vaes: [], clipTypes: [] }
      let oi = null
      try { oi = await res.json() } catch (e) { return { ok: false, error: 'object_info 不是合法 JSON' } }
      const pick = (node, field) => {
        try { return oi[node].input.required[field][0] || [] } catch (e) { return [] }
      }
      return {
        ok: true,
        unets: pick('UNETLoader', 'unet_name'),
        clips: pick('CLIPLoader', 'clip_name'),
        vaes: pick('VAELoader', 'vae_name'),
        clipTypes: pick('CLIPLoader', 'type'),
      }
    },

    // ── 项目参数（对齐 NiliX「参数」面板）──
    async 'params.get'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const meta = await readJson(id + '\\project.json', {})
      return { params: Object.assign(defaultParams(), meta.params || {}) }
    },

    async 'params.set'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const meta = await readJson(id + '\\project.json', {})
      meta.params = Object.assign(defaultParams(), meta.params || {}, (a && a.params) || {})
      await writeText(id + '\\project.json', JSON.stringify(meta, null, 2))
      return { ok: true, params: meta.params }
    },

    // ── 可选的大模型路由（方案阶段用；llm 是可选依赖，没有就如实回报）──
    async 'llm.providers'() {
      const llm = ctx.get('llm')
      if (!llm || typeof llm.listProviders !== 'function') {
        return { providers: [], error: '宿主未提供 llm 服务' }
      }
      let list = []
      try { list = llm.listProviders() || [] } catch (e) {
        return { providers: [], error: String((e && e.message) || e) }
      }
      const out = []
      for (let i = 0; i < list.length; i++) {
        const p = list[i]
        let models = []
        try {
          const ms = await llm.listModels(p.id)
          for (let k = 0; k < (ms || []).length; k++) models.push(ms[k].id)
        } catch (e) { models = [] }
        out.push({ id: p.id, name: p.name || p.id, models: models })
      }
      return { providers: out }
    },

    // ── 镜头范围预览（渲染配置面板实时显示「将渲 N 镜」）──
    async 'shots.preview'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const doc = await readJson(id + '\\shots.json', { shots: [] })
      const all = (doc && doc.shots) || []
      const p = pickShots(doc, (a && a.range) || {})
      return { total: all.length, picked: p.shots.length, by: p.by, filtered: p.filtered }
    },

    // ── 产物清单（人物 / 场景 / 镜头）──
    async products(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const assets = await readJson(id + '\\assets.json', EMPTY_ASSETS)
      const clips = await ensurePosters(id, clipsOf(await listDir(id)))
      const novels = []
      const novelEntries = await listDir(id + '\\novel')
      for (let i = 0; i < novelEntries.length; i++) {
        if (novelEntries[i].type === 'file') novels.push({ name: novelEntries[i].name, size: novelEntries[i].size || 0 })
      }
      return {
        characters: (assets.characters || []).map((x) => ({ id: x.id, name: x.name, desc: x.desc, image: x.image })),
        scenes: (assets.scenes || []).map((x) => ({ id: x.id, name: x.name, desc: x.desc, image: x.image })),
        props: (assets.props || []).map((x) => ({ id: x.id, name: x.name, desc: x.desc, image: x.image })),
        clips,
        novels,
      }
    },

    // ── 脚本：读取/保存（对齐 NiliX「内容来源」）──
    async 'script.read'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const rel = String((a && a.rel) || 'script/ep01.md')
      const clean = relOk(normRel(id, rel)) ? normRel(id, rel) : 'script/ep01.md'
      const text = await readText(id + '\\' + clean.replace(/\//g, '\\'), '')
      return { rel: clean, text, chars: text.length }
    },

    async 'script.write'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const rel = String((a && a.rel) || 'script/ep01.md')
      const clean = normRel(id, rel)
      if (!relOk(clean)) return { error: '脚本路径非法' }
      await writeText(id + '\\' + clean.replace(/\//g, '\\'), String((a && a.text) || ''))
      return { ok: true }
    },

    // ── 七阶段管线（对齐 NiliX：环境·方案·资产·编码·渲染·质检·合成）──
    // mode: 'all' 一条龙 / 'ai' 带自动返修的 AI 一条龙 / 'stage' 只跑 only 里列出的阶段
    async pipelineStart(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      // 开跑前先看内容在不在 —— 一条龙最常见的失败是项目里根本没正文
      const cc = await contentCheck(id)
      if (!cc.ok && !(a && a.skipContentCheck)) {
        return { error: '内容还没准备好：' + cc.problems.join('；'), content: cc }
      }
      // 同一时刻只跑一条管线：多条管线共用同一张显卡只会互相伤害
      // （定妆照排在长视频后面排队被杀、单镜从 3–5 分钟涨到 20+ 分钟）。
      const keys = Object.keys(jobs)
      for (let i = 0; i < keys.length; i++) {
        if (jobs[keys[i]].running) {
          return { error: '已有一条管线在运行（' + keys[i] + '）。请先等它结束或点「停止」—— 并发跑管线会共用同一张显卡、互相拖慢。' }
        }
      }
      const only = (a && a.only) || null
      if (only && only.length) {
        for (let i = 0; i < only.length; i++) {
          if (!STAGES.some((s) => s.key === only[i])) return { error: '未知阶段: ' + only[i] }
        }
      }
      seq += 1
      const jobId = 'pipe' + seq
      const job = {
        id: jobId, project: id, kind: 'pipeline',
        running: true, exitCode: null, log: '', handle: null, stop: false,
        mode: (a && a.mode) || (only && only.length ? 'stage' : 'all'),
        only: only && only.length ? only : null,
        forcePlan: !!(only && only.indexOf('plan') >= 0),
        range: (a && a.range) || {},
        shotsArg: '',
        renderBlocked: '',
        aiRetries: (a && a.retries) === undefined ? 2 : a.retries,
        stages: STAGES.map((s) => ({ key: s.key, name: s.name, state: 'pending', note: '' })),
      }
      jobs[jobId] = job
      runPipeline(job).catch((e) => {
        job.log += '\n[管线异常] ' + String((e && e.message) || e) + '\n'
        job.running = false
        job.exitCode = -1
      })
      return { ok: true, jobId }
    },

    async pipelinePoll(a) {
      const job = jobs[String((a && a.jobId) || '')]
      if (!job) return { error: '任务不存在' }
      const lines = jobLines(job)
      return {
        jobId: job.id,
        project: job.project,
        mode: job.mode,
        running: job.running,
        exitCode: job.exitCode,
        stages: job.stages.map((s) => ({ key: s.key, name: s.name, state: s.state, note: s.note })),
        progress: parseProgress(lines),
        lines: lines.length > 400 ? lines.slice(lines.length - 400) : lines,
      }
    },

    async pipelineStop(a) {
      const job = jobs[String((a && a.jobId) || '')]
      if (!job) return { error: '任务不存在' }
      job.stop = true
      if (job.handle) {
        try { job.handle.terminate() } catch (e) { /* 进程可能已退出 */ }
      }
      return { ok: true }
    },

    // 单镜重渲：render 会跳过已存在的 mp4，所以删掉这一镜再用「只渲这一镜」的范围重跑。
    async 'shot.rerender'(a) {
      const id = String((a && a.id) || '')
      const shot = String((a && a.shotId) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(shot)) return { error: '镜头 id 非法' }
      if (!(await exists(id + '\\shots.json'))) return { error: '缺少 shots.json' }
      try {
        await runCmd(['cmd.exe', '/c', 'del', '/f', '/q', abs(id + '\\' + shot + '.mp4')], SPAWN_BASE)
      } catch (e) { /* 本来就没有 */ }
      return await handlers.pipelineStart({ id: id, only: ['render'], range: { shots: shot } })
    },

    // ── 系统状态（对齐 NiliX 顶部 CPU / 内存 / GPU / ComfyUI 状态条）──
    async sysinfo(a) {
      const os = await import('node:os')
      const cpus = os.cpus()
      let idle = 0
      let total = 0
      for (let i = 0; i < cpus.length; i++) {
        const t = cpus[i].times
        idle += t.idle
        total += t.idle + t.user + t.nice + t.sys + t.irq
      }
      let cpuPct = 0
      if (lastCpu && total > lastCpu.total) {
        cpuPct = Math.round((1 - (idle - lastCpu.idle) / (total - lastCpu.total)) * 100)
        if (cpuPct < 0) cpuPct = 0
        if (cpuPct > 100) cpuPct = 100
      }
      lastCpu = { idle: idle, total: total }

      const memTotal = os.totalmem()
      const info = {
        cpu: cpuPct,
        cores: cpus.length,
        memUsed: memTotal - os.freemem(),
        memTotal: memTotal,
        gpu: null,
        comfy: { up: false, url: '', error: '' },
      }

      const now = Date.now()
      if (gpuCache && now - gpuCache.at < 2500) {
        info.gpu = gpuCache.val
      } else {
        try {
          const r = await runCmd([
            'nvidia-smi',
            '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
            '--format=csv,noheader,nounits',
          ], SPAWN_BASE)
          const line = String(r.text || '').trim().split(/\r?\n/)[0]
          if (line) {
            const p = line.split(',').map((x) => parseFloat(x))
            info.gpu = {
              util: isNaN(p[0]) ? 0 : p[0],
              temp: isNaN(p[1]) ? 0 : p[1],
              memUsed: (p[2] || 0) * 1048576,
              memTotal: (p[3] || 0) * 1048576,
            }
          }
        } catch (e) { info.gpu = null }
        gpuCache = { at: now, val: info.gpu }
      }

      let url = 'http://127.0.0.1:8199'
      const id = String((a && a.id) || '')
      if (ID_RE.test(id)) {
        const meta = await readJson(id + '\\project.json', {})
        const p = Object.assign(defaultParams(), meta.params || {})
        if (p.comfyUrl) url = String(p.comfyUrl)
      }
      info.comfy.url = url
      try {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 1500)
        const res = await fetch(url.replace(/\/+$/, '') + '/system_stats', { signal: ctl.signal })
        clearTimeout(timer)
        info.comfy.up = !!res.ok
        if (!res.ok) info.comfy.error = 'HTTP ' + res.status
      } catch (e) {
        info.comfy.error = String((e && e.message) || e)
      }
      return info
    },

    // ── 脚本文件（NiliX「更换脚本 / 清除脚本」）──
    async 'script.list'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const out = []
      const entries = await listDir(id + '\\script')
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (e.type === 'file' && /\.(md|txt)$/i.test(e.name)) {
          out.push({ name: e.name, rel: 'script/' + e.name, size: e.size || 0 })
        }
      }
      out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
      return { files: out }
    },

    /** 从项目外的绝对路径导入脚本；srcPath 为空时只重读现有脚本。 */
    async 'script.import'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const rel = normRel(id, String((a && a.rel) || 'script/ep01.md'))
      if (!relOk(rel)) return { error: '目标脚本路径非法' }
      const src = String((a && a.srcPath) || '').trim()
      if (src) {
        let text
        try {
          const st = await fs.stat(await fs.resolve(src))
          if (!st || st.type !== 'file') return { error: '源文件不存在：' + src }
          text = await fs.readText(await fs.resolve(src))
        } catch (e) { return { error: '源文件不可读：' + src } }
        if (!text) return { error: '源文件为空：' + src }
        await writeText(id + '\\' + rel.replace(/\//g, '\\'), text)
      }
      const t = await readText(id + '\\' + rel.replace(/\//g, '\\'), '')
      return { ok: true, rel: rel, text: t, chars: t.length }
    },

    /** 从项目外的绝对路径导入小说正文。 */
    async 'novel.import'(a) {
      const id = String((a && a.id) || '')
      if (!ID_RE.test(id)) return { error: '项目 id 非法' }
      const src = String((a && a.srcPath) || '').trim()
      if (!src) return { error: '请填写源文件绝对路径' }
      let text
      try {
        const st = await fs.stat(await fs.resolve(src))
        if (!st || st.type !== 'file') return { error: '源文件不存在：' + src }
        text = await fs.readText(await fs.resolve(src))
      } catch (e) { return { error: '源文件不可读：' + src } }
      if (!text) return { error: '源文件为空：' + src }
      await writeText(id + '\\novel.md', text)
      return { ok: true, chars: text.length, text: text }
    },
  }

  // ───────────────────────── HTTP 层 ─────────────────────────

  function readBody(req) {
    return new Promise((resolve) => {
      let data = ''
      let dead = false
      req.on('data', (c) => {
        if (dead) return
        data += c
        if (data.length > MAX_BODY) { dead = true; data = '' }
      })
      req.on('end', () => resolve(data))
      req.on('error', () => resolve(''))
    })
  }

  function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  /** 命令接口：POST /api/manju-studio，请求体 { cmd, args }。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      try {
        if (String(req.method || '').toUpperCase() !== 'POST') {
          sendJson(res, 405, { error: '只接受 POST' })
          return
        }
        const raw = await readBody(req)
        let body = {}
        try { body = JSON.parse(raw || '{}') } catch (e) {
          sendJson(res, 400, { error: '请求体不是合法 JSON' })
          return
        }
        const cmd = String(body.cmd || '')
        const fn = handlers[cmd]
        if (typeof fn !== 'function') {
          sendJson(res, 404, { error: '未知命令: ' + cmd })
          return
        }
        const out = await fn(body.args || {})
        sendJson(res, 200, out === undefined ? null : out)
      } catch (e) {
        try { sendJson(res, 500, { error: String((e && e.message) || e) }) } catch (e2) { /* 已响应 */ }
      }
    },
  }))

  /** 媒体接口：GET /manju-file?p=<项目>&r=<项目内相对路径>。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: FILE_PATH,
    handler: async (req, res) => {
      const diag = { pid: '', clean: '', abs: '', prefixOk: false }
      try {
        const url = String((req && req.url) || '')
        const qi = url.indexOf('?')
        const parts = (qi >= 0 ? url.slice(qi + 1) : '').split('&')
        let pid = ''
        let rel = ''
        for (let i = 0; i < parts.length; i++) {
          const kv = parts[i].split('=')
          if (kv[0] === 'p') pid = decodeURIComponent(kv.slice(1).join('='))
          else if (kv[0] === 'r') rel = decodeURIComponent(kv.slice(1).join('='))
        }
        diag.pid = pid
        if (!ID_RE.test(pid)) { res.writeHead(400); res.end('bad project id'); return }
        const clean = normRel(pid, rel)
        diag.clean = clean
        if (!relOk(clean)) {
          res.writeHead(400, { 'X-Manju-Diag': JSON.stringify(diag) })
          res.end('bad relative path')
          return
        }
        const rootAbs = abs(pid)
        const fileAbs = rootAbs + '\\' + clean.replace(/\//g, '\\')
        diag.abs = fileAbs
        diag.prefixOk = fileAbs.toLowerCase().indexOf((rootAbs + '\\').toLowerCase()) === 0
        if (!diag.prefixOk) {
          res.writeHead(403, { 'X-Manju-Diag': JSON.stringify(diag) })
          res.end('outside project')
          return
        }
        const target = await fs.resolve(fileAbs)
        const st = await fs.stat(target)
        if (!st || st.type !== 'file') {
          res.writeHead(404, { 'X-Manju-Diag': JSON.stringify(diag) })
          res.end('not found')
          return
        }
        const bytes = await fs.readBytes(target, undefined, 268435456)
        const low = clean.toLowerCase()
        let ct = 'application/octet-stream'
        if (/\.png$/.test(low)) ct = 'image/png'
        else if (/\.jpe?g$/.test(low)) ct = 'image/jpeg'
        else if (/\.webp$/.test(low)) ct = 'image/webp'
        else if (/\.gif$/.test(low)) ct = 'image/gif'
        else if (/\.mp4$/.test(low)) ct = 'video/mp4'
        else if (/\.webm$/.test(low)) ct = 'video/webm'
        res.writeHead(200, {
          'Content-Type': ct,
          'Content-Length': String(bytes.length),
          'Cache-Control': 'no-store',
        })
        res.end(bytes)
      } catch (e) {
        try {
          res.writeHead(500, { 'X-Manju-Diag': JSON.stringify(diag) + '|err=' + String(e && e.message) })
          res.end('error')
        } catch (e2) { /* 已响应 */ }
      }
    },
  }))

  // logger 不是本插件的硬依赖：必须用 ctx.get 读取（直接用 ctx.logger 会因未声明 inject 而抛错）。
  const logger = ctx.get('logger')
  if (logger && typeof logger.info === 'function') {
    logger.info('manju-studio host ready; root=' + ROOT)
  }
}

/**
 * 对外入口。任何未预期的异常都在此被吞掉：
 * 一个插件的 bug 绝不能让 DSH 启动失败。
 */
export function apply(ctx) {
  try {
    applyInner(ctx)
  } catch (e) {
    const msg = '[manju-studio] apply failed: ' + String((e && e.message) || e)
    try {
      const logger = ctx.get('logger')
      if (logger && typeof logger.error === 'function') logger.error(msg)
      else console.error(msg)
    } catch (e2) {
      console.error(msg)
    }
  }
}
