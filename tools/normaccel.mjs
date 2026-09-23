import fs from 'node:fs'
// 从插件源码里抠出 normAccel 直接跑（真函数，不是复制品）
const src = fs.readFileSync('D:/Ai/DSH-plugins/dsh-manju-studio/lib/index.js', 'utf8')
const m = src.match(/function normAccel\(accel, nfe\) \{[\s\S]*?\n  \}/)
if (!m) { console.log('抠不出 normAccel'); process.exit(1) }
const normAccel = new Function('return ' + m[0].replace('function normAccel', 'function'))()
const cases = [
  ['pdd', 4, 'pdd4'], ['pdd', 6, 'pdd6'], ['pdd', 8, 'pdd8'], ['pdd', undefined, 'pdd8'],
  ['pdd', 99, 'pdd8'], ['pdd8', undefined, 'pdd8'], ['turbo4', undefined, 'turbo4'],
  ['none', undefined, 'none'], [undefined, undefined, 'pdd8'], ['garbage', undefined, 'pdd8'],
]
let bad = 0
for (const [a, n, want] of cases) {
  const got = normAccel(a, n)
  const pass = got === want
  if (!pass) bad++
  console.log((pass ? '  PASS ' : '  FAIL ') + 'normAccel(' + JSON.stringify(a) + ', ' + JSON.stringify(n) + ') = ' + got + (pass ? '' : '  期望 ' + want))
}
console.log(bad ? 'FAILED ' + bad : '  全部通过')
process.exit(bad ? 1 : 0)