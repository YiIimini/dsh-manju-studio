# -*- coding: utf-8 -*-
"""机械质检：时长/音轨/分辨率/响度/黑场占比/削波。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import os
import re
import time

from .jsonio import write_json
from .media import clips_of, ffprobe_one
from .paths import FFMPEG, need_project, project_path
from .procs import run

def qc_one(path, min_duration=1.0, dark_fail=0.5, dark_warn=0.15, clip_fail=-0.1):
    rec = {"file": os.path.basename(path), "problems": [], "warnings": [], "ok": False}
    info = ffprobe_one(path)
    if not info:
        rec["problems"].append("ffprobe 读不出（文件损坏？）")
        return rec
    rec.update(info)
    if not info["has_audio"]:
        rec["problems"].append("无音轨（H3 产物应自带 32kHz 立体声）")
    if info["duration"] < min_duration:
        rec["problems"].append("时长过短 %.2fs" % info["duration"])
    if (info["width"] or 0) % 32 or (info["height"] or 0) % 32:
        rec["problems"].append("分辨率非 32 倍数")
    # 响度 / 削波
    code, out, err = run([FFMPEG, "-hide_banner", "-i", path, "-af", "volumedetect",
                          "-f", "null", "-"], timeout=300)
    txt = out + err
    m = re.search(r"mean_volume:\s*(-?[\d.]+)", txt)
    p = re.search(r"max_volume:\s*(-?[\d.]+)", txt)
    rec["mean_volume"] = float(m.group(1)) if m else None
    rec["max_volume"] = float(p.group(1)) if p else None
    if rec["mean_volume"] is not None and rec["mean_volume"] < -60:
        rec["problems"].append("疑似静音（mean_volume=%.1f）" % rec["mean_volume"])
    if rec["max_volume"] is not None and rec["max_volume"] >= clip_fail:
        rec["warnings"].append("音频削波风险（峰值 %.1f dB）" % rec["max_volume"])
    # 黑场占比
    code, out, err = run([FFMPEG, "-hide_banner", "-i", path, "-vf",
                          "blackdetect=d=0.1:pix_th=0.10", "-an", "-f", "null", "-"], timeout=300)
    blacks = [float(x) for x in re.findall(r"black_duration:([\d.]+)", out + err)]
    ratio = (sum(blacks) / info["duration"]) if info["duration"] else 0
    rec["dark_ratio"] = round(ratio, 3)
    if ratio >= dark_fail:
        rec["problems"].append("黑场占比 %.0f%%" % (ratio * 100))
    elif ratio >= dark_warn:
        rec["warnings"].append("黑场占比 %.0f%%" % (ratio * 100))
    # **`ok` 是工作台故事板判"合格/不合格"的唯一依据**（客户端读 qc.byFile[sid].ok）。
    # 漏了它 → undefined → 全部镜头显示"不合格"。工作台自己的 qcOneClip 也写这个字段
    # （lib/index.js 的 rec.ok = rec.problems.length === 0），必须一致。
    rec["ok"] = len(rec["problems"]) == 0
    return rec


def cmd_qc(args):
    pid = args.project
    need_project(pid)
    clips = [c for c in clips_of(pid) if not c["final"] and not c["take"]]
    if not clips:
        raise SystemExit("没有可质检的镜头")
    reports, bad, warned = [], 0, 0
    print("%-8s%8s%12s%8s%9s%7s  %s" % ("镜头", "时长", "分辨率", "帧数", "均值dB", "黑场", "问题"))
    for c in clips:
        rec = qc_one(project_path(pid, c["name"]))
        reports.append(rec)
        if rec["problems"]:
            bad += 1
        if rec["warnings"]:
            warned += 1
        print("%-8s%8.2f%12s%8s%9s%7s  %s" % (
            c["shot"], rec.get("duration", 0),
            "%sx%s" % (rec.get("width"), rec.get("height")), rec.get("nb_frames") or "-",
            ("%.1f" % rec["mean_volume"]) if rec.get("mean_volume") is not None else "-",
            ("%.0f%%" % (rec.get("dark_ratio", 0) * 100)),
            "；".join(rec["problems"] + rec["warnings"]) or "OK"))
    write_json(project_path(pid, "output", "qc_report.json"),
               {"total": len(reports), "failed": bad, "warned": warned, "reports": reports,
                "checkedAt": time.strftime("%Y-%m-%d %H:%M:%S")})
    print("\n质检：%d 镜，%s" % (len(reports), "全部通过" if bad == 0 else "%d 镜不合格" % bad))
    print("提醒：脚本查不出「人物崩了/风格跑偏」——画面必须抽帧后用视觉亲自看。")
    return 0 if bad == 0 else 1
