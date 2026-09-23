# -*- coding: utf-8 -*-
"""提示词片段：身份保真、构图框定、普通话锁、场景空间锚点。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

# 与工作台一致的风格契约：风格块**只描述渲染表面**（材质/光泽/媒介），
# 绝不含形状类词汇 —— 写了 "large glossy stylized eyes" 这类词，定妆照与视频会各画一张脸。
IDENTITY_FIDELITY = (
    "\n\nIDENTITY FIDELITY (mandatory): the face must match the written brief EXACTLY — same face shape and jaw, "
    "same chin, same eye shape and eyelids, same brow shape, same nose, same hair length and style. "
    "Art style changes the RENDERING SURFACE only (material, sheen, shading); it must NEVER change the character's features. "
    "Do not beautify, do not enlarge or round the eyes, do not soften a sharp jaw, do not make the subject younger, "
    "prettier or more handsome than described. "
    "Do NOT add any lettering, name tag text or emblem text to the clothing unless the brief explicitly asks for it."
)


FRAMING_CHAR = (
    "\n\nFRAMING: single character, upper-body framing, front-facing, plain neutral background, "
    "no other people, no text or lettering."
)


FRAMING_SCENE = "\n\nFRAMING: environment plate only, no people, no characters, no text or lettering."


def scene_anchors(plan):
    """场景 -> 空间锚点文案（知识库镜头表的 Reference Anchors：固定地标 + 屏幕相对位置）。"""
    out = {}
    for s in ((plan or {}).get("scenes") or []):
        a = str(s.get("anchors") or "").strip()
        if a:
            out[str(s.get("id") or "")] = a
    return out


def anchor_block(text, anchors):
    """
    空间连续块：把同一场景的固定地标与屏幕位置**逐镜重复**。

    为什么需要：同一场景的相邻镜头本该"站在同一张地图上"，但每一镜是独立生成的，
    模型会自己重新安排空间——灯跑到别处、椅子换了位置、站牌消失。观众感觉就是
    "每个镜头都像换了地方"，这是"看得莫名其妙"的第二个来源（知识库的镜头表专门有
    Reference Anchors 一列治它，我先前只在分镜表里写了、没写进提示词）。
    """
    if not anchors:
        return text
    return (text.rstrip() + "\n\nSPATIAL CONTINUITY (this shot belongs to one continuous scene; the following "
            "landmarks exist in EVERY shot of this scene and must stay in the same screen positions, at the same "
            "relative scale — never relocate, duplicate, remove or redesign them): " + anchors)


# ───────────────────────── render ─────────────────────────

def ensure_mandarin(text):
    """
    给中文台词补上"只说普通话"的硬锁（与工作台 ensureChineseDialogue 同口径）。

    为什么要有：H3 靠 ``<d>`` 里的语言标记决定说什么语言，标记在就一定说中文；
    但工作台还会额外追一段 MANDARIN ONLY 约束，用来压住口音与即兴外语。
    我的驱动器原来直写提示词、绕过了这道保险 —— 现在补齐，两边口径一致。
    幂等：已经有 MANDARIN ONLY 就原样返回。
    """
    s = str(text or "")
    if "<d>" not in s:
        return s
    if "MANDARIN ONLY" in s:
        return s
    return s + "\n\n" + (
        "MANDARIN ONLY (mandatory language rule): every spoken line and voiceover MUST be Mandarin Chinese (普通话), "
        "matching the [Chinese] tag inside each <d>…</d>; no English, no Japanese, no invented or gibberish speech, "
        "no foreign accent. Ambient non-speech sound only where the soundscape asks for it."
    )
