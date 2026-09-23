# -*- coding: utf-8 -*-
"""镜头与分集的纯逻辑：集号、连续段、段内自动接镜。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

# ───────────────────────── 分集（项目内）─────────────────────────
#
# **一集 = 一个项目是错的**：工作台本身就是"一个项目 = 一部剧"——
# pickShots 按镜头自己的 `episode` 字段过滤，客户端也有「章节/集/镜头」筛选。
# 一集一项目会把资产、封面、列表全拆散，用户还得自己在列表里认谁是谁。
# 所以分集体现在三处：
#   * 镜头的 `episode` 字段（ep01/ep02…），**镜头 id 带集前缀**（ep01-s01）——
#     工作台靠 id 把产物映射回分镜，前缀让两集的 s01 不会互相顶掉；
#   * 提示词按集分目录：prompts/<ep>/<sid>.txt；
#   * 成片按集出：成片-<ep>.mp4（都以「成片」开头，工作台的 clipsOf 会正确排除它们）。
def shot_episode(shot):
    return str((shot or {}).get("episode") or "").strip()


def episodes_in(plan):
    seen, out = {}, []
    for s in ((plan or {}).get("shots") or []):
        e = shot_episode(s)
        if e and e not in seen:
            seen[e] = True
            out.append(e)
    return out


def shot_run(shot):
    """镜头所属的"连续段"（同一地点/同一动作的一串镜头）。"""
    return str((shot or {}).get("run") or "").strip()


def auto_chain_in_runs(shots, enabled=True):
    """
    **连续段内自动接镜**：同一 run 里，除第一镜外全部把上一镜末帧钉在第 0 帧。

    为什么必须默认开：实测 EP01 的 11 处切点里只有 1 处做了帧接续，
    其余末帧→首帧 SSIM 只有 0.54~0.71（等于两张无关的图硬切），
    观众看到的就是"12 张招贴画轮播"——这就是"看得莫名其妙"的量化根因。
    接了镜的那一处是 0.943，差距一眼可见。

    为什么**只在段内**开：跨段是刻意的硬切（换场/换时间），
    把上一场末帧钉到下一场第 0 帧会强迫模型做一次变形过渡，比不接更难看。
    """
    if not enabled:
        return 0
    n = 0
    prev = None
    for s in shots:
        run = shot_run(s)
        if run and prev is not None and shot_run(prev) == run:
            if not s.get("chain_from_prev"):
                s["chain_from_prev"] = True
                n += 1
            # **无条件重写**：chain_from_prev 可能是上一次 sync 落盘的，
            # 那时还没有 chain_from 这个字段（第一版只写 prev 标记）—— 只在"新设置"时写会永远补不上。
            s["chain_from"] = str(prev.get("id") or "")
        prev = s
    return n
