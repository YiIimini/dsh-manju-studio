# -*- coding: utf-8 -*-
"""同步：解析参考图 → _render-<集>.json（渲染器唯一认的输入）。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import os

from .jsonio import read_json, write_json
from .media import extract_last_frame
from .paths import need_project, params_of, project_path, render_doc_path
from .prompts import anchor_block, ensure_mandarin, scene_anchors
from .series import resolve_refs
from .shots import auto_chain_in_runs, episodes_in, shot_episode

def cmd_sync(args):
    pid = args.project
    need_project(pid)
    meta, params = params_of(pid)
    plan = read_json(project_path(pid, "plan.json"), None)
    if not plan or not plan.get("shots"):
        raise SystemExit("缺少 plan.json 或 shots 为空")

    # **段落内自动接镜**：同一 run 的相邻镜头自动把上一镜末帧钉在第 0 帧。
    # 实测这是"看得莫名其妙"的根治手段（未接镜的切点 SSIM 0.54~0.71，接了的 0.94）。
    auto_n = auto_chain_in_runs(plan["shots"], not getattr(args, "no_auto_chain", False))
    if auto_n:
        write_json(project_path(pid, "plan.json"), plan)
        print("段落内自动接镜：%d 处（同一 run 的相邻镜头）" % auto_n)

    # 分集过滤：shots.json 永远写**全本**（工作台要看得见所有集），
    # 只有渲染清单 _render-<ep>.json 按集收敛。
    ep = str(getattr(args, "episode", "") or "").strip()
    if ep:
        keep = [s for s in plan["shots"] if shot_episode(s) == ep]
        if not keep:
            raise SystemExit("这一集没有镜头：%s（本项目可用的集：%s）"
                             % (ep, "、".join(episodes_in(plan)) or "无"))
        plan_for_render = dict(plan, shots=keep)
    else:
        plan_for_render = plan

    # shots.json 与 plan.json 同构（工作台里 plan 是作者方案、shots 是渲染源）
    shots_doc = {k: v for k, v in plan.items()}
    write_json(project_path(pid, "shots.json"), shots_doc)

    name_of = {}
    for c in (plan.get("characters") or []):
        if c.get("id"):
            name_of[str(c["id"])] = c.get("name") or ""
    anchors = scene_anchors(plan)
    if anchors:
        print("空间锚点：%d 个场景已注入逐镜的地标位置块" % len(anchors))

    shots, ref_total, with_ref, missing_all, chained, chain_miss = [], 0, 0, [], 0, []
    prev_id = ""
    for s in plan_for_render["shots"]:
        one = dict(s)
        # 字段名转换是渲染器契约的一部分：方案里叫 h3_prompt（工作台/方案阶段的写法），
        # manju.py 只认 `prompt`。漏了这一步 15 个镜头会全部在 0 秒内报"没有 prompt"。
        one["prompt"] = ensure_mandarin(s.get("h3_prompt") or s.get("prompt") or "")
        # 空间锚点：同场景每一镜都带上同一套地标位置
        one["prompt"] = anchor_block(one["prompt"], anchors.get(str(s.get("scene") or "")))
        refs, missing = resolve_refs(pid, s, name_of)
        one.pop("characters", None)
        one.pop("scene", None)
        one.pop("dialogue", None)
        one.pop("shot_size", None)
        one.pop("camera", None)
        # ── 镜间衔接 ──
        # `chain_from_prev: true` = 把上一镜的**末帧**钉在本镜第 0 帧。
        # 这是渲染器原生的做法（MiniMaxH3AddGuide，frame_idx 0），
        # 也是唯一能让"上一镜结束的状态"真的延续到下一镜的手段 ——
        # 光靠参考图 + 文字，两镜各自独立生成，姿态/位置/光比不会自动接上。
        # 注意：**只该用在同一段连续动作上**。跨场硬切（如全景→特写、问心台→机枢殿）
        # 强行接帧反而会把两种构图糅在一起，比不接更难看。
        if s.get("chain_from_prev") and prev_id:
            hit = extract_last_frame(pid, prev_id + ".mp4", "_frames/%s_last.jpg" % prev_id)
            if hit:
                one["guides"] = [{"frame_idx": 0, "image": hit}]
                chained += 1
            else:
                chain_miss.append("%s←%s" % (s.get("id"), prev_id))
        if refs:
            one["ref_images"] = refs
            one["mode"] = "r2v"
            ref_total += len(refs)
            with_ref += 1
        else:
            one["mode"] = "t2v"
        if missing:
            missing_all.append("%s 缺 %s" % (s.get("id"), "/".join(missing)))
        shots.append(one)
        prev_id = str(s.get("id") or "")

    render_doc = {
        "project": pid,
        "style": (shots_doc.get("style") or params.get("style") or ""),
        "shots": shots,
        "defaults": {
            "sampler": params.get("sampler") or "euler",
            "shift_video": 12.0 if params.get("shiftVideo") is None else params["shiftVideo"],
            "shift_audio": 3.0 if params.get("shiftAudio") is None else params["shiftAudio"],
            "ref_image_size": params.get("refImageSize") or "match",
            "accel": params.get("accel") or "pdd8",
            "vaeInt8": params.get("vaeInt8") is not False,
            "takes": 1 if params.get("takes") is None else params["takes"],
            "vramMode": params.get("vramMode") or "off",
            "crf": 16.0 if params.get("crf") is None else params["crf"],
            "steps": params.get("steps") or 8,
            "fps": params.get("fps") or 24,
        },
    }
    write_json(render_doc_path(pid, ep), render_doc)
    # 工作台的「渲染」按钮只认 _render.json：分集渲染时把它指向**刚 sync 的那一集**，
    # 另存一份 _render-<ep>.json 作为该集的确定清单。
    if ep:
        write_json(project_path(pid, "_render.json"), render_doc)
    print("已写 shots.json（%d 镜，全本）与 %s%s"
          % (len(shots), os.path.basename(render_doc_path(pid, ep)), ("（集 %s）" % ep) if ep else ""))
    print("参考图 %d 张 · 走 Ref2VA %d/%d 镜 · ref_image_size=%s · accel=%s"
          % (ref_total, with_ref, len(shots), render_doc["defaults"]["ref_image_size"],
             render_doc["defaults"]["accel"]))
    if chained:
        print("镜间衔接：%d 镜把上一镜末帧钉在第 0 帧" % chained)
    if chain_miss:
        print("⚠ 想接上一镜但没有可用的末帧（该镜还没渲染过？）：" + "、".join(chain_miss))
    if missing_all:
        print("⚠ 缺参考图的镜头：" + "；".join(missing_all))
        return 1
    return 0
