/**
 * 发布前自审（按知识库的漫剧规范逐条量产出，不靠感觉）
 *
 * 检查项全部来自知识库，每一条都能被机器判定：
 *   《官方风格技能与漫剧优化》字幕规则：单行 ≤32 字符、同屏仅一行（不折行）、字幕要淡入
 *   《漫剧创作规范》/H3 帧网格：每镜帧数落在 17k+5、台词 ≤20 字
 *   《漫剧智能体…》拼接 5 锁：切点对齐节拍网格（帧网格）、续镜尾帧作首帧（guides）
 *   字幕重叠：转场处两条字幕同时在屏 = 观众读作"不连贯"（踩过的真实事故）
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 "DSH Desktop.exe" manju-audit-test.mjs [项目id]
 * 默认项目 tingguiren；项目不存在则跳过（不误报）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PID = process.argv[2] || 'tingguiren'
// 第二参数 = 集号（项目内分集）。给了就只审那一集的成片与字幕。
const EP = (process.argv[3] || '').trim()
const DIR = path.join('D:\\Ai\\漫剧', PID)
const FF = 'ffprobe'

let pass = 0
let fail = 0
let skip = 0
function ok(cond, msg, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + msg) } else { fail += 1; console.log('  FAIL ' + msg + (extra ? '  ← ' + extra : '')) }
}
function skipped(msg) { skip += 1; console.log('  – ' + msg) }

const vwidth = (s) => {
  let w = 0
  for (const ch of String(s || '')) w += ch.codePointAt(0) < 0x2e80 ? 0.5 : 1
  return w
}
const tsec = (t) => {
  const p = String(t).split(/[:.]/)
  return Number(p[0]) * 3600 + Number(p[1]) * 60 + Number(p[2]) + Number(p[3] || 0) / 100
}

console.log('== 发布前自审：' + PID + (EP ? ' · ' + EP : '') + ' ==')
if (!fs.existsSync(DIR)) { skipped('项目不存在：' + DIR); console.log('\n结果：PASS=' + pass + ' FAIL=' + fail + ' SKIP=' + skip); process.exit(0) }

// ── 1. 字幕规则（知识库：单行 ≤32、同屏一行、淡入）──
const assPath = path.join(DIR, 'output', EP ? 'final-' + EP + '.ass' : 'final.ass')
if (!fs.existsSync(assPath)) {
  skipped('还没有 final.ass（先 compose）')
} else {
  const lines = fs.readFileSync(assPath, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('Dialogue:'))
  const evs = lines.map((l) => { const p = l.split(','); return { s: tsec(p[1]), e: tsec(p[2]), text: p.slice(9).join(',') } })
  ok(evs.length > 0, '有字幕（' + evs.length + ' 条）')
  // 去掉特效标签后量宽度
  const tooWide = evs.filter((x) => vwidth(x.text.replace(/\{[^}]*\}/g, '')) > 32)
  ok(tooWide.length === 0, '单行 ≤32 全角（KB 字幕上限）', tooWide.length + ' 条超标')
  const wrapped = evs.filter((x) => x.text.indexOf('\\N') >= 0)
  ok(wrapped.length === 0, '无折行（KB：同屏仅一行）', wrapped.length + ' 条折行')
  const noFade = evs.filter((x) => !/\{[^}]*\\fad\(/.test(x.text))
  ok(noFade.length === 0, '每条字幕都有淡入（KB 漫剧字幕规则：淡入而非硬切）', noFade.length + ' 条无淡入')
  let ov = 0
  for (let i = 0; i < evs.length - 1; i++) if (evs[i + 1].s < evs[i].e - 0.001) ov += 1
  ok(ov === 0, '字幕无重叠（转场处两条同时在屏 = 观众读作不连贯）', ov + ' 处重叠')
}

// ── 2. 帧网格 + 台词长度（知识库：17k+5 网格、台词 ≤20 字）──
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'plan.meta.json'), 'utf8'))
const allShots = meta.shots || []
const shots = EP ? allShots.filter((s) => String(s.episode || '') === EP) : allShots
ok(shots.length > 0, (EP ? EP + ' ' : '') + '有镜头（' + shots.length + '）')
const badLen = shots.filter((s) => (s.length - 5) % 17 !== 0)
ok(badLen.length === 0, '每镜帧数落在 17k+5 网格', badLen.map((s) => s.id + '=' + s.length).join(','))
const longLine = []
for (const s of shots) for (const d of (s.dialogue || [])) if (vwidth(d.text) > 20) longLine.push(s.id)
ok(longLine.length === 0, '单句台词 ≤20 字（KB 漫剧创作规范）', longLine.join(','))

// ── 3. 拼接锁：接镜（续镜尾帧作首帧）──
const rdoc = path.join(DIR, EP ? '_render-' + EP + '.json' : '_render.json')
const render = fs.existsSync(rdoc) ? JSON.parse(fs.readFileSync(rdoc, 'utf8')) : null
if (render) {
  const chained = (render.shots || []).filter((s) => (s.guides || []).length).map((s) => s.id)
  ok(chained.length > 0, '至少一镜用了"续镜尾帧作首帧"（KB 拼接 5 锁之一）：' + (chained.join(',') || '无'))
  const refAll = (render.shots || []).every((s) => s.mode === 'r2v')
  ok(refAll, '全部镜头都带参考图（Ref2VA 锁脸）')
} else { skipped('没有 _render.json（先 sync）') }

// ── 4. 成片规格（漫剧档 60~90 秒）──
const final = path.join(DIR, EP ? '成片-' + EP + '.mp4' : '成片.mp4')
if (!fs.existsSync(final)) { skipped('还没有成片.mp4') } else {
  const r = spawnSync(FF, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', final], { encoding: 'utf8' })
  const j = JSON.parse(r.stdout || '{}')
  const dur = Number(j.format && j.format.duration)
  const v = (j.streams || []).find((s) => s.codec_type === 'video')
  const a = (j.streams || []).find((s) => s.codec_type === 'audio')
  ok(dur >= 55 && dur <= 95, '成片时长 ' + dur.toFixed(1) + 's 落在漫剧档 60~90s 区间（±宽容）')
  ok(!!v && v.width % 32 === 0 && v.height % 32 === 0, '分辨率 ' + (v ? v.width + 'x' + v.height : '?') + ' 是 32 的倍数')
  ok(!!a, '有音轨（H3 原生立体声）')
}

console.log('\n结果：PASS=' + pass + ' FAIL=' + fail + ' SKIP=' + skip)
process.exit(fail ? 1 : 0)
