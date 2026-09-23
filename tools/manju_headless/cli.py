# -*- coding: utf-8 -*-
"""命令行入口：参数解析 + 调度（**薄**：业务逻辑都在上面各模块里）。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import argparse
import os
import sys
import time

from .assets import cmd_assets
from .comfy import cmd_comfy
from .compose import cmd_compose
from .cover import cmd_cover
from .paths import project_path
from .procs import ACTIVE, _Tee, write_active
from .project import cmd_absorb, cmd_build, cmd_episodes, cmd_logs, cmd_status
from .qc import cmd_qc
from .render import cmd_render
from .sync import cmd_sync
from .voice import cmd_voice

def main():
    ap = argparse.ArgumentParser(prog="manju-headless", description="漫剧工作台无头驱动器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="plan.meta.json + prompts/*.txt → plan.json")
    b.add_argument("--project", required=True)
    b.set_defaults(func=cmd_build)

    a = sub.add_parser("assets", help="Krea-2 生成缺失的定妆照/场景图（顺带补独立封面）")
    a.add_argument("--project", required=True)
    a.add_argument("--only", nargs="*", help="只生成这些 id")
    a.add_argument("--force", action="store_true")
    a.add_argument("--seed", type=int, default=0)
    a.add_argument("--no-cover", dest="no_cover", action="store_true", help="跳过封面")
    a.add_argument("--force-cover", dest="force_cover", action="store_true", help="重做已有封面")
    a.set_defaults(func=cmd_assets)

    cv = sub.add_parser("cover", help="只生成/重做项目封面（独立封面，非人物定妆照）")
    cv.add_argument("--project", required=True)
    cv.add_argument("--force", action="store_true")
    cv.set_defaults(func=cmd_cover)

    # ── 子命令注册 ──
    ab = sub.add_parser("absorb", help="把一个独立项目吸收成本项目的某一集")
    ab.add_argument("--project", required=True, help="目标（主）项目")
    ab.add_argument("--source", required=True, help="要被吸收的项目")
    ab.add_argument("--episode", required=True, help="集号，如 ep02")
    ab.set_defaults(func=cmd_absorb)

    ep = sub.add_parser("episodes", help="列出本项目的分集概况")
    ep.add_argument("--project", required=True)
    ep.set_defaults(func=cmd_episodes)

    vo = sub.add_parser("voice", help="语音验收：转写成片音轨并与剧本台词逐条比对")
    vo.add_argument("--project", required=True)
    vo.add_argument("--episode", default="")
    vo.add_argument("--model", default="medium", help="whisper 模型，默认 medium")
    vo.add_argument("--min-sim", dest="min_sim", type=float, default=0.6, help="判定阈值，默认 0.6")
    vo.set_defaults(func=cmd_voice)

    s = sub.add_parser("sync", help="解析参考图 → _render.json")
    s.add_argument("--project", required=True)
    s.add_argument("--episode", default="", help="只同步这一集（shots.json 仍写全本）")
    s.set_defaults(func=cmd_sync)

    r = sub.add_parser("render", help="调 manju.py 渲染")
    r.add_argument("--project", required=True)
    r.add_argument("--force", action="store_true")
    r.add_argument("--only", nargs="*", help="只重渲这些镜头 id（单镜返修，隐含 --force）")
    r.add_argument("--out", default=None, help="产物目录（默认项目目录；A/B 对比时指向别处）")
    r.add_argument("--no-free", dest="no_free", action="store_true", help="渲染后不归还 ComfyUI 显存")
    r.add_argument("--dry-run", dest="dry_run", action="store_true",
                   help="只构图检查（不提交渲染）：0 秒内暴露参数/接线错误")
    r.add_argument("--episode", default="", help="只渲染这一集")
    r.set_defaults(func=cmd_render)

    q = sub.add_parser("qc", help="机械质检")
    q.add_argument("--project", required=True)
    q.set_defaults(func=cmd_qc)

    c = sub.add_parser("compose", help="字幕 + 响度归一 + faststart 合成")
    c.add_argument("--project", required=True)
    c.add_argument("--transition", default=None, choices=["cut", "fade"])
    c.add_argument("--loudness", type=float, default=None)
    c.add_argument("--subtitle-size", dest="subtitle_size", type=float, default=None)
    c.add_argument("--range", nargs=2, type=int, default=None, help="只合成这个镜头区间（调试用）")
    c.add_argument("--intro", action="store_true", help="加片头卡（片名 + 集名，取自 project.json）")
    c.add_argument("--intro-seconds", dest="intro_seconds", type=float, default=3.0)
    c.add_argument("--no-subtitles", dest="no_subtitles", action="store_true")
    c.add_argument("--episode", default="", help="只合成这一集 → 成片-<集>.mp4")
    c.set_defaults(func=cmd_compose)

    st = sub.add_parser("status", help="项目状态")
    st.add_argument("--project", required=True)
    st.set_defaults(func=cmd_status)

    cf = sub.add_parser("comfy", help="ComfyUI 资源治理（status/free/stop/start）")
    cf.add_argument("action", choices=["status", "free", "stop", "start"])
    cf.add_argument("--project", default="")
    cf.set_defaults(func=cmd_comfy)

    lg = sub.add_parser("logs", help="列出/查看已落盘的任务日志")
    lg.add_argument("--project", required=True)
    lg.add_argument("--name", default="", help="指定日志文件名（缺省看最新一份）")
    lg.add_argument("--tail", type=int, default=60)
    lg.set_defaults(func=cmd_logs)

    args = ap.parse_args()
    # 每个子命令的输出都落一份到 <项目>/output/logs/：
    # 渲染为什么慢、质检报了哪一条，都是事后才要查的东西，
    # 只留在终端里等于没有。logs 命令自己不再落盘（否则看日志会生成日志）。
    raw_out = sys.stdout
    raw_err = sys.stderr
    logf = None
    jp = getattr(args, "project", "") or ""
    if args.cmd != "logs" and jp and os.path.isdir(project_path(jp)):
        try:
            logdir = project_path(jp, "output", "logs")
            os.makedirs(logdir, exist_ok=True)
            stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
            logpath = os.path.join(logdir, "%s-%s.log" % (args.cmd, stamp))
            logf = open(logpath, "w", encoding="utf-8")
            sys.stdout = _Tee(raw_out, logf)
            sys.stderr = _Tee(raw_err, logf)
            # 登记全局活动：工作台据此显示实时日志（含命令行发起的渲染）
            ACTIVE.update({
                "project": jp, "cmd": args.cmd, "startedAt": time.time(),
                "iso": time.strftime("%Y-%m-%d %H:%M:%S"),
                "rel": "%s/output/logs/%s" % (jp, os.path.basename(logpath)),
                "argv": " ".join(sys.argv[1:]),
            })
            write_active(ACTIVE)
        except Exception:
            logf = None
    code = 0
    try:
        code = args.func(args) or 0
    finally:
        if logf:
            try:
                sys.stdout.flush()
                logf.close()
            except Exception:
                pass
            sys.stdout = raw_out
            sys.stderr = raw_err
            # 收尾：把结束时间与退出码写回活动记录（界面据此判断"跑完了/失败了"）
            ACTIVE.update({"endedAt": time.time(), "code": code})
            write_active(ACTIVE)
            raw_out.write("[log] 已落盘：" + logpath + "\n")
    return code
