# -*- coding: utf-8 -*-
"""渲染：构图检查（dry-run）与调用渲染器。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import os
import subprocess
import sys

from .comfy import comfy_alive, comfy_free, comfy_url_of
from .jsonio import read_json, write_json
from .paths import MANJU_PY, PY_EXE, need_project, project_path, render_doc_path

def dry_run_graphs(rj, pid):
    """
    只构图、不提交：把"参数错误"和"接线问题"在 0 秒内暴露出来。

    存在的理由：渲染一镜要 5 分钟，而 90% 的低级错误（长度不在 17k+5 网格、分辨率不是
    32 倍数、参考图路径不存在、锚点帧接线写错）在构图阶段就能判死。跑真渲染去发现它们是浪费。
    """
    sys.path.insert(0, os.path.dirname(MANJU_PY))
    import manju  # 渲染器本体；导入不会执行 main
    doc = read_json(rj, {})
    shots = doc.get("shots") or []
    style = doc.get("style") or ""
    cfg = doc.get("defaults") or {}
    print("构图检查 %d 镜（不提交渲染）" % len(shots))
    bad = 0
    for s in shots:
        one = dict(s)
        one["_project"] = pid
        try:
            graph, meta = manju.build_graph(one, style, cfg)
        except Exception as e:
            print("  FAIL %-5s %s" % (s.get("id"), e))
            bad += 1
            continue
        guides = [n for n in graph.values() if n.get("class_type") == "MiniMaxH3AddGuide"]
        extra = []
        if meta.get("ref_count"):
            extra.append("参考图%d" % meta["ref_count"])
        if guides:
            extra.append("锚点%d(帧%s)" % (len(guides), ",".join(
                str(g.get("inputs", {}).get("frame_idx")) for g in guides)))
        print("  OK  %-5s %-6s %dx%d %d帧 seed=%-10s 节点%-3d %s" % (
            s.get("id"), meta["mode"], meta["width"], meta["height"], meta["length"],
            meta["seed"], len(graph), " ".join(extra)))
    print("构图检查：%s" % ("全部通过" if not bad else "%d 镜有问题" % bad))
    return 0 if not bad else 1


def cmd_render(args):
    pid = args.project
    need_project(pid)
    ep = str(getattr(args, "episode", "") or "").strip()
    rj = render_doc_path(pid, ep)
    if not os.path.isfile(rj):
        if ep:
            raise SystemExit("缺少 _render-%s.json —— 先跑 sync --project %s --episode %s" % (ep, pid, ep))
        raise SystemExit("缺少 _render.json —— 先跑 sync")
    only = [str(x) for x in (args.only or [])]
    if only:
        doc = read_json(rj, {})
        keep = [s for s in (doc.get("shots") or []) if str(s.get("id")) in only]
        if not keep:
            raise SystemExit("--only 里没有任何已知镜头：" + "、".join(only))
        doc["shots"] = keep
        rj = project_path(pid, "_render_fix.json")
        write_json(rj, doc)
        print("单镜返修：%s" % "、".join(s["id"] for s in keep), flush=True)
    # --out 可把产物写到别的目录：做 A/B 对比（例如换启动参数重渲同一镜）时
    # 不该覆盖已定稿的成片素材。
    outdir = args.out or project_path(pid)
    # 构图检查放在最前：它不需要 ComfyUI 在线（只是构图 + 校验），
    # 放在存活检查之后会让"服务没起"掩盖掉真正的参数错误。
    if args.dry_run:
        return dry_run_graphs(rj, pid)
    if not comfy_alive():
        raise SystemExit("ComfyUI 不可达 —— 先运行 D:\\Ai\\ComfyUI\\start-comfyui.cmd"
                         "（或用 manju-headless.py comfy start）")
    env = dict(os.environ)
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    cmd = [PY_EXE, "-X", "utf8", MANJU_PY, "render", "--shots", rj, "--out", outdir]
    if args.force or only:
        cmd.append("--force")
    print("渲染器：" + " ".join(cmd), flush=True)
    p = subprocess.Popen(cmd, cwd=project_path(pid), env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, encoding="utf-8", errors="replace", bufsize=1)
    for line in p.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
    code = p.wait()
    # 渲染完把显存/内存还给系统：空转时 ComfyUI 会一直压着 21.9 GB 显存 + 26 GB 内存不放
    # （实测 /free 后 21.9 GB → 0.99 GB）。**只在整批结束调**，不是每镜 ——
    # 每镜之间调会让下一镜重新加载权重，白白多花几十秒。
    if code == 0 and not args.no_free:
        url = comfy_url_of(pid)
        r = comfy_free(url)
        print("\n[free] 归还 ComfyUI 显存/内存：" + ("HTTP %s" % r.get("status") if r.get("ok") else str(r.get("error"))))
    return code
