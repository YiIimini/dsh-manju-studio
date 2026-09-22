/**
 * UI 结构与契约断言（静默回归闸门）
 *
 * 定位：sweep-blank 负责"真数据渲染不崩"，这一条负责"该有的东西真的在"。
 * 两件事都要有 —— 只测不崩的话，把刷新按钮删掉也能全绿。
 *
 * 断言的每一条都对应一次真实事故或明确需求：
 *   * 封面闪烁   → Cache-Control 不能再是 no-store（宿主半）
 *   * 错误挂死   → 诊断头必须过 diagH 转义（宿主半）
 *   * 刷新落点   → 故事板右上角必须有刷新按钮，且接到 refreshAll
 *   * 日志可查   → 必须有 logs.list/read 与日志弹窗
 *   * 滚动条美化 → 双族写法（webkit + firefox）与 gutter 必须都在
 *   * 防重绘     → 行数据必须按内容签名记忆化，而不是按对象引用
 */
import fs from 'node:fs'

const HOST = 'D:\\Ai\\DSH-plugins\\dsh-manju-studio\\lib\\index.js'
const CLIENT = 'D:\\Ai\\DSH-plugins\\dsh-manju-studio\\lib\\client.js'
const HEADLESS = 'D:\\Ai\\DSH-plugins\\dsh-manju-studio\\tools\\manju-headless.py'
const host = fs.readFileSync(HOST, 'utf8')
const cli = fs.readFileSync(CLIENT, 'utf8')
const py = fs.readFileSync(HEADLESS, 'utf8')

let pass = 0
let fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + msg) } else { fail += 1; console.log('  FAIL ' + msg + (extra ? '  ← ' + extra : '')) }
}
const has = (s, t) => s.indexOf(t) >= 0

console.log('== 宿主半：媒体接口 ==')
// 精确断言：no-store 只允许留在 JSON API 上（那本来就该禁缓存），媒体接口一个都不能有。
// 一开始写成"整文件不含 no-store"就误伤了 —— 测试太宽会逼出假修复。
// 只数"真正的响应头写法"，别把注释里的说明文字也算进去（第一版栽在这上面）；
// 也**不能**用 slice(sendJson, readBody) 界定范围 —— readBody 在 sendJson 之前，切片会是空的。
// 用位置关系判断：唯一那处必须落在 sendJson 函数体里。
const noStoreHeader = "'Cache-Control': 'no-store'"
const nNoStore = host.split(noStoreHeader).length - 1
const idxJson = host.indexOf('function sendJson(')
const idxNoStore = host.indexOf(noStoreHeader)
ok(nNoStore === 1 && idxNoStore > idxJson && idxNoStore < idxJson + 900,
  'no-store 只留在 JSON API 上，媒体接口不再用（那是封面闪烁的根因）',
  '响应头写法出现 ' + nNoStore + ' 次，位置 ' + idxNoStore + '（sendJson 在 ' + idxJson + '）')
ok(has(host, "'Cache-Control', 'private, no-cache'"), "改用 private, no-cache（条件请求 304，复用已解码的图）")
ok(has(host, "'ETag', etag"), '发送强 ETag')
ok(has(host, "res.writeHead(304)"), '实现 304 短路')
ok(has(host, "'Accept-Ranges', 'bytes'"), '声明 Accept-Ranges')
ok(has(host, "'Content-Range': 'bytes ' + start + '-' + end + '/' + size"), '实现 206 Content-Range')
ok(has(host, 'res.writeHead(416'), '越界范围回 416')

