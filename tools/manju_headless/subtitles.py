# -*- coding: utf-8 -*-
"""字幕：宽度计算、折行、时间码、ASS 生成（含字幕卡三类）。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import re

def visual_width(s):
    return sum(0.5 if ord(ch) < 0x2E80 else 1 for ch in str(s or ""))


def wrap_ass_text(text, max_units):
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if not s:
        return ""
    if visual_width(s) <= max_units:
        return s
    lines, cur, cur_w = [], "", 0
    for ch in s:
        cur += ch
        cur_w += 0.5 if ord(ch) < 0x2E80 else 1
        brk = bool(re.match(r"[，。！？、；：…,\.!\?;:]", ch))
        if cur_w >= max_units or (brk and cur_w >= max_units * 0.72):
            lines.append(cur)
            cur, cur_w = "", 0
    if cur:
        lines.append(cur)
    if len(lines) > 3:
        lines = lines[:2] + ["".join(lines[2:])]
    return "\\N".join(lines)


def ass_time(sec):
    s = max(0.0, float(sec or 0))
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    ss = int(s % 60)
    cs = min(99, int(round((s - int(s)) * 100)))
    p2 = lambda n: ("0" + str(n)) if n < 10 else str(n)
    return "%d:%s:%s.%s" % (h, p2(m), p2(ss), p2(cs))


def build_ass(shots, starts, width, height, size_pct=5.0, tail_trim=0.0, fade_ms=140):
    """生成 ASS 字幕。

    `tail_trim` 是"每镜尾部被下一镜吃掉的秒数"：
      * 硬切 = 0；
      * 叠化 = 转场时长 F（默认 0.5）。
    **不扣掉它就会出事故**：字幕窗口原本铺满整镜时长，而叠化时下一镜提前 F 秒开始，
    于是每处转场都有 F 秒两条字幕同时压在屏幕上（实测 15 镜 = 14 处重叠、每处 0.44s）。
    观感就是"字和画都在重影"，直接被读成"镜头前后不连贯"。
    """
    margin_v = int(round(height * 0.06))
    size = max(18, int(round(height * size_pct / 100)))
    margin_lr = int(round(width * 0.07))
    max_units = max(6, int(((width - margin_lr * 2) / size) * 0.96))
    outline = max(2, int(round(size * 0.09)))
    shadow = max(1, int(round(size * 0.05)))

    def style(name, color, italic):
        return ("Style: %s,Microsoft YaHei,%d,%s,&H000000FF,&H00000000,&H96000000,0,%d,0,0,100,100,0,0,1,"
                "%d,%d,2,%d,%d,%d,134" % (name, size, color, 1 if italic else 0,
                                          outline, shadow, margin_lr, margin_lr, margin_v))

    lines = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: %d" % width, "PlayResY: %d" % height,
        "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        style("对白", "&H00FFFFFF", False),
        style("旁白", "&H00D8E8F5", True),
        # 字幕卡三类的 Style：**必须在这里定义**。
        # 引用一个未定义的 Style 名时，libass / VSFilter / mpv 各自回落到不同的样式，
        # 同一份 ASS 换播放器就换观感。行内标签负责位置与字号，Style 负责字体、描边、
        # 阴影这些"没被覆盖"的属性 —— 两边分工，缺一边就会漂。
        # 与工作台 lib/index.js 的 buildAss 保持逐字同口径。
        style("系统", "&H60E0D0", False),
        style("弹幕", "&HA8A8A8", False),
        style("音效", "&H00FFFFFF", False),
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    n = 0
    total = len(shots)
    for i, s in enumerate(shots):
        dlg = s.get("dialogue") or []
        if not dlg:
            continue
        start = starts[i] if i < len(starts) else 0
        dur = s.get("_dur") or 0
        # 本镜真正独占画面的时长：最后一镜不用扣，中间各镜要扣掉被下一镜吃掉的那段
        avail = dur - (tail_trim if i < total - 1 else 0.0)
        if avail <= 0.05:
            continue
        each = avail / len(dlg)
        for k, d in enumerate(dlg):
            txt = str((d or {}).get("text") or "").strip()
            if not txt:
                continue
            name = str((d or {}).get("speaker") or "").strip()
            is_narr = bool(re.search(r"旁白|narrator|voiceover", name, re.I))
            label = "" if (is_narr or not name) else (name + "：")
            # ── 字幕卡类型 ──
            # 短剧要"易懂 + 会玩梗"，靠的是**不只一行底部旁白字幕**：
            #   sys     系统提示（左上、薄荷绿）—— 把设定钉死，观众一秒懂金手指
            #   danmaku 弹幕（顶部小灰字）—— 玩梗层
            #   sfx     音效大字（画面中央）—— 节奏重音
            # 用行内 ASS 覆盖标签实现，不动 Style 表（改动面最小、也不需要新模板）。
            kind = str((d or {}).get("kind") or "").strip().lower()
            if kind in ("sys", "system"):
                tag = ("{\\an7\\pos(%d,%d)\\fs%d\\c&H60E0D0&\\bord3\\3c&H00000000&\\fad(%d,%d)}"
                       % (int(width * 0.05), int(height * 0.06), int(size * 0.66), int(fade_ms), int(fade_ms)))
                body = txt
            elif kind in ("danmaku", "dm"):
                tag = ("{\\an8\\pos(%d,%d)\\fs%d\\c&HA8A8A8&\\fad(%d,%d)}"
                       % (width // 2, int(height * 0.04), int(size * 0.52), int(fade_ms), int(fade_ms)))
                body = txt
            elif kind in ("sfx", "fx"):
                tag = ("{\\an5\\pos(%d,%d)\\fs%d\\c&HFFFFFF&\\bord7\\3c&H00000000&\\fad(60,140)}"
                       % (width // 2, height // 2, int(size * 2.2)))
                body = txt
            else:
                tag = ("{\\fad(%d,%d)}" % (int(fade_ms), int(fade_ms))) if fade_ms else ""
                body = wrap_ass_text(label + txt, max_units)
            t0 = start + each * k
            t1 = start + each * (k + 1) - 0.06
            if t1 - t0 < 0.2:
                continue
            lines.append("Dialogue: 0,%s,%s,%s,%s,0,0,0,,%s%s" % (
                ass_time(t0), ass_time(t1),
                "系统" if kind in ("sys", "system") else
                ("弹幕" if kind in ("danmaku", "dm") else
                 ("音效" if kind in ("sfx", "fx") else ("旁白" if is_narr else "对白"))),
                name, tag, body))
            n += 1
    return "\n".join(lines), n, size, max_units
