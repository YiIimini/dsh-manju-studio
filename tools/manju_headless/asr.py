# -*- coding: utf-8 -*-
"""语音转写的文本比对（相似度，不用全等 —— 同音字必错）。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import difflib
import re

def _norm_text(s):
    """只留中日韩汉字与字母数字：标点/空白不参与比对（转写不会给一样的标点）。"""
    return re.sub(r"[^\u4e00-\u9fff0-9A-Za-z]", "", str(s or ""))


def _asr_segments(raw):
    """
    从转写文件里取出**分段**（带时间戳那些行），并补上"相邻段拼接"的候选。

    为什么要拼接：ASR 会按停顿把一句话切成两段（"我听不见人话" / "可我听得见规矩"），
    拿整句去比任何单段都只有 0.5 左右 —— 那是比对方式的错，不是语音的错（实测栽过）。
    """
    segs = []
    for line in str(raw or "").splitlines():
        m = re.match(r"^\[\s*[\d.]+-\s*[\d.]+\]\s*(.+)$", line.strip())
        if m and m.group(1).strip():
            segs.append(_norm_text(m.group(1)))
    out = list(segs)
    for i in range(len(segs) - 1):
        out.append(segs[i] + segs[i + 1])
    for i in range(len(segs) - 2):
        out.append(segs[i] + segs[i + 1] + segs[i + 2])
    return out


def _best_sim(want, cands):
    """
    台词 vs 转写候选的最高相似度。

    先用"包含"做快路径（听对了就是这么回事），再退到相似度 —— ASR 必错同音字
    （守/首、默/末、应/硬），全等会把"听对了"判成"没听对"。
    """
    if not want:
        return 0.0
    best = 0.0
    for c in cands:
        if not c:
            continue
        if want in c:
            return 1.0
        r = difflib.SequenceMatcher(None, want, c).ratio()
        if r > best:
            best = r
    return best
