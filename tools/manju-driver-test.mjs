/**
 * 驱动器行为锁的套件包装（真正的断言在 driver_probe.py —— 被测代码是 Python）。
 *
 * 为什么要有这条：`tools/manju-headless.py` 是 2100+ 行的历史累积文件，里面每一条行为
 * 都是踩出来的（接镜只在段内开、字幕尾部要扣掉叠化时长、普通话锁、封面不许拼贴…）。
 * 把它按能力拆成 tools/manju_headless/ 包时，**行为不能变** ——
 * 而"没变"只能靠断言证明，不能靠"我看着搬对了"。
 *
 * 这条套件同时锁两件事：
 *   1. 入口模块（tools/manju-headless.py）**仍然暴露那些公开名**（老脚本与文档依赖它）；
 *   2. 纯函数与四条子命令的实际输出（含字幕卡四类、接镜规则、dry-run 构图）。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "DSH Desktop.exe" tools/manju-driver-test.mjs（或 tools\check.cmd）
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PY = 'D:\\Ai\\ComfyUI\\standalone-env\\python.exe'
const PROBE = path.join(HERE, 'driver_probe.py')

const r = spawnSync(PY, ['-X', 'utf8', PROBE], { encoding: 'utf8', timeout: 900000 })
process.stdout.write(r.stdout || '')
if (r.stderr) process.stderr.write(r.stderr)
process.exit(r.status === 0 ? 0 : 1)
