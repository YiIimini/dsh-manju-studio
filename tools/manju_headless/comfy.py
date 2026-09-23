# -*- coding: utf-8 -*-
"""ComfyUI 客户端与引擎治理：健康检查、显存归还、图像模型配方、跑图、启动/停止。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request

from .paths import COMFY, COMFY_DIR, COMFY_GOVERNANCE_FLAGS, COMFY_LOGDIR, PY_EXE, params_of, project_path
from .procs import run

# ── Krea-2 定妆配方（与工作台 imageRecipe 一致；本机实测通过，别凭直觉改）──
#   * Krea2 的 latent_format 是 Wan21，**不是 Flux**：必须用 qwen_image_vae.safetensors，
#     用 ae.safetensors 解码会出满屏规则网格伪影。
#   * 文本编码器是 Qwen3-VL-4B 的 12 层抽取，CLIPLoader 类型必须写 `krea2`。
#   * krea2_turbo 是蒸馏权重（CFG 1.0）+ 8 步，步数给多反而糊。
IMG_UNET = "krea2_turbo_fp8_scaled.safetensors"


IMG_CLIP = "qwen3vl_4b_fp8_scaled.safetensors"


IMG_CLIP_TYPE = "krea2"


IMG_VAE = "qwen_image_vae.safetensors"


IMG_STEPS = 8


IMG_CFG = 1.0


TIMEOUT_GEN = 900


# ───────────────────────── ComfyUI ─────────────────────────

def _post(url, payload, timeout=120):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def comfy_alive(url=COMFY):
    try:
        _get(url + "/system_stats", timeout=8)
        return True
    except Exception:
        return False


def comfy_url_of(pid):
    _meta, params = params_of(pid)
    return str(params.get("comfyUrl") or COMFY).rstrip("/")


def comfy_free(url=COMFY):
    """POST /free —— 卸载模型并释放缓存。实测显存 21.9 GB → 0.99 GB（HTTP 200）。"""
    try:
        body = json.dumps({"unload_models": True, "free_memory": True}).encode("utf-8")
        req = urllib.request.Request(url + "/free", data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return {"ok": True, "status": resp.status}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def comfy_vram(url=COMFY):
    try:
        st = _get(url + "/system_stats", timeout=10)
        dev = (st.get("devices") or [{}])[0]
        return {
            "name": dev.get("name"),
            "totalMB": round((dev.get("vram_total") or 0) / 2 ** 20),
            "usedMB": round(((dev.get("vram_total") or 0) - (dev.get("vram_free") or 0)) / 2 ** 20),
            "freeMB": round((dev.get("vram_free") or 0) / 2 ** 20),
        }
    except Exception:
        return None


def comfy_pids():
    """按命令行找 ComfyUI 主进程 —— 比按端口找更稳（端口可能被别的进程占）。"""
    code, out, _err = run(["powershell", "-NoProfile", "-Command",
                           "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
                           "Where-Object { $_.CommandLine -match 'ComfyUI' -and $_.CommandLine -match 'main\\.py' } | "
                           "ForEach-Object { $_.ProcessId }"], timeout=60)
    pids = []
    for tok in (out or "").split():
        tok = tok.strip()
        if tok.isdigit():
            pids.append(int(tok))
    return pids


def comfy_rss_gb():
    code, out, _err = run(["powershell", "-NoProfile", "-Command",
                           "(Get-Process python -ErrorAction SilentlyContinue | "
                           "Measure-Object -Property WorkingSet64 -Sum).Sum"], timeout=30)
    try:
        return round(float((out or "0").strip()) / 2 ** 30, 2)
    except Exception:
        return 0.0


def build_image_graph(prompt, width, height, seed):
    """Krea-2 文生图图（与工作台 buildImageGraph 逐字一致）。"""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": IMG_UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": IMG_CLIP, "type": IMG_CLIP_TYPE, "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": IMG_VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "positive": ["4", 0], "negative": ["4", 0], "latent_image": ["5", 0],
            "seed": seed, "steps": IMG_STEPS, "cfg": IMG_CFG,
            "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "manju_assets/gen"}},
    }


def comfy_run_graph(graph, timeout=TIMEOUT_GEN, label=""):
    try:
        r = _post(COMFY + "/prompt", {"prompt": graph, "client_id": "manju-headless"}, timeout=120)
    except Exception as e:
        return None, "提交失败：" + str(e)
    if r.get("node_errors"):
        return None, "节点校验失败：" + json.dumps(r["node_errors"], ensure_ascii=False)[:600]
    pid = r.get("prompt_id")
    if not pid:
        return None, "未返回 prompt_id"
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(3)
        try:
            h = _get(COMFY + "/history/" + pid, timeout=20)
        except Exception:
            continue
        entry = h.get(pid)
        if not entry:
            continue
        st = entry.get("status") or {}
        if st.get("status_str") == "error":
            return None, "执行报错：" + json.dumps(st, ensure_ascii=False)[:600]
        if st.get("completed") or st.get("status_str") == "success":
            files = []
            for _nid, out in (entry.get("outputs") or {}).items():
                for im in (out.get("images") or []):
                    files.append(im)
            if not files:
                return None, "完成但没有产出图片"
            return files, None
    return None, "超时 %ds" % timeout


def cmd_comfy(args):
    """
    ComfyUI 的资源治理：status / free / stop / start。

    为什么要做成子命令：空转的 ComfyUI 实测压着 26 GB 内存 + 21.9 GB 显存不放
    （GPU 利用率 5%），而 /free 能把显存打回 0.99 GB。这类"看一眼、放一放"的操作，
    Agent 应该能一条命令做完，而不是去猜进程号。
    """
    pid = getattr(args, "project", "") or ""
    url = comfy_url_of(pid) if pid and os.path.isdir(project_path(pid)) else COMFY
    act = args.action

    if act == "status":
        up = comfy_alive(url)
        print("ComfyUI：%s（%s）" % ("在线" if up else "离线", url))
        v = comfy_vram(url) if up else None
        if v:
            print("  显存 已用 %dMB / %dMB（余 %dMB）" % (v["usedMB"], v["totalMB"], v["freeMB"]))
        print("  python 进程 RSS 合计 %.2f GB" % comfy_rss_gb())
        pids = comfy_pids()
        print("  主进程 PID：" + (",".join(str(x) for x in pids) if pids else "无"))
        return 0

    if act == "free":
        if not comfy_alive(url):
            print("ComfyUI 不在线，无需释放")
            return 0
        before = comfy_vram(url) or {}
        r = comfy_free(url)
        time.sleep(1.5)
        after = comfy_vram(url) or {}
        if not r.get("ok"):
            print("释放失败：" + str(r.get("error")))
            return 1
        print("已归还：显存 %sMB → %sMB，进程 RSS 合计 %.2f GB"
              % (before.get("usedMB"), after.get("usedMB"), comfy_rss_gb()))
        return 0

    if act == "stop":
        pids = comfy_pids()
        if not pids:
            print("没有在跑的 ComfyUI 进程")
            return 0
        for p in pids:
            run(["taskkill", "/PID", str(p), "/T", "/F"], timeout=60)
        time.sleep(3)
        left = comfy_pids()
        print("已停止 PID %s；剩余 %s" % (",".join(str(x) for x in pids),
                                      ",".join(str(x) for x in left) if left else "无"))
        print("  python 进程 RSS 合计 %.2f GB" % comfy_rss_gb())
        return 0 if not left else 1

    if act == "start":
        if comfy_alive(url):
            print("已在运行：" + url)
            return 0
        port = "8199"
        m = re.search(r":(\d+)", url)
        if m:
            port = m.group(1)
        os.makedirs(COMFY_LOGDIR, exist_ok=True)
        fo = open(os.path.join(COMFY_LOGDIR, "comfy-headless.out.log"), "w", encoding="utf-8")
        fe = open(os.path.join(COMFY_LOGDIR, "comfy-headless.err.log"), "w", encoding="utf-8")
        env = dict(os.environ)
        env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        argv = [PY_EXE, "main.py", "--port", port, "--listen", "127.0.0.1"] + COMFY_GOVERNANCE_FLAGS
        print("启动：" + " ".join(argv))
        subprocess.Popen(argv, cwd=COMFY_DIR, env=env, stdout=fo, stderr=fe,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        t0 = time.time()
        while time.time() - t0 < 240:
            if comfy_alive(url):
                v = comfy_vram(url) or {}
                print("就绪，用时 %ds；显存余 %sMB" % (int(time.time() - t0), v.get("freeMB")))
                return 0
            time.sleep(4)
        print("启动超时，看日志：" + os.path.join(COMFY_LOGDIR, "comfy-headless.err.log"))
        return 1

    raise SystemExit("未知动作：" + act)
