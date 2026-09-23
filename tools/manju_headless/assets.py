# -*- coding: utf-8 -*-
"""资产定妆：用 Krea-2 生成缺失的定妆照与场景图（含系列池复用）。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import os
import re
import shutil
import time

from .comfy import build_image_graph, comfy_alive, comfy_run_graph
from .cover import gen_cover
from .jsonio import read_json, write_json
from .paths import COMFY, COMFY_OUTPUT, need_project, params_of, project_path
from .prompts import FRAMING_CHAR, FRAMING_SCENE, IDENTITY_FIDELITY
from .series import SERIES_KINDS, series_find, series_id, series_pull, series_register

# 参考图尺寸：Ref2VA 的 ref_image_size=match 会把参考图缩放到**本次生成的像素面积**，
# 所以参考图自己也该接近 1344×768 ≈ 1.03 MP，否则会被放大、细节先丢一层。
#   定妆照  832×1248 = 1.04 MP（2:3 半身，和工作台一致）
#   场景图 1344×768 = 1.03 MP（16:9，与成片画布同比例 —— 工作台的 832×480 只有 0.4 MP，
#                                 要放大 2.6 倍才进参考槽，这里按像素面积对齐）
CHAR_W, CHAR_H = 832, 1248


SCENE_W, SCENE_H = 1344, 768


# ───────────────────────── assets ─────────────────────────

def cmd_assets(args):
    pid = args.project
    need_project(pid)
    meta, params = params_of(pid)
    style = (params.get("style") or "").strip()
    plan = read_json(project_path(pid, "plan.json"), None)
    if not plan or not plan.get("shots"):
        raise SystemExit("还没有 plan.json / shots，先写方案")
    assets = read_json(project_path(pid, "assets.json"), {"characters": [], "scenes": [], "props": []})
    for k in ("characters", "scenes", "props"):
        assets.setdefault(k, [])

    need_char, need_scene = {}, {}
    for s in plan["shots"]:
        for c in (s.get("characters") or []):
            need_char[c] = True
        if s.get("scene"):
            need_scene[s["scene"]] = True

    have = {}
    for k in ("characters", "scenes", "props"):
        for a in assets[k]:
            if a.get("image"):
                have[k + ":" + str(a.get("id"))] = True

    # ── 系列池自播种 ──
    # 本项目已有的定妆照/场景图，池里没有的登记进池。
    # 这样对 EP01 跑一次 assets，就把整个系列的"脸"定下来了，后续集直接复用。
    series = series_id(pid)
    seeded = 0
    if series:
        for k in SERIES_KINDS:
            for a in assets[k]:
                if not a or not a.get("image"):
                    continue
                src = project_path(pid, str(a["image"]).replace("/", os.sep))
                if not os.path.isfile(src):
                    continue
                if series_find(series, k, {"id": a.get("id"), "name": a.get("name")}) is None:
                    series_register(series, k, str(a.get("name") or a.get("id") or ""), src,
                                    {"id": str(a.get("id") or ""), "desc": str(a.get("desc") or "")[:200]})
                    seeded += 1
        if seeded:
            print("系列池「%s」新登记 %d 个资产（跨集复用的脸就从这里来）" % (series, seeded))

    todo = []
    for c in (plan.get("characters") or []):
        if not need_char.get(c.get("id")):
            continue
        if have.get("characters:" + str(c.get("id"))) and not args.force:
            continue
        if args.only and c.get("id") not in args.only:
            continue
        todo.append(("characters", c))
    for s in (plan.get("scenes") or []):
        if not need_scene.get(s.get("id")):
            continue
        if have.get("scenes:" + str(s.get("id"))) and not args.force:
            continue
        if args.only and s.get("id") not in args.only:
            continue
        todo.append(("scenes", s))

    if not todo:
        print("资产齐全：方案引用的角色/场景都已有图。")
        if args.no_cover:
            return 0
        return gen_cover(pid, force=args.force_cover)

    # ── 先尽量从系列池复用（这一步完全不需要 ComfyUI）──
    # 复用是逐字节复制：后续集拿到的就是前一集那张脸。
    reused = 0
    if series and not args.force:
        remain = []
        for kind, item in todo:
            if series_pull(pid, series, kind, item, assets):
                write_json(project_path(pid, "assets.json"), assets)
                print("    ↺ 复用系列图「%s」（跨集同一张脸）" % (item.get("name") or item.get("id")), flush=True)
                reused += 1
                continue
            remain.append((kind, item))
        todo = remain
        if reused:
            print("从系列池复用 %d 张，仍需生成 %d 张" % (reused, len(todo)))
    if not todo:
        print("资产齐备（全部来自系列池）。")
        if args.no_cover:
            return 0
        return gen_cover(pid, force=args.force_cover)

    if not comfy_alive():
        raise SystemExit("ComfyUI 不可达（%s）—— 先运行 D:\\Ai\\ComfyUI\\start-comfyui.cmd" % COMFY)

    print("待生成 %d 张" % len(todo))
    failed = []
    for kind, item in todo:
        is_char = kind == "characters"
        w, h = (CHAR_W, CHAR_H) if is_char else (SCENE_W, SCENE_H)
        brief = (item.get("image_prompt") or item.get("description") or item.get("name") or "").strip()
        prompt = brief
        prompt += FRAMING_CHAR if is_char else FRAMING_SCENE
        prompt += IDENTITY_FIDELITY
        if style:
            prompt += "\n\nRENDER STYLE (surface only, never changes features): " + style
        seed = args.seed if args.seed else (1000 + int(time.time() * 1000) % 900000)
        print("  「%s」%dx%d seed=%d …" % (item.get("name") or item.get("id"), w, h, seed), flush=True)
        files, err = comfy_run_graph(build_image_graph(prompt, w, h, seed), label=item.get("name") or "")
        if err:
            print("    FAIL " + err)
            failed.append((item.get("id"), err))
            continue
        f = files[0]
        src = os.path.join(COMFY_OUTPUT, str(f.get("subfolder") or "").replace("/", os.sep), f["filename"])
        safe = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fa5]", "_", str(item.get("name") or item.get("id") or "asset"))
        rel = "assets/img/%s_gen_%s_%d.png" % (kind, safe, seed)
        dst = project_path(pid, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        if os.path.getsize(dst) < 1024:
            print("    FAIL 产物过小")
            failed.append((item.get("id"), "产物过小"))
            continue
        entry = {
            "id": str(item.get("id") or ("%s_gen_%s" % (kind, safe))),
            "name": str(item.get("name") or item.get("id") or ""),
            "desc": str(item.get("description") or "")[:200],
            "image": rel,
            "generated": True,
            "seed": seed,
        }
        arr = assets[kind]
        hit = -1
        for i, a in enumerate(arr):
            if str(a.get("id")) == entry["id"] or (a.get("name") and a.get("name") == entry["name"]):
                hit = i
        if hit >= 0:
            arr[hit] = dict(arr[hit], **entry)
        else:
            arr.append(entry)
        write_json(project_path(pid, "assets.json"), assets)
        print("    ✓ " + rel, flush=True)
        # 新生成的脸同时入池，供后续集逐字节复用
        if series and kind in SERIES_KINDS:
            series_register(series, kind, entry["name"], dst,
                            {"id": entry["id"], "desc": entry["desc"]})

    print("\n资产：成功 %d / 失败 %d" % (len(todo) - len(failed), len(failed)))
    for i, e in failed:
        print("  FAIL %s: %s" % (i, e))
    # 封面是**独立一张图**，素材齐不齐都得有它（不能拿定妆照顶替）
    if not args.no_cover:
        if gen_cover(pid, force=args.force_cover) != 0:
            failed.append(("cover", "封面生成失败"))
    return 0 if not failed else 1
