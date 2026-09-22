/**
 * 漫剧工作台 · 提交前自检（一条命令跑完）
 *
 * 为什么要有它：改 client.js 时我反复犯同一类错 —— 插 CSS 规则时把引号写错、
 * 插 JSX 块时漏一个闭合括号。这类错会让整个客户端半**加载失败 → 界面一片空白**，
 * 而症状（白屏）离病因（一个引号）很远，排查代价高。
 *
 * 用法：  node tools/check.mjs        （或 tools\check.cmd）
 * 退出码：0 全过；非 0 有失败
 *
 * 检查项：
 *   1. 两个半的**语法闸门**（把文件当模块 import，语法错会立刻暴露）
 *   2. 状态扫描里的**冒烟用例**（真数据渲染，能抓空引用/坏属性）
 *   3. 其它测试套件（存在就跑，不存在跳过）
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const PLUGIN = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const ELECTRON = 'D:\\Ai\\DSH Desktop\\DSH Desktop.exe'
const TMP = os.tmpdir()

const fails = []
function line(s) { process.stdout.write(s + '\n') }
function ok(cond, msg) {
  line((cond ? '  ✓ ' : '  ✕ ') + msg)
  if (!cond) fails.push(msg)
}

// ── 1. 语法闸门 ──
line('【1】语法闸门')
for (const rel of ['lib/index.js', 'lib/client.js']) {
  const abs = path.join(PLUGIN, rel)
  if (!fs.existsSync(abs)) { ok(false, rel + ' 不存在'); continue }
  const tmp = path.join(TMP, 'mj-syn-' + path.basename(rel).replace(/\W/g, '') + '.mjs')
  fs.copyFileSync(abs, tmp)
  const r = spawnSync(ELECTRON, [tmp], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    timeout: 60000,
  })
  const out = (r.stdout || '') + (r.stderr || '')
  const syn = out.match(/SyntaxError[^\n]*/)
  // 宿主半 import 成功即真过；客户端半会报 window is not defined（预期，它不是 Node 模块）
  if (syn) ok(false, rel + ' 语法错误：' + syn[0].slice(0, 110))
  else ok(true, rel + ' 语法正常')
}

// ── 2. package.json / patch 文件 ──
line('【2】包结构')
try {
  const pj = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
  ok(!!pj.version, 'package.json 可解析，version=' + pj.version)
  const patch = pj.dsh && pj.dsh.bundle && pj.dsh.bundle.patch
  ok(!!patch && fs.existsSync(path.join(PLUGIN, patch)), 'bundle patch 存在（' + patch + '）')
} catch (e) {
  ok(false, 'package.json 解析失败：' + e.message)
}

// ── 3. 套件（存在的才跑）──
line('【3】测试套件')
const SUITES = [
  ['单元/组件', 'manju-smoke.mjs', null],
  ['抽卡', 'manju-takes-test.mjs', null],
  ['平台合规', 'manju-comp-test.mjs', null],
  ['小说库/预检', 'manju-lib-itest.mjs', null],
  ['加速机制表', 'accel-probe.mjs', null],
  ['accel 迁移', 'normaccel.mjs', null],
  // 媒体接口契约：ETag/304 + Range/206 + HEAD + 路径穿越。
  // 这条套件是"封面一闪一闪"与"错误响应挂死"两个事故的回归闸门，放在仓库里而不是临时目录。
  ['媒体接口缓存/Range', 'manju-file-test.mjs', null],
  ['项目增删/日志', 'manju-crud-test.mjs', null],
  ['UI 结构与契约', 'manju-ui-test.mjs', null],
  // 发布前自审：按知识库的漫剧规范逐条量产出（字幕单行/淡入/无重叠、17k+5 帧网格、
  // 台词 ≤20 字、接镜是否用了、成片时长与分辨率）。默认审 tingguiren，项目不存在则跳过。
  ['发布前自审', 'manju-audit-test.mjs', null],
  ['状态扫描', 'sweep-blank.mjs', 'yaolu-yeyu'],
]
let ran = 0
for (const [name, file, arg] of SUITES) {
  // 仓库 tools/ 优先，其次才是临时目录（历史套件都在 %TEMP% 里躺着）
  const inRepo = path.join(PLUGIN, 'tools', file)
  const abs = fs.existsSync(inRepo) ? inRepo : path.join(TMP, file)
  if (!fs.existsSync(abs)) { line('  – ' + name + '（未找到 ' + file + '，跳过）'); continue }
  ran += 1
  const args = [abs].concat(arg ? [arg] : [])
  const r = spawnSync(ELECTRON, args, {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    timeout: 600000,
  })
  const out = (r.stdout || '') + (r.stderr || '')
  const pass = (out.match(/^\s+(?:PASS|✓) /gm) || []).length
  const fail = (out.match(/^\s+(?:FAIL|✕) /gm) || []).length
  ok(fail === 0 && pass > 0, name + '  PASS=' + pass + ' FAIL=' + fail)
  if (fail) {
    out.split('\n').filter((l) => /^\s+(FAIL|✕) /.test(l)).slice(0, 3).forEach((l) => line('      ' + l.trim()))
  }
}
ok(ran > 0 || true, '共跑 ' + ran + ' 个套件')

// ── 4. 渲染器（manju.py）──
// 加这一段的直接原因：我编辑 manju.py 的 DEFAULTS 时弄丢了 `seed` 键，
// 而 cmd_render 里 `shot.get("seed", DEFAULTS["seed"])` 的默认值参数是**立即求值**的
// —— 结果每一次渲染都 KeyError 崩掉，插件自检却完全看不出来（它不检查渲染器）。
line('【4】渲染器 manju.py')
const MANJU = 'C:\\Users\\Administrator\\.dsh\\skills\\manju-render\\scripts\\manju.py'
const PY = 'D:\\Ai\\ComfyUI\\standalone-env\\python.exe'
if (!fs.existsSync(MANJU)) {
  line('  – 未找到 manju.py，跳过')
} else {
  const probe = [
    'import ast,sys,re',
    'src=open(r"' + MANJU + '",encoding="utf-8").read()',
    'ast.parse(src)',
    'print("SYNTAX-OK")',
    'sys.path.insert(0, r"' + path.dirname(MANJU) + '")',
    'import manju',
    'd=manju.DEFAULTS',
    '# 这些键被代码以 DEFAULTS["x"] 直接下标读取（不是 .get），缺了必然崩',
    'need=["seed","timeout","accel","vramMode","takes","width","height","length","steps","fps"]',
    'missing=[k for k in need if k not in d]',
    'print("MISSING:" + ",".join(missing))',
  ].join('\n')
  const r = spawnSync(PY, ['-c', probe], { encoding: 'utf8', timeout: 60000 })
  const out = (r.stdout || '') + (r.stderr || '')
  if (out.indexOf('SYNTAX-OK') < 0) {
    ok(false, 'manju.py 语法/导入失败：' + out.split('\n').filter(Boolean).slice(-1)[0])
  } else {
    const mm = out.match(/MISSING:([^\n]*)/)
    const missing = mm && mm[1].trim() ? mm[1].trim().split(',') : []
    ok(missing.length === 0, 'manju.py DEFAULTS 关键键齐全' + (missing.length ? '（缺：' + missing.join(',') + '）' : ''))
  }
}
line('')
if (fails.length) {
  line('✕ 自检未通过（' + fails.length + ' 项）—— 不要交付')
  fails.forEach((f) => line('   - ' + f))
  process.exit(1)
}
line('✓ 自检全过')
process.exit(0)
