# -*- coding: utf-8 -*-
"""项目级操作：状态一览、plan.json 构建、分集概况、吸收成集、日志查看。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import os
import re
import shutil
import sys
import time

from .jsonio import read_json, write_json
from .media import clips_of, ffprobe_one
from .paths import need_project, params_of, project_path
from .shots import episodes_in, shot_episode

def cmd_absorb(args):
    """
    把一个独立项目**吸收成本项目的某一集**。

    存在的理由：分集本该在项目内做，但"一集一项目"是很容易犯的错（我自己就犯了）。
    与其让用户手工搬文件，不如给一条可复现、会做校验的吸收通路。
    搬完**不动源项目**（只报告），由调用方决定是否清理。
    """
    dst = args.project
    src = args.source
    ep = str(args.episode or "").strip()
    need_project(dst)
    need_project(src)
    if not re.match(r"^[A-Za-z0-9_-]{1,20}$", ep):
        raise SystemExit("--episode 非法（字母/数字/下划线/连字符）")

    src_plan = read_json(project_path(src, "plan.meta.json"), None)
    if not src_plan or not src_plan.get("shots"):
        raise SystemExit("源项目没有 plan.meta.json 或 shots 为空")
    dst_plan = read_json(project_path(dst, "plan.meta.json"), None)
    if not dst_plan:
        raise SystemExit("目标项目没有 plan.meta.json")

    print("吸收 %s → %s 的 %s（%d 镜）" % (src, dst, ep, len(src_plan["shots"])))

    # ── 1. 角色/场景：按 id/name 合并（同一个人只留一张卡）──
    for kind in ("characters", "scenes"):
        have = {}
        for c in (dst_plan.get(kind) or []):
            if c.get("id"):
                have[str(c["id"])] = True
            if c.get("name"):
                have["n:" + str(c["name"])] = True
        for c in (src_plan.get(kind) or []):
            if c.get("id") in have or ("n:" + str(c.get("name"))) in have:
                continue
            dst_plan.setdefault(kind, []).append(c)

    # ── 2. 镜头：改 id 前缀 + 打 episode 标记 ──
    dst_shots = dst_plan.get("shots") or []
    used = {str(s.get("id")) for s in dst_shots}
    id_map = {}
    for s in src_plan["shots"]:
        old = str(s.get("id") or "")
        new = "%s-%s" % (ep, old)
        if new in used:
            raise SystemExit("目标项目里已存在镜头 id：%s（先清掉再吸收）" % new)
        id_map[old] = new
        one = dict(s)
        one["id"] = new
        one["episode"] = ep
        pf = str(s.get("prompt_file") or ("prompts/%s.txt" % old))
        # 先削扩展名再拼：basename("prompts/s01.txt") = "s01.txt"，
        # 直接拼 ".txt" 会得到 s01.txt.txt（实测踩过一次）
        one["prompt_file"] = "prompts/%s/%s.txt" % (ep, os.path.splitext(os.path.basename(pf))[0])
        dst_shots.append(one)
        used.add(new)
    dst_plan["shots"] = dst_shots
    if not dst_plan.get("style") and src_plan.get("style"):
        dst_plan["style"] = src_plan["style"]
    write_json(project_path(dst, "plan.meta.json"), dst_plan)

    # ── 3. 提示词 ──
    pdir = project_path(dst, "prompts", ep)
    os.makedirs(pdir, exist_ok=True)
    moved = 0
    for old, new in id_map.items():
        sp = project_path(src, "prompts", "%s.txt" % old)
        if os.path.isfile(sp):
            shutil.copyfile(sp, os.path.join(pdir, "%s.txt" % old))
            moved += 1
    print("  提示词 %d 份 → prompts/%s/" % (moved, ep))

    # ── 4. 产物：<sid>.mp4 → <ep>-<sid>.mp4；成片 → 成片-<ep>.mp4 ──
    clips = 0
    for old, new in id_map.items():
        sp = project_path(src, "%s.mp4" % old)
        if os.path.isfile(sp):
            shutil.copyfile(sp, project_path(dst, "%s.mp4" % new))
            clips += 1
    for name in ("成片.mp4",):
        sp = project_path(src, name)
        if os.path.isfile(sp):
            shutil.copyfile(sp, project_path(dst, "成片-%s.mp4" % ep))
            print("  成片 → 成片-%s.mp4" % ep)
    print("  产物 %d 个 → %s-*.mp4" % (clips, ep))

    # ── 5. 剧本 / 封面 / 资产图 ──
    for name in os.listdir(project_path(src, "script")) if os.path.isdir(project_path(src, "script")) else []:
        if name.lower().endswith(".md"):
            tgt = project_path(dst, "script", "%s-%s" % (ep, name))
            if not os.path.isfile(tgt):
                shutil.copyfile(project_path(src, "script", name), tgt)
    for name in ("cover.png",):
        sp = project_path(src, name)
        if os.path.isfile(sp):
            shutil.copyfile(sp, project_path(dst, "cover-%s.png" % ep))
    assets = read_json(project_path(dst, "assets.json"), {"characters": [], "scenes": [], "props": []})
    src_assets = read_json(project_path(src, "assets.json"), {"characters": [], "scenes": [], "props": []})
    for kind in ("characters", "scenes", "props"):
        assets.setdefault(kind, [])
        have = {str(a.get("id")) for a in assets[kind]} | {str(a.get("name")) for a in assets[kind]}
        for a in (src_assets.get(kind) or []):
            if not a or not a.get("image"):
                continue
            if str(a.get("id")) in have or str(a.get("name")) in have:
                continue
            rel = str(a["image"])
            sp = project_path(src, rel.replace("/", os.sep))
            if os.path.isfile(sp):
                tp = project_path(dst, rel.replace("/", os.sep))
                os.makedirs(os.path.dirname(tp), exist_ok=True)
                shutil.copyfile(sp, tp)
            assets[kind].append(a)
    write_json(project_path(dst, "assets.json"), assets)

    # ── 6. 重建目标项目的 plan.json / shots.json，供工作台读取 ──
    print("吸收完成。接着跑 build + sync 让它生效。")
    return 0


def cmd_episodes(args):
    """列出本项目的分集概况（集号 / 镜数 / 已渲 / 成片）。"""
    pid = args.project
    need_project(pid)
    plan = read_json(project_path(pid, "plan.meta.json"), None) or {}
    clips = {c["shot"] for c in clips_of(pid)}
    eps = episodes_in(plan)
    per = {}
    for s in plan.get("shots") or []:
        e = shot_episode(s) or "（未分集）"
        d = per.setdefault(e, {"n": 0, "done": 0})
        d["n"] += 1
        if str(s.get("id")) in clips:
            d["done"] += 1
    print("项目 %s：%d 集 / %d 镜" % (pid, len(eps), len(plan.get("shots") or [])))
    for e in (eps + (["（未分集）"] if "（未分集）" in per else [])):
        d = per.get(e) or {"n": 0, "done": 0}
        fin = os.path.isfile(project_path(pid, "成片-%s.mp4" % e))
        print("  %-8s %2d 镜 · 已渲 %2d · 成片 %s" % (e, d["n"], d["done"], "有" if fin else "无"))
    return 0


# ───────────────────────── status ─────────────────────────

def cmd_status(args):
    pid = args.project
    d = need_project(pid)
    meta, params = params_of(pid)
    plan = read_json(project_path(pid, "plan.json"), None) or {}
    assets = read_json(project_path(pid, "assets.json"), {})
    print("项目 %s · %s · %s" % (pid, meta.get("title"), meta.get("genre")))
    print("画布 %sx%s · 每镜 %s 帧 · accel=%s · 转场=%s"
          % (params.get("width"), params.get("height"), params.get("defaultLength"),
             params.get("accel"), params.get("transition")))
    print("角色 %d / 场景 %d / 镜头 %d"
          % (len(plan.get("characters") or []), len(plan.get("scenes") or []),
             len(plan.get("shots") or [])))
    for kind in ("characters", "scenes"):
        for a in (assets.get(kind) or []):
            p = project_path(pid, str(a.get("image") or "").replace("/", os.sep))
            ok = "✓" if os.path.isfile(p) else "✗"
            print("  %s %s %s" % (ok, kind, a.get("name")))
    clips = [c for c in clips_of(pid) if not c["final"] and not c["take"]]
    done = [p for p in clips if os.path.getsize(project_path(pid, p["name"])) > 1024]
    total = 0.0
    for c in done:
        info = ffprobe_one(project_path(pid, c["name"]))
        total += (info or {}).get("duration") or 0
    print("镜头产物 %d/%d · 总时长 %.1fs" % (len(done), len(plan.get("shots") or []), total))
    print("成片：%s" % ("有" if os.path.isfile(project_path(pid, "成片.mp4")) else "无"))
    return 0


def cmd_build(args):
    """
    把 plan.meta.json + prompts/<id>.txt 合成为 plan.json。

    提示词一律以**纯文本文件**存放：六段式提示词里有换行、还有 <d>[Chinese]台词</d> 这类符号，
    手写进 JSON 字符串就要自己做转义，一个反斜杠写错整份方案就废了。分文件是唯一稳的写法。
    """
    pid = args.project
    need_project(pid)
    meta = read_json(project_path(pid, "plan.meta.json"), None)
    if not meta:
        raise SystemExit("缺少 plan.meta.json")
    plan = {
        "style": meta.get("style") or "",
        "characters": meta.get("characters") or [],
        "scenes": meta.get("scenes") or [],
        "shots": [],
    }
    missing, short = [], []
    for s in (meta.get("shots") or []):
        one = {k: v for k, v in s.items() if k != "prompt_file"}
        pf = s.get("prompt_file") or ("prompts/%s.txt" % s.get("id"))
        path = project_path(pid, str(pf).replace("/", os.sep))
        text = ""
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read().strip()
        if not text:
            missing.append(str(s.get("id")))
        elif len(text) < 40:
            short.append(str(s.get("id")))
        one["h3_prompt"] = text
        # **同时写 `prompt`**：渲染器只认 `prompt`，而工作台界面上的「渲染」按钮
        # 直接吃 shots.json。只写 h3_prompt 的话，点那个按钮会 15 镜全报"没有 prompt"。
        one["prompt"] = text
        plan["shots"].append(one)
    write_json(project_path(pid, "plan.json"), plan)
    print("plan.json 已生成：%d 角色 / %d 场景 / %d 镜"
          % (len(plan["characters"]), len(plan["scenes"]), len(plan["shots"])))
    for s in plan["shots"]:
        n = len(s.get("h3_prompt") or "")
        flag = "缺失" if not n else ("过短" if n < 40 else "OK")
        print("  %-5s %5d 字符  %s" % (s.get("id"), n, flag))
    if missing:
        print("⚠ 缺提示词文件的镜头：" + "、".join(missing))
    if short:
        print("⚠ 提示词过短的镜头：" + "、".join(short))
    return 0 if not (missing or short) else 1


def cmd_logs(args):
    """列出/查看已落盘的任务日志（渲染、质检、合成、管线）。"""
    pid = args.project
    need_project(pid)
    logdir = project_path(pid, "output", "logs")
    if not os.path.isdir(logdir):
        print("还没有日志（渲染/质检/合成跑完会自动写入 output/logs）")
        return 0
    files = []
    for name in os.listdir(logdir):
        if not name.lower().endswith(".log"):
            continue
        st = os.stat(os.path.join(logdir, name))
        files.append((st.st_mtime, name, st.st_size))
    files.sort(reverse=True)
    if not files:
        print("还没有日志")
        return 0
    print("共 %d 份日志（新 → 旧）：" % len(files))
    for mt, name, size in files[:20]:
        print("  %-32s %7.1f KB  %s" % (name, size / 1024, time.strftime("%m-%d %H:%M:%S", time.localtime(mt))))
    target = args.name or files[0][1]
    path = os.path.join(logdir, target)
    if not os.path.isfile(path):
        print("找不到日志：" + target)
        return 1
    print("\n===== %s（尾部 %d 行）=====" % (target, args.tail))
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()
    for line in lines[-args.tail:]:
        sys.stdout.write(line if line.endswith("\n") else line + "\n")
    return 0