console.log('== 宿主半：诊断头与资源治理 ==')
ok(has(host, 'function diagH('), '有 diagH 转义助手（非 ASCII 头值会让 writeHead 抛错并挂死响应）')
ok(!/X-Manju-Diag': JSON\.stringify/.test(host), '所有诊断头都已过 diagH')
ok(has(host, "'comfy.free'"), '有 comfy.free 命令（手动归还显存）')
ok(has(host, 'async function comfyFree('), '有 comfyFree 实现')
ok(has(host, 'function scheduleFree('), '批次结束后延迟归还显存')
ok(has(host, 'cancelScheduledFree()'), '新任务开始时取消归还（不把热权重卸掉）')
ok(has(host, 'idleExitMin: 15'), '空闲退出默认 15 分钟（此前默认 0 = 永远不退）')
ok(has(host, "'logs.list'") && has(host, "'logs.read'"), '日志清单 / 读取命令')
ok(has(host, 'function saveJobLog('), '任务日志落盘实现')
ok(has(host, '_render.json\')) shotsArg'), '渲染按钮优先用 _render.json（否则静默退化成没有锁脸的 t2v）')

console.log('== 客户端：滚动条与表头 ==')
ok(has(cli, '.mj-boardbar{display:flex'), '故事板表头有样式（此前这个 class 完全没有样式）')
ok(has(cli, '.mj-refresh{display:inline-flex'), '刷新按钮有样式')
ok(has(cli, '.mj-refresh.busy .mj-refi{animation:mjSpin'), '刷新中图标旋转')
ok(has(cli, '.mj-root{scrollbar-width:thin;scrollbar-color:'), 'Firefox 族滚动条写法（否则那边是系统粗条）')
ok(has(cli, '::-webkit-scrollbar-thumb:hover{background:linear-gradient'), 'Chromium 滚动条悬停态')
ok(has(cli, 'scrollbar-gutter:stable'), '预留滚动条槽位（出现/消失不再横向跳一下）')
ok(has(cli, '.mj-shotthumb{animation:mjFade'), '封面只在创建时淡入一次')

console.log('== 客户端：刷新 / 日志 / 防闪 ==')
ok(has(cli, 'const refreshAll = React.useCallback'), '有 refreshAll')
ok(has(cli, 'onClick: refreshAll'), '刷新按钮接到 refreshAll')
ok(has(cli, 'onClick: openLogs'), '日志按钮接到 openLogs')
ok(has(cli, 'logView ? h(Modal'), '有日志查看弹窗')
ok(has(cli, 'const refreshingRef = React.useRef(false)'), '刷新有重入保护（连点不会刷屏）')
ok(has(cli, 'function rowSignature('), '行数据按内容签名记忆化')
ok(has(cli, 'const rowsSig = rowSignature(proj, prod, job, qcRep)'), '签名作为 useMemo 依赖（对象引用变了不该重画）')
ok(!has(cli, '[proj, prod, job, qcRep, jobRunning],\n\t\t\t);'), '不再按对象引用记忆化行数据')
ok(has(cli, 'comfyAction("free")'), 'ComfyUI 页有「释放显存」按钮')
ok(has(cli, 'decoding: "async"'), '图片用异步解码（不阻塞首屏绘制）')

console.log('== 客户端：日志分段 / 倒序 / 危险操作 ==')
ok(has(cli, 'function splitLogSections('), '日志按「阶段 → 镜头」两级分段')
ok(has(cli, 'function LogSections('), '分段渲染组件')
ok(has(cli, '/^\\s*━+\\s*阶段\\s*(.+?)\\s*━+\\s*$/.exec(L)'), '认得管线阶段标记 ━━━ 阶段 X ━━━')
ok(has(cli, 'const mh = /^\\[(\\d+)\\/(\\d+)\\]\\s+(\\S+)/.exec(L)'), '认得渲染镜头标记 [3/15] s03')
ok(has(cli, 'sections: splitLogSections(shown)'), '活日志面板走分段渲染')
ok(has(cli, 'sections: splitLogSections(logTailLines(logView.text))'), '日志弹窗走分段渲染')
ok(has(cli, 'const [logReverse, setLogReverse] = React.useState(true)'), '日志弹窗默认倒序（最新在上）')
ok(has(cli, 'const [liveReverse, setLiveReverse] = React.useState(false)'), '活日志面板有正/倒序开关')
ok(has(cli, 'el.scrollTop = liveReverse ? 0 : el.scrollHeight'), '倒序时自动吸顶、正序时吸底')
ok(has(cli, 'function logTailLines('), '只渲染日志尾部（几百 KB 的日志不塞满 DOM）')
ok(has(cli, '.mj-lsech{position:sticky'), '阶段标题吸顶且高对比')
ok(has(cli, '.mj-lsub{border-left'), '镜头块用左竖线区分')
ok(has(cli, 'const [purgeArm, setPurgeArm] = React.useState(false)'), '「直接删除」两步确认的上膛状态')
ok(has(cli, 'doPurgeConfirmed(confirm.id)'), '接上宿主 purge')
ok(has(cli, 'className: "mj-btn danger"'), '直接删除用危险按钮样式')
ok(has(cli, '.mj-btn.danger.armed{'), '上膛后变实心红并脉动')
ok(has(host, "'purge'"), '宿主有 purge 命令')
ok(has(host, '拒绝删除：目标不是项目根目录的直接子目录'), 'purge 只允许删根目录的直接子目录')
ok(has(host, '该项目还有任务在跑'), 'purge 拒绝删除正在跑任务的项目')

console.log('== 分段函数的行为验证（喂真实管线日志）==')
{
  // 把 splitLogSections 从客户端源码里抽出来单独跑 —— 只断言"函数存在"太弱，
  // 这一段要证明它真的能把「哪一步」与「这一步的第几镜」分开。
  function extractFn(name) {
    const i = cli.indexOf('function ' + name + '(')
    if (i < 0) return null
    let depth = 0
    let started = false
    for (let k = i; k < cli.length; k++) {
      const ch = cli[k]
      if (ch === '{') { depth += 1; started = true } else if (ch === '}') {
        depth -= 1
        if (started && depth === 0) return cli.slice(i, k + 1)
      }
    }
    return null
  }
  const fnSrc = extractFn('splitLogSections')
  ok(!!fnSrc, '能从源码里抽出 splitLogSections')
  if (fnSrc) {
    const split = new Function(fnSrc + '; return splitLogSections;')()
    const sample = [
      '项目 jixin-wendao | 镜头 15 | 输出 D:\\Ai\\漫剧\\jixin-wendao',
      '━━━ 阶段 环境 ━━━',
      '  环境就绪',
      '━━━ 阶段 渲染 ━━━',
      '[1/15] s01  1344x768 124帧 8步 seed=20260927 euler | ref2va 参考图1张(match)',
      '    加速: PDD nfe=8    VAE: int8',
      '    [s01] 渲染中 30s ...',
      '    完成 323.4s  1.22 MB',
      '[2/15] s02  1344x768 124帧 8步 seed=20260934 euler | ref2va 参考图2张(match)',
      '    完成 312.3s  1.49 MB',
      '━━━ 阶段 质检 ━━━',
      '质检：15 镜，全部通过',
    ]
    const secs = split(sample)
    const titles = secs.map((x) => x.title)
    console.log('    分段结果 → ' + JSON.stringify(titles))
    ok(titles.join('|') === '启动|环境|渲染|质检', '四个阶段被正确切开', titles.join('|'))
    ok(secs[0].lines.length === 1, '首段归属「启动」（阶段标记之前的行）')
    const render = secs.filter((x) => x.title === '渲染')[0]
    ok(!!render && render.subs.length === 2, '渲染阶段里切出 2 个镜头块', render ? String(render.subs.length) : 'none')
    ok(!!render && render.subs[0].title === '镜头 s01' && render.subs[0].total === '15',
      '镜头块标题与进度取自 "[1/15] s01"', render ? JSON.stringify(render.subs[0].title) + '/' + render.subs[0].total : 'none')
    ok(!!render && render.subs[0].lines.length === 3, '镜头块内挂住该镜自己的 3 行输出',
      render ? String(render.subs[0].lines.length) : 'none')
    ok(!!render && render.lines.filter((L) => L.trim()).length === 0, '渲染阶段的直属行只剩空行（都归到镜头块里了）')
    // 纯渲染日志（没有阶段标记）也要能分段：必须**按镜头平铺**，而不是全塞进一个壳里
    const only = split(sample.slice(4, 10))
    ok(only.length === 2 && only[0].title === '镜头 s01' && only[1].title === '镜头 s02',
      '没有阶段标记的纯渲染日志按镜头平铺为顶层分段', only.map((x) => x.title).join('|'))
  }
}

console.log('== 表头排版 / 质检报告契约 / 接镜 ==')
ok(has(cli, '.mj-phtitle{flex:0 1 auto'), '面板标题 nowrap + 省略号（窄列里不该折成两行）')
ok(has(cli, '.mj-ph{display:flex') && cli.indexOf('.mj-ph{display:flex') >= 0
  && /\.mj-ph\{[^}]*flex-wrap:nowrap/.test(cli), '表头 nowrap（否则 224px 里会挤爆）')
ok(has(cli, '.mj-refresh.ic{'), '刷新按钮有紧凑图标版（窄列用）')
ok(has(cli, 'className: "mj-refresh ic"'), '成品列表用图标版刷新（标题+计数+按钮在 224px 里塞不下）')
ok(has(cli, '.mj-ph>.mj-row,.mj-ph>.mj-tag,.mj-ph>.mj-fill{flex:0 0 auto'), '表头右侧槽位不参与压缩')
// 质检报告契约：客户端读 qc.byFile[sid].ok 判合格/不合格，
// 少写这个字段会让**全部镜头显示不合格**（真踩过）
ok(py.indexOf('rec["ok"] = len(rec["problems"]) == 0') >= 0, '驱动器写 ok 字段（故事板判合格/不合格的唯一依据）')
ok(py.indexOf('"warned": warned') >= 0, '质检报告顶层带 warned')
ok(py.indexOf('def extract_last_frame(') >= 0, '有末帧抽取（镜间衔接用）')
ok(py.indexOf('chain_from_prev') >= 0, '接镜开关：把上一镜末帧钉在本镜第 0 帧')
ok(py.indexOf('"guides"') >= 0 || py.indexOf('one["guides"]') >= 0, '接镜通过 guides 接线')
ok(py.indexOf('def dry_run_graphs(') >= 0, 'render --dry-run：构图检查不提交')
// 字幕窗口必须扣掉叠化时被下一镜吃掉的尾部，否则转场处两条字幕同时在屏
ok(host.indexOf('const tailTrim = Number(o.tailTrim) || 0') >= 0, '宿主 buildAss 支持 tailTrim')
ok(/tailTrim: transition === 'fade' \? F : 0/.test(host), '宿主叠化时传入转场时长作为 tailTrim')

console.log('== 独立封面（不许拿主角当封面）==')
ok(has(host, 'async function coverOf('), '有封面读取（project.json 的 cover 字段 + cover.png 兜底）')
ok(has(host, 'function coverBrief('), '有封面提示词构造')
ok(has(host, 'async function genCover('), '有封面生成（Krea-2）')
ok(has(host, "'cover.gen'"), '有 cover.gen 命令')
ok(has(host, 'async function ensureCover('), '资产阶段会顺带补封面')
ok(has(host, "const order = ['scenes', 'props']"), '没有独立封面时退回场景/道具图 —— **角色定妆照不在兜底链里**')
ok(!/KINDS\[k\][\s\S]{0,200}cover = normRel/.test(host), 'summary 的封面兜底不再走 KINDS（那里面第一个就是 characters）')
ok(has(cli, 'doGenCover'), '界面有生成封面入口')
ok(has(cli, 'cover.gen'), '界面调用 cover.gen')
ok(has(cli, '"重做封面"'), '已有封面时菜单项变「重做封面」')
ok(has(py, 'def cover_brief('), '驱动器也有封面提示词')
ok(has(py, 'def gen_cover('), '驱动器能生成封面')
ok(has(py, 'COVER_W, COVER_H = 1344, 768'), '封面取 16:9 横版（列表缩略图 56×32 的同比例）')
ok(has(py, 'SETTING — drawn from this series'), '封面取材于作品自己的场景设计')
ok(has(host, 'SETTING — drawn from this series'), '宿主同样取材于作品场景')
// 提示词里绝不能出现片名：写进去模型会把字画到图上（实测中招）
ok(!/coverBrief[\s\S]{0,900}for the episode "/.test(host), '封面提示词不写片名（写了模型就会画字）')
ok(!/cover_brief[\s\S]{0,900}for the episode/.test(py), '驱动器封面提示词同样不写片名')

console.log('== 封面防拼贴 / 普通话锁 ==')
// 实测教训：给两个场景，模型会画成四宫格拼贴（一眼模板货），光写 no collage 压不住
ok(has(py, 'single continuous photographic frame'), '驱动器要求"单张连续画面"')
ok(has(py, 'no panels, no insets, no divided sections'), '明确禁止分格/内嵌/切块')
ok(has(py, 'no multiple views of different places'), '明确禁止多视角拼图')
ok(/for s in \(\(plan or \{\}\)\.get\("scenes"\) or \[\]\)\[:1\]/.test(py), '封面**只取一个场景**（两个必拼贴）')
ok(has(host, 'no panels, no insets, no divided sections'), '宿主同样禁止分格')
ok(has(host, 'scenes.length < 1'), '宿主同样只取一个场景')
// H3 靠 <d> 语言标记决定说什么语言；工作台还会补一段 MANDARIN ONLY 压口音与即兴外语，
// 驱动器原来直写提示词绕过了它 —— 口径必须一致
ok(has(py, 'def ensure_mandarin('), '驱动器有普通话锁')
ok(has(py, 'one["prompt"] = ensure_mandarin('), 'sync 写 prompt 时过普通话锁')
ok(has(py, 'MANDARIN ONLY (mandatory language rule)'), '锁的文案与工作台一致')

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail)
process.exit(fail ? 1 : 0)
