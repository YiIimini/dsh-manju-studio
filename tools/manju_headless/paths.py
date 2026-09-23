# -*- coding: utf-8 -*-
"""路径与项目定位：项目根、渲染器位置、项目目录约定。**只放常量与纯路径函数**。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import os
import re
import shutil

from .jsonio import read_json

ROOT = r"D:\Ai\漫剧"


COMFY = "http://127.0.0.1:8199"


COMFY_OUTPUT = r"D:\Ai\ComfyUI\ComfyUI\output"


COMFY_DIR = r"D:\Ai\ComfyUI\ComfyUI"


COMFY_LOGDIR = r"D:\Ai\ComfyUI\logs"


# 资源治理参数：与工作台的 COMFY_FLAGS、start-comfyui.cmd 三处保持一致。
# 不带它们的后果是实测过的：空转 26 GB 内存 + 21.9 GB 显存不放（GPU 利用率 5%）。
#   --cache-none            不缓存节点产物
#   --disable-smart-memory  用不到就卸载，不跟别的程序抢显存
#   --vram-headroom 1.5     连别的程序占掉的显存也算进余量
COMFY_GOVERNANCE_FLAGS = ["--cache-none", "--disable-smart-memory", "--vram-headroom", "1.5"]


PY_EXE = r"D:\Ai\ComfyUI\standalone-env\python.exe"


MANJU_PY = r"C:\Users\Administrator\.dsh\skills\manju-render\scripts\manju.py"


FFMPEG = shutil.which("ffmpeg") or "ffmpeg"


FFPROBE = shutil.which("ffprobe") or "ffprobe"


# ───────────────────────── 基础工具 ─────────────────────────

def project_path(pid, *parts):
    return os.path.join(ROOT, pid, *parts)


def need_project(pid):
    if not re.match(r"^[A-Za-z0-9_-]{1,40}$", pid or ""):
        raise SystemExit("项目 id 非法（只允许字母/数字/下划线/连字符）")
    d = project_path(pid)
    if not os.path.isdir(d):
        raise SystemExit("项目不存在：" + d)
    return d


def params_of(pid):
    meta = read_json(project_path(pid, "project.json"), {})
    return meta, (meta.get("params") or {})


def render_doc_path(pid, episode):
    """某集的渲染清单路径；不传集就是项目级的 _render.json（兼容老用法）。"""
    return project_path(pid, ("_render-%s.json" % episode) if episode else "_render.json")
