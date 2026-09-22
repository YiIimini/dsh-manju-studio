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
const host = fs.readFileSync(HOST, 'utf8')
const cli = fs.readFileSync(CLIENT, 'utf8')

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

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail)
process.exit(fail ? 1 : 0)
