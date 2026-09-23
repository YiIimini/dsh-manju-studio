# -*- coding: utf-8 -*-
"""媒体工具：探测、切片清单、末帧抽取、片头卡（ffmpeg）。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import json
import os
import re

from .jsonio import read_json
from .paths import FFMPEG, FFPROBE, params_of, project_path
from .procs import run

def extract_last_frame(pid, clip_rel, dst_rel):
    """抽某一镜的**末帧**存成 jpg —— 用于把它钉到下一镜的第 0 帧（镜间衔接）。"""
    src = project_path(pid, clip_rel.replace("/", os.sep))
    if not os.path.isfile(src):
        return None
    dst = project_path(pid, dst_rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    # -sseof 从结尾往前 seek：不能用 -ss <时长>，容器时长有小数误差会取到黑帧
    code, _out, _err = run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                            "-sseof", "-0.12", "-i", src, "-frames:v", "1", "-q:v", "2", dst], timeout=180)
    if code != 0 or not os.path.isfile(dst):
        return None
    return dst


# ───────────────────────── qc ─────────────────────────

def ffprobe_one(path):
    code, out, _err = run([FFPROBE, "-v", "error", "-print_format", "json",
                           "-show_format", "-show_streams", path], timeout=120)
    if code != 0:
        return None
    try:
        info = json.loads(out or "{}")
    except Exception:
        return None
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    return {
        "duration": float((info.get("format") or {}).get("duration") or 0),
        "size": int(float((info.get("format") or {}).get("size") or 0)),
        "width": (v or {}).get("width"),
        "height": (v or {}).get("height"),
        "fps": (v or {}).get("r_frame_rate"),
        "nb_frames": (v or {}).get("nb_frames"),
        "has_audio": a is not None,
        "achannels": (a or {}).get("channels"),
        "acodec": (a or {}).get("codec_name"),
    }


def clips_of(pid):
    out = []
    d = project_path(pid)
    for name in sorted(os.listdir(d)):
        if not name.lower().endswith(".mp4"):
            continue
        # 下划线开头是内部中间产物（片头卡等），不算镜头：质检与产物清单都不该看见它
        if name.startswith("_"):
            continue
        m = re.match(r"^(.+)_take(\d+)\.mp4$", name, re.I)
        out.append({
            "name": name,
            "final": name.startswith("成片"),
            "take": int(m.group(2)) if m else 0,
            "shot": m.group(1) if m else name[:-4],
        })
    return out


# ───────────────────────── compose（ported from composeFinal）─────────────────────────

# 片头卡字体：优先行楷/楷体（国风），退回雅黑。**用 .ttf**：.ttc 字体集合在 drawtext 里
# 需要 `fontindex` 才能选到字面，取不准就会退成方块。
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\STXINGKA.TTF",
    r"C:\Windows\Fonts\simkai.ttf",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
]


def pick_font():
    for p in FONT_CANDIDATES:
        if os.path.isfile(p):
            return p
    return ""


def make_intro(pid, seconds=3.0, ep=""):
    """
    片头卡：把一张场景图压暗，叠上片名与集名，带淡入淡出。

    * 文字一律走 `textfile=`，**不写进 filter 字符串** —— 中文字面量 + 冒号 + 反斜杠
      在 filtergraph 里要三层转义，是稳定的事故源；写进 UTF-8 文件只受一处影响。
    * 音轨用 anullsrc **且必须是 32000 Hz 立体声**：合成用的是 concat 解复用器，
      各段流参数必须一致，H3 产物就是 32 kHz，混进 48 kHz 会拼坏。
    """
    meta, params = params_of(pid)
    title = str(meta.get("title") or "").strip()
    ep_id = str(ep or "").strip()
    ep_label = str(meta.get("episode") or "").strip()
    # 分集片头：project.json 的 episodes 映射给每一集自己的集名
    eps = meta.get("episodes") or {}
    if ep_id and isinstance(eps, dict) and eps.get(ep_id):
        ep_label = str(eps[ep_id])
    ep = ep_label
    if not title:
        return None
    font = pick_font()
    if not font:
        print("⚠ 找不到可用中文字体，跳过片头卡")
        return None
    w = int(params.get("width") or 1344)
    h = int(params.get("height") or 768)
    fps = int(params.get("fps") or 24)

    bg = None
    assets = read_json(project_path(pid, "assets.json"), {})
    for a in (assets.get("scenes") or []):
        p = project_path(pid, str(a.get("image") or "").replace("/", os.sep))
        if os.path.isfile(p):
            bg = p
            break
    if not bg:
        first = [c["name"] for c in clips_of(pid) if not c["final"] and not c["take"]]
        if first:
            r = run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i",
                     project_path(pid, first[0]), "-frames:v", "1",
                     project_path(pid, "_intro_bg.png")], timeout=120)
            if r[0] == 0:
                bg = project_path(pid, "_intro_bg.png")
    if not bg:
        print("⚠ 没有可用的片头底图，跳过片头卡")
        return None

    tf_title = project_path(pid, "_intro_title.txt")
    tf_sub = project_path(pid, "_intro_sub.txt")
    with open(tf_title, "w", encoding="utf-8") as fh:
        fh.write(title)
    with open(tf_sub, "w", encoding="utf-8") as fh:
        fh.write(ep)

    # 字体路径里的冒号要**两层转义**（写成 `\\:`）：
    # filtergraph 解析器会先吃掉一层反斜杠，只写 `\:` 的话冒号会被当成选项分隔符，
    # ffmpeg 报 "No option name near '/Windows/Fonts/...'"（实测踩过）。
    font_arg = "fontfile=" + font.replace("\\", "/").replace(":", "\\\\:")
    # textfile 一律用**相对文件名**（ffmpeg 以项目根为 cwd 运行）：
    # filtergraph 里反斜杠是转义符，绝对路径 D:\Ai\漫剧\... 会被啃成 D:Ai漫剧...，
    # 结果就是"找不到文本文件"，而报错只显示 Invalid argument（实测踩过）。
    size_t = max(48, int(h * 0.115))
    size_s = max(20, int(h * 0.048))
    fade_out = max(0.1, seconds - 0.6)
    # 标题轻微上浮：y 从 +18px 落到最终位（0.9s），比纯淡入有呼吸感
    chain = (
        "scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d," % (w, h, w, h)
        + "eq=brightness=-0.16:saturation=0.86,"
        + "drawtext=%s:textfile=%s:fontcolor=0xF3E6C8:fontsize=%d:borderw=3:bordercolor=0x1A0F06@0.85:"
          "x=(w-text_w)/2:y='%d+18*(1-min(t/0.9,1))':alpha='min(t/0.8,1)',"
          % (font_arg, os.path.basename(tf_title), size_t, int(h * 0.33))
        + "drawtext=%s:textfile=%s:fontcolor=0xD9E4F2:fontsize=%d:borderw=2:bordercolor=0x101820@0.8:"
          "x=(w-text_w)/2:y='%d+14*(1-min(max(t-0.7,0)/0.9,1))':alpha='min(max(t-0.7,0)/0.9,1)',"
          % (font_arg, os.path.basename(tf_sub), size_s, int(h * 0.50))
        + "fade=t=in:st=0:d=0.5,fade=t=out:st=%.2f:d=0.6,format=yuv420p[v]" % fade_out
    )
    out = project_path(pid, ("_intro-%s.mp4" % ep_id) if ep_id else "_intro.mp4")
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
           "-loop", "1", "-framerate", str(fps), "-i", bg,
           "-f", "lavfi", "-i", "anullsrc=r=32000:cl=stereo",
           "-t", "%.2f" % seconds,
           "-filter_complex", chain, "-map", "[v]", "-map", "1:a",
           "-c:v", "libx264", "-preset", "medium", "-crf", "18",
           "-c:a", "aac", "-b:a", "192k", "-ar", "32000", "-ac", "2",
           "-shortest", out]
    code, _o, err = run(cmd, cwd=project_path(pid), timeout=600)
    if code != 0:
        print("⚠ 片头卡生成失败（跳过）：" + (err or "")[-300:])
        return None
    info = ffprobe_one(out)
    print("片头卡 %s（%s / %s）%.2fs" % (os.path.basename(out), title, ep or "-",
                                        (info or {}).get("duration") or 0))
    # **返回真正写出来的那个文件名**。原来硬编码 return "_intro.mp4"，
    # 分集之后就变成"两集都去用同一个老文件"——ep02 的成片里嵌的是 ep01 那张卡（实测踩到）。
    return os.path.basename(out)
