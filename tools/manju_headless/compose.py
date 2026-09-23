# -*- coding: utf-8 -*-
"""合成：字幕 + 响度归一 + faststart，分集出 成片-<集>.mp4。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import os
import re

from .jsonio import read_json
from .media import clips_of, ffprobe_one, make_intro
from .paths import FFMPEG, need_project, params_of, project_path, render_doc_path
from .procs import run
from .subtitles import build_ass

def cmd_compose(args):
    pid = args.project
    d = need_project(pid)
    meta, params = params_of(pid)
    canvas_w = int(params.get("width") or 1344)
    canvas_h = int(params.get("height") or 768)
    loud = args.loudness if args.loudness is not None else (params.get("loudness") or -16)
    size_pct = args.subtitle_size if args.subtitle_size is not None else (params.get("subtitleSize") or 5)
    transition = args.transition or params.get("transition") or "cut"
    if transition == "dissolve":
        transition = "fade"
    if transition not in ("cut", "fade"):
        transition = "cut"

    clips = [c for c in clips_of(pid) if not c["final"] and not c["take"]]
    # ── 分集合成 ──
    # 按该集的渲染清单选片并**按清单顺序**排列（不靠文件名字典序猜），
    # 产物写 成片-<ep>.mp4 —— 都以「成片」开头，工作台的 clipsOf 会把它当 final 排除掉。
    ep = str(getattr(args, "episode", "") or "").strip()
    out_name = "成片.mp4"
    ass_rel = "output/final.ass"
    if ep:
        rdoc = read_json(render_doc_path(pid, ep), None)
        if not rdoc or not rdoc.get("shots"):
            raise SystemExit("缺少 _render-%s.json —— 先 sync --episode %s" % (ep, ep))
        want = [str(s.get("id")) for s in rdoc["shots"]]
        order = {sid: i for i, sid in enumerate(want)}
        clips = [c for c in clips if c["shot"] in order]
        clips.sort(key=lambda c: order.get(c["shot"], 10 ** 6))
        miss = [sid for sid in want if not any(c["shot"] == sid for c in clips)]
        if miss:
            raise SystemExit("这一集还有 %d 镜没渲染：%s" % (len(miss), "、".join(miss[:8])))
        out_name = "成片-%s.mp4" % ep
        ass_rel = "output/final-%s.ass" % ep
    names = [c["name"] for c in clips]
    if not names:
        raise SystemExit("没有可合成的镜头")
    if args.range:
        lo, hi = args.range

        # 先削掉扩展名再取数字：直接对 "s01.mp4" 抽 \d+ 会把 mp4 里的 4 也捞进来，
        # 得到 "014" = 14，于是 --range 1 1 一个镜头都筛不出来（实测踩过）。
        def shot_num(name):
            m = re.search(r"(\d+)", os.path.splitext(name)[0])
            return int(m.group(1)) if m else 0

        names = [n for n in names if lo <= shot_num(n) <= hi]

    # 片头卡：作为第 1 段参与时长/起点累加，字幕时间轴会自动整体后移 ——
    # 它不在 plan 里，没有台词，所以不产生任何字幕。
    if args.intro:
        card = make_intro(pid, args.intro_seconds, ep)
        if card:
            names = [card] + names

    dur = []
    for nm in names:
        info = ffprobe_one(os.path.join(d, nm))
        dur.append(info["duration"] if info and info.get("duration", 0) > 0 else 5.0)
    F = 0.5
    starts, acc = [], 0.0
    for i in range(len(names)):
        starts.append(acc)
        acc += dur[i] - (F if (transition == "fade" and i < len(names) - 1) else 0)

    plan = read_json(project_path(pid, "plan.json"), None) or {}
    plan_shots = plan.get("shots") or []
    board = []
    for i, nm in enumerate(names):
        sid = nm[:-4]
        hit = next((s for s in plan_shots if str(s.get("id")) == sid), None) or {"id": sid}
        board.append(dict(hit, _dur=dur[i]))

    # **注意别写 `args.no_subtitles is False or True`** —— 那个表达式恒为 True，
    # --no-subtitles 就成了死参数：用户以为出的是无字幕母版，实际拿到烧死字幕的版本（审计发现）。
    want_subs = not args.no_subtitles
    # 叠化时每镜尾部有 F 秒被下一镜吃掉，字幕窗口必须扣掉它，否则两条字幕会同时在屏
    tail_trim = F if (transition == "fade" and len(names) > 1) else 0.0
    built = build_ass(board, starts, canvas_w, canvas_h, size_pct, tail_trim)
    sub_filter = ""
    if built[1] > 0:
        os.makedirs(project_path(pid, "output"), exist_ok=True)
        with open(project_path(pid, ass_rel.replace("/", os.sep)), "w", encoding="utf-8") as fh:
            fh.write(built[0])
        # libass 不认带引号的 Windows 盘符绝对路径 → 用相对路径 + cwd=项目根
        sub_filter = "subtitles=filename=" + ass_rel

    af = "loudnorm=I=%s:TP=-1.5:LRA=11" % loud
    venc = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]
    aenc = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    target = os.path.join(d, out_name)
    # **先编码到临时文件，成功后再原子替换**。
    # 原实现是"先 os.remove(target) 再编码"：这一次 ffmpeg 一旦失败（镜头缺失/滤镜报错/磁盘满），
    # 旧成片已经被删、新成片又没生成 —— 交付物直接消失（审计发现）。
    tmp_target = target + ".tmp.mp4"
    if os.path.isfile(tmp_target):
        try:
            os.remove(tmp_target)
        except OSError:
            pass

    if transition == "cut" or len(names) == 1:
        lst = os.path.join(d, "_concat.txt")
        with open(lst, "w", encoding="utf-8") as fh:
            for nm in names:
                fh.write("file '" + os.path.join(d, nm).replace("\\", "/") + "'\n")
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-f", "concat", "-safe", "0", "-i", lst]
        if sub_filter:
            cmd += ["-vf", sub_filter]
        cmd += venc + ["-af", af] + aenc + ["-movflags", "+faststart", tmp_target]
    else:
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
        for nm in names:
            cmd += ["-i", os.path.join(d, nm)]
        parts, vlab, alab, acc2 = [], "0:v", "0:a", dur[0]
        for i in range(1, len(names)):
            off = max(0.0, acc2 - F)
            parts.append("[%s][%d:v]xfade=transition=fade:duration=%s:offset=%.3f[v%d]"
                         % (vlab, i, F, off, i))
            parts.append("[%s][%d:a]acrossfade=d=%s[a%d]" % (alab, i, F, i))
            vlab, alab = "v%d" % i, "a%d" % i
            acc2 += dur[i] - F
        if sub_filter:
            parts.append("[%s]%s[vsub]" % (vlab, sub_filter))
            vlab = "vsub"
        # 响度归一必须**并进滤镜图**：叠化路径的音轨已经过 filter_complex，
        # 再用 `-af loudnorm` 会撞 "Simple and complex filtering cannot be used
        # together for the same stream" 直接失败（工作台的 fade 分支就有这个隐患，
        # 只是它默认走 cut 才没暴露）。
        parts.append("[%s]%s[aout]" % (alab, af))
        alab = "aout"
        cmd += ["-filter_complex", ";".join(parts), "-map", "[%s]" % vlab, "-map", "[%s]" % alab] \
            + venc + aenc + ["-movflags", "+faststart", tmp_target]

    print("合成 %d 镜 · 转场 %s · 字幕 %d 条（字号 %dpx / 每行最多 %d 全角字）"
          % (len(names), transition, built[1], built[2], built[3]), flush=True)
    code, out, err = run(cmd, cwd=d, timeout=1800)
    if code != 0:
        print((err or out)[-2000:])
        # 失败时**保留**上一版成片（原来会先删掉它，交付物就没了）
        raise SystemExit("ffmpeg 合成失败（退出码 %s）；已保留原有 %s" % (code, out_name if os.path.isfile(target) else "（无）"))
    # 成功才原子替换：os.replace 在同盘上是原子操作，中途断电也不会留下半个成片
    os.replace(tmp_target, target)
    info = ffprobe_one(target)
    print("成片 %s" % target)
    if info:
        print("  %.2fs  %sx%s  %.2f MB" % (info["duration"], info["width"], info["height"],
                                           info["size"] / 1024 / 1024))
    return 0
