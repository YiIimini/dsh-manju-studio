# -*- coding: utf-8 -*-
"""语音验收：把成片音轨转写，与剧本台词逐条比对。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import os

from .asr import _asr_segments, _best_sim, _norm_text
from .jsonio import read_json
from .paths import need_project, project_path
from .procs import run
from .shots import shot_episode

def cmd_voice(args):
    """
    语音验收：把成片的音轨转写出来，与剧本台词**逐条**比对。

    补的是管线里最后一个"肉眼验不了"的环节：字幕是后期烧上去的，跟音轨里实际说的话
    是两回事；H3 若漏了语言标记会输出鸟语，而画面上完全看不出来。
    走 CPU 推理（不占显存，与 ComfyUI 不冲突）。
    """
    pid = args.project
    need_project(pid)
    ep = str(args.episode or "").strip()
    final = project_path(pid, ("成片-%s.mp4" % ep) if ep else "成片.mp4")
    if not os.path.isfile(final):
        raise SystemExit("还没有成片：%s" % os.path.basename(final))
    asr = r"D:\Ai\Tools\ASR\asr.cmd"
    if not os.path.isfile(asr):
        raise SystemExit("没找到 ASR：D:\\Ai\\Tools\\ASR\\asr.cmd（见 D:\\Ai\\Tools\\ASR\\README.md）")
    out = project_path(pid, "output", ("asr-%s.txt" % ep) if ep else "asr.txt")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    print("转写中（CPU 推理，68s 成片约 1~4 分钟）…", flush=True)
    env = dict(os.environ)
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    code, so, se = run([asr, final, "--model", args.model, "--out", out], timeout=3600, env=env)
    if code != 0 or not os.path.isfile(out):
        print("转写失败：" + (se or so or "")[-400:])
        return 1
    raw = open(out, encoding="utf-8").read()
    cands = _asr_segments(raw)
    if not cands:
        print("转写里没有可用分段（VAD 可能把整条音轨当静音吞了）")
        return 1
    head = [l for l in raw.splitlines() if l.startswith("#")]

    plan = read_json(project_path(pid, "plan.meta.json"), {})
    shots = [s for s in (plan.get("shots") or []) if (not ep or shot_episode(s) == ep)]
    rows, hits, total = [], 0, 0
    for s in shots:
        for d in (s.get("dialogue") or []):
            want = _norm_text(d.get("text"))
            if not want:
                continue
            total += 1
            sim = _best_sim(want, cands)
            # 超短行要单独放宽：2 个字的台词（"阿默。"）只要同音字错一个，
            # 相似度就是 0.5 —— 那是**度量的局限**，不是听错了（实测 ASR 听成"阿末"）。
            thr = float(args.min_sim) if len(want) > 3 else min(float(args.min_sim), 0.5)
            ok = sim >= thr
            if ok:
                hits += 1
            rows.append((str(s.get("id")), str(d.get("text")), sim, ok))
    print("\n=== 语音验收 %s%s ===" % (pid, (" · " + ep) if ep else ""))
    for h in head:
        print("  " + h.lstrip("# ").strip())
    for sid, text, sim, ok in rows:
        print("  %-9s %-5s %.2f  %s" % (sid, "命中" if ok else "存疑", sim, text))
    rate = (100.0 * hits / total) if total else 0.0
    print("\n台词命中 %d/%d（%.0f%%），阈值 %.2f；转写全文见 %s"
          % (hits, total, rate, float(args.min_sim), os.path.basename(out)))
    if rate < 60:
        print("⚠ 命中率偏低：先看是不是提示词漏了 <d>[Chinese] 标记或普通话锁（会输出鸟语）")
    return 0 if rate >= 60 else 1
