#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
manju-headless.py —— 漫剧工作台「无头驱动器」

## 为什么存在

工作台的命令接口 `POST /api/manju-studio` 只在 DSH Desktop 的 Electron 渲染器内可用：
`lib/webserver.js` → `decideDesktopBrowserAccess()` 会校验 `x-dsh-desktop-renderer` 能力令牌，
外部进程（curl / Agent / CI）拿到的永远是 `403 forbidden`。于是 Agent 无法驱动工作台。

本脚本按**工作台自己的项目契约与配方**补齐这条无头通路：同一套目录布局、同一套
Krea-2 定妆配方、同一个渲染器（manju.py）、同一套合成规则（ASS 字幕 + loudnorm +
faststart）。产物落进同一个项目目录，因此工作台界面照样能列出、预览、播放。

## 项目目录 D:\\Ai\\漫剧\\<id>\\

    project.json     作品信息 + params（与工作台同一形状）
    plan.json        作者方案：characters / scenes / shots（含六段式 h3_prompt）
    shots.json       与 plan.json 同构（渲染前由 sync 从 plan 同步）
    assets.json      资产库（characters / scenes / props）
    assets/img/      资产图
    script/ep01.md   剧本
    <sid>.mp4        镜头产物       成片.mp4  成片
    output/final.ass 字幕           _render.json  渲染前解析好的参考图清单

## 子命令

    assets   用 Krea-2 生成缺失的定妆照 / 场景图
    sync     解析角色/场景参考图 → _render.json（顺序：角色按出场序，场景永远最后）
    render   调 manju.py 渲染 _render.json（已完成的镜头自动跳过）
    qc       机械质检（时长 / 音轨 / 分辨率 / 响度 / 黑场占比 / 削波）
    compose  ASS 字幕 + 响度归一 + faststart 合成成片
    status   项目状态一览

用法：python manju-headless.py assets --project jixin-wendao
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = r"D:\Ai\漫剧"
COMFY = "http://127.0.0.1:8199"
COMFY_OUTPUT = r"D:\Ai\ComfyUI\ComfyUI\output"
PY_EXE = r"D:\Ai\ComfyUI\standalone-env\python.exe"
MANJU_PY = r"C:\Users\Administrator\.dsh\skills\manju-render\scripts\manju.py"
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

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

# 参考图尺寸：Ref2VA 的 ref_image_size=match 会把参考图缩放到**本次生成的像素面积**，
# 所以参考图自己也该接近 1344×768 ≈ 1.03 MP，否则会被放大、细节先丢一层。
#   定妆照  832×1248 = 1.04 MP（2:3 半身，和工作台一致）
#   场景图 1344×768 = 1.03 MP（16:9，与成片画布同比例 —— 工作台的 832×480 只有 0.4 MP，
#                                 要放大 2.6 倍才进参考槽，这里按像素面积对齐）
CHAR_W, CHAR_H = 832, 1248
SCENE_W, SCENE_H = 1344, 768

TIMEOUT_GEN = 900

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


# ───────────────────────── 基础工具 ─────────────────────────

def project_path(pid, *parts):
    return os.path.join(ROOT, pid, *parts)


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)


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


def run(cmd, cwd=None, timeout=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return r.returncode, (r.stdout or ""), (r.stderr or "")


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
        return 0

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

    print("\n资产：成功 %d / 失败 %d" % (len(todo) - len(failed), len(failed)))
    for i, e in failed:
        print("  FAIL %s: %s" % (i, e))
    return 0 if not failed else 1


# ───────────────────────── sync（解析参考图）─────────────────────────

def resolve_refs(pid, shot, name_of):
    """参考图顺序 = 契约：角色按出场顺序在前，场景永远最后。"""
    assets = read_json(project_path(pid, "assets.json"), {"characters": [], "scenes": [], "props": []})
    refs, missing = [], []

    def find(arr, want):
        want_name = name_of.get(want, "")
        by_name = None
        for a in arr:
            if not a:
                continue
            if str(a.get("id")) == want:
                return a
            if want_name and a.get("name") == want_name and a.get("image"):
                by_name = a
        return by_name

    for cid in (shot.get("characters") or []):
        hit = find(assets.get("characters") or [], str(cid))
        if not hit or not hit.get("image"):
            missing.append(str(cid))
            continue
        refs.append(project_path(pid, str(hit["image"]).replace("/", os.sep)))
    if shot.get("scene"):
        hit = find(assets.get("scenes") or [], str(shot["scene"]))
        if hit and hit.get("image"):
            refs.append(project_path(pid, str(hit["image"]).replace("/", os.sep)))
        else:
            missing.append(str(shot["scene"]))
    return refs, missing


def cmd_sync(args):
    pid = args.project
    need_project(pid)
    meta, params = params_of(pid)
    plan = read_json(project_path(pid, "plan.json"), None)
    if not plan or not plan.get("shots"):
        raise SystemExit("缺少 plan.json 或 shots 为空")

    # shots.json 与 plan.json 同构（工作台里 plan 是作者方案、shots 是渲染源）
    shots_doc = {k: v for k, v in plan.items()}
    write_json(project_path(pid, "shots.json"), shots_doc)

    name_of = {}
    for c in (plan.get("characters") or []):
        if c.get("id"):
            name_of[str(c["id"])] = c.get("name") or ""

    shots, ref_total, with_ref, missing_all = [], 0, 0, []
    for s in plan["shots"]:
        one = dict(s)
        # 字段名转换是渲染器契约的一部分：方案里叫 h3_prompt（工作台/方案阶段的写法），
        # manju.py 只认 `prompt`。漏了这一步 15 个镜头会全部在 0 秒内报"没有 prompt"。
        one["prompt"] = s.get("h3_prompt") or s.get("prompt") or ""
        refs, missing = resolve_refs(pid, s, name_of)
        one.pop("characters", None)
        one.pop("scene", None)
        one.pop("dialogue", None)
        one.pop("shot_size", None)
        one.pop("camera", None)
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
    write_json(project_path(pid, "_render.json"), render_doc)
    print("已写 shots.json（%d 镜）与 _render.json" % len(shots))
    print("参考图 %d 张 · 走 Ref2VA %d/%d 镜 · ref_image_size=%s · accel=%s"
          % (ref_total, with_ref, len(shots), render_doc["defaults"]["ref_image_size"],
             render_doc["defaults"]["accel"]))
    if missing_all:
        print("⚠ 缺参考图的镜头：" + "；".join(missing_all))
        return 1
    return 0


# ───────────────────────── render ─────────────────────────

def cmd_render(args):
    pid = args.project
    need_project(pid)
    rj = project_path(pid, "_render.json")
    if not os.path.isfile(rj):
        raise SystemExit("缺少 _render.json —— 先跑 sync")
    if not comfy_alive():
        raise SystemExit("ComfyUI 不可达 —— 先运行 D:\\Ai\\ComfyUI\\start-comfyui.cmd")
    env = dict(os.environ)
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    cmd = [PY_EXE, "-X", "utf8", MANJU_PY, "render", "--shots", rj, "--out", project_path(pid)]
    if args.force:
        cmd.append("--force")
    print("渲染器：" + " ".join(cmd), flush=True)
    p = subprocess.Popen(cmd, cwd=project_path(pid), env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, encoding="utf-8", errors="replace", bufsize=1)
    for line in p.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
    return p.wait()


# ───────────────────────── qc ─────────────────────────

def ffprobe_one(path):
    code, out, _err = run([FFPROBE, "-v", "error", "-print_format", "json",
                           "-show_format", "-show_streams", path], timeout=120)
    if code != 0:
        return None
    try:
        info = json.loads(out or "{}")
    except Exception:
        return None
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    return {
        "duration": float((info.get("format") or {}).get("duration") or 0),
        "size": int(float((info.get("format") or {}).get("size") or 0)),
        "width": (v or {}).get("width"),
        "height": (v or {}).get("height"),
        "fps": (v or {}).get("r_frame_rate"),
        "nb_frames": (v or {}).get("nb_frames"),
        "has_audio": a is not None,
        "achannels": (a or {}).get("channels"),
        "acodec": (a or {}).get("codec_name"),
    }


def qc_one(path, min_duration=1.0, dark_fail=0.5, dark_warn=0.15, clip_fail=-0.1):
    rec = {"file": os.path.basename(path), "problems": [], "warnings": []}
    info = ffprobe_one(path)
    if not info:
        rec["problems"].append("ffprobe 读不出（文件损坏？）")
        return rec
    rec.update(info)
    if not info["has_audio"]:
        rec["problems"].append("无音轨（H3 产物应自带 32kHz 立体声）")
    if info["duration"] < min_duration:
        rec["problems"].append("时长过短 %.2fs" % info["duration"])
    if (info["width"] or 0) % 32 or (info["height"] or 0) % 32:
        rec["problems"].append("分辨率非 32 倍数")
    # 响度 / 削波
    code, out, err = run([FFMPEG, "-hide_banner", "-i", path, "-af", "volumedetect",
                          "-f", "null", "-"], timeout=300)
    txt = out + err
    m = re.search(r"mean_volume:\s*(-?[\d.]+)", txt)
    p = re.search(r"max_volume:\s*(-?[\d.]+)", txt)
    rec["mean_volume"] = float(m.group(1)) if m else None
    rec["max_volume"] = float(p.group(1)) if p else None
    if rec["mean_volume"] is not None and rec["mean_volume"] < -60:
        rec["problems"].append("疑似静音（mean_volume=%.1f）" % rec["mean_volume"])
    if rec["max_volume"] is not None and rec["max_volume"] >= clip_fail:
        rec["warnings"].append("音频削波风险（峰值 %.1f dB）" % rec["max_volume"])
    # 黑场占比
    code, out, err = run([FFMPEG, "-hide_banner", "-i", path, "-vf",
                          "blackdetect=d=0.1:pix_th=0.10", "-an", "-f", "null", "-"], timeout=300)
    blacks = [float(x) for x in re.findall(r"black_duration:([\d.]+)", out + err)]
    ratio = (sum(blacks) / info["duration"]) if info["duration"] else 0
    rec["dark_ratio"] = round(ratio, 3)
    if ratio >= dark_fail:
        rec["problems"].append("黑场占比 %.0f%%" % (ratio * 100))
    elif ratio >= dark_warn:
        rec["warnings"].append("黑场占比 %.0f%%" % (ratio * 100))
    return rec


def clips_of(pid):
    out = []
    d = project_path(pid)
    for name in sorted(os.listdir(d)):
        if not name.lower().endswith(".mp4"):
            continue
        m = re.match(r"^(.+)_take(\d+)\.mp4$", name, re.I)
        out.append({
            "name": name,
            "final": name.startswith("成片"),
            "take": int(m.group(2)) if m else 0,
            "shot": m.group(1) if m else name[:-4],
        })
    return out


def cmd_qc(args):
    pid = args.project
    need_project(pid)
    clips = [c for c in clips_of(pid) if not c["final"] and not c["take"]]
    if not clips:
        raise SystemExit("没有可质检的镜头")
    reports, bad = [], 0
    print("%-8s%8s%12s%8s%9s%7s  %s" % ("镜头", "时长", "分辨率", "帧数", "均值dB", "黑场", "问题"))
    for c in clips:
        rec = qc_one(project_path(pid, c["name"]))
        reports.append(rec)
        if rec["problems"]:
            bad += 1
        print("%-8s%8.2f%12s%8s%9s%7s  %s" % (
            c["shot"], rec.get("duration", 0),
            "%sx%s" % (rec.get("width"), rec.get("height")), rec.get("nb_frames") or "-",
            ("%.1f" % rec["mean_volume"]) if rec.get("mean_volume") is not None else "-",
            ("%.0f%%" % (rec.get("dark_ratio", 0) * 100)),
            "；".join(rec["problems"] + rec["warnings"]) or "OK"))
    write_json(project_path(pid, "output", "qc_report.json"),
               {"total": len(reports), "failed": bad, "reports": reports,
                "checkedAt": time.strftime("%Y-%m-%d %H:%M:%S")})
    print("\n质检：%d 镜，%s" % (len(reports), "全部通过" if bad == 0 else "%d 镜不合格" % bad))
    print("提醒：脚本查不出「人物崩了/风格跑偏」——画面必须抽帧后用视觉亲自看。")
    return 0 if bad == 0 else 1


# ───────────────────────── compose（ported from composeFinal）─────────────────────────

def visual_width(s):
    return sum(0.5 if ord(ch) < 0x2E80 else 1 for ch in str(s or ""))


def wrap_ass_text(text, max_units):
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if not s:
        return ""
    if visual_width(s) <= max_units:
        return s
    lines, cur, cur_w = [], "", 0
    for ch in s:
        cur += ch
        cur_w += 0.5 if ord(ch) < 0x2E80 else 1
        brk = bool(re.match(r"[，。！？、；：…,\.!\?;:]", ch))
        if cur_w >= max_units or (brk and cur_w >= max_units * 0.72):
            lines.append(cur)
            cur, cur_w = "", 0
    if cur:
        lines.append(cur)
    if len(lines) > 3:
        lines = lines[:2] + ["".join(lines[2:])]
    return "\\N".join(lines)


def ass_time(sec):
    s = max(0.0, float(sec or 0))
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    ss = int(s % 60)
    cs = min(99, int(round((s - int(s)) * 100)))
    p2 = lambda n: ("0" + str(n)) if n < 10 else str(n)
    return "%d:%s:%s.%s" % (h, p2(m), p2(ss), p2(cs))


def build_ass(shots, starts, width, height, size_pct=5.0):
    margin_v = int(round(height * 0.06))
    size = max(18, int(round(height * size_pct / 100)))
    margin_lr = int(round(width * 0.07))
    max_units = max(6, int(((width - margin_lr * 2) / size) * 0.96))
    outline = max(2, int(round(size * 0.09)))
    shadow = max(1, int(round(size * 0.05)))

    def style(name, color, italic):
        return ("Style: %s,Microsoft YaHei,%d,%s,&H000000FF,&H00000000,&H96000000,0,%d,0,0,100,100,0,0,1,"
                "%d,%d,2,%d,%d,%d,134" % (name, size, color, 1 if italic else 0,
                                          outline, shadow, margin_lr, margin_lr, margin_v))

    lines = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: %d" % width, "PlayResY: %d" % height,
        "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        style("对白", "&H00FFFFFF", False),
        style("旁白", "&H00D8E8F5", True),
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    n = 0
    for i, s in enumerate(shots):
        dlg = s.get("dialogue") or []
        if not dlg:
            continue
        start = starts[i] if i < len(starts) else 0
        dur = s.get("_dur") or 0
        if dur <= 0.05:
            continue
        each = dur / len(dlg)
        for k, d in enumerate(dlg):
            txt = str((d or {}).get("text") or "").strip()
            if not txt:
                continue
            is_narr = bool(re.search(r"旁白|narrator|voiceover", str((d or {}).get("speaker") or ""), re.I))
            t0 = start + each * k
            t1 = start + each * (k + 1) - 0.06
            if t1 - t0 < 0.2:
                continue
            lines.append("Dialogue: 0,%s,%s,%s,%s,0,0,0,,%s" % (
                ass_time(t0), ass_time(t1), "旁白" if is_narr else "对白",
                str((d or {}).get("speaker") or ""), wrap_ass_text(txt, max_units)))
            n += 1
    return "\n".join(lines), n, size, max_units


def cmd_compose(args):
    pid = args.project
    d = need_project(pid)
    meta, params = params_of(pid)
    canvas_w = int(params.get("width") or 1344)
    canvas_h = int(params.get("height") or 768)
    loud = args.loudness if args.loudness is not None else (params.get("loudness") or -16)
    size_pct = args.subtitle_size if args.subtitle_size is not None else (params.get("subtitleSize") or 5)
    transition = args.transition or params.get("transition") or "cut"
    if transition == "dissolve":
        transition = "fade"
    if transition not in ("cut", "fade"):
        transition = "cut"

    clips = [c for c in clips_of(pid) if not c["final"] and not c["take"]]
    names = [c["name"] for c in clips]
    if not names:
        raise SystemExit("没有可合成的镜头")
    if args.range:
        lo, hi = args.range
        names = [n for n in names if lo <= int(re.sub(r"\D", "", n) or 0) <= hi]

    dur = []
    for nm in names:
        info = ffprobe_one(os.path.join(d, nm))
        dur.append(info["duration"] if info and info.get("duration", 0) > 0 else 5.0)
    F = 0.5
    starts, acc = [], 0.0
    for i in range(len(names)):
        starts.append(acc)
        acc += dur[i] - (F if (transition == "fade" and i < len(names) - 1) else 0)

    plan = read_json(project_path(pid, "plan.json"), None) or {}
    plan_shots = plan.get("shots") or []
    board = []
    for i, nm in enumerate(names):
        sid = nm[:-4]
        hit = next((s for s in plan_shots if str(s.get("id")) == sid), None) or {"id": sid}
        board.append(dict(hit, _dur=dur[i]))

    want_subs = args.no_subtitles is False or True
    built = build_ass(board, starts, canvas_w, canvas_h, size_pct)
    sub_filter = ""
    if built[1] > 0:
        os.makedirs(project_path(pid, "output"), exist_ok=True)
        with open(project_path(pid, "output", "final.ass"), "w", encoding="utf-8") as fh:
            fh.write(built[0])
        # libass 不认带引号的 Windows 盘符绝对路径 → 用相对路径 + cwd=项目根
        sub_filter = "subtitles=filename=output/final.ass"

    af = "loudnorm=I=%s:TP=-1.5:LRA=11" % loud
    venc = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]
    aenc = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    target = os.path.join(d, "成片.mp4")
    if os.path.isfile(target):
        os.remove(target)

    if transition == "cut" or len(names) == 1:
        lst = os.path.join(d, "_concat.txt")
        with open(lst, "w", encoding="utf-8") as fh:
            for nm in names:
                fh.write("file '" + os.path.join(d, nm).replace("\\", "/") + "'\n")
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-f", "concat", "-safe", "0", "-i", lst]
        if sub_filter:
            cmd += ["-vf", sub_filter]
        cmd += venc + ["-af", af] + aenc + ["-movflags", "+faststart", target]
    else:
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
        for nm in names:
            cmd += ["-i", os.path.join(d, nm)]
        parts, vlab, alab, acc2 = [], "0:v", "0:a", dur[0]
        for i in range(1, len(names)):
            off = max(0.0, acc2 - F)
            parts.append("[%s][%d:v]xfade=transition=fade:duration=%s:offset=%.3f[v%d]"
                         % (vlab, i, F, off, i))
            parts.append("[%s][%d:a]acrossfade=d=%s[a%d]" % (alab, i, F, i))
            vlab, alab = "v%d" % i, "a%d" % i
            acc2 += dur[i] - F
        if sub_filter:
            parts.append("[%s]%s[vsub]" % (vlab, sub_filter))
            vlab = "vsub"
        cmd += ["-filter_complex", ";".join(parts), "-map", "[%s]" % vlab, "-map", "[%s]" % alab,
                "-af", af] + venc + aenc + ["-movflags", "+faststart", target]

    print("合成 %d 镜 · 转场 %s · 字幕 %d 条（字号 %dpx / 每行最多 %d 全角字）"
          % (len(names), transition, built[1], built[2], built[3]), flush=True)
    code, out, err = run(cmd, cwd=d, timeout=1800)
    if code != 0:
        print((err or out)[-2000:])
        raise SystemExit("ffmpeg 合成失败（退出码 %s）" % code)
    info = ffprobe_one(target)
    print("成片 %s" % target)
    if info:
        print("  %.2fs  %sx%s  %.2f MB" % (info["duration"], info["width"], info["height"],
                                           info["size"] / 1024 / 1024))
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


def main():
    ap = argparse.ArgumentParser(prog="manju-headless", description="漫剧工作台无头驱动器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="plan.meta.json + prompts/*.txt → plan.json")
    b.add_argument("--project", required=True)
    b.set_defaults(func=cmd_build)

    a = sub.add_parser("assets", help="Krea-2 生成缺失的定妆照/场景图")
    a.add_argument("--project", required=True)
    a.add_argument("--only", nargs="*", help="只生成这些 id")
    a.add_argument("--force", action="store_true")
    a.add_argument("--seed", type=int, default=0)
    a.set_defaults(func=cmd_assets)

    s = sub.add_parser("sync", help="解析参考图 → _render.json")
    s.add_argument("--project", required=True)
    s.set_defaults(func=cmd_sync)

    r = sub.add_parser("render", help="调 manju.py 渲染")
    r.add_argument("--project", required=True)
    r.add_argument("--force", action="store_true")
    r.set_defaults(func=cmd_render)

    q = sub.add_parser("qc", help="机械质检")
    q.add_argument("--project", required=True)
    q.set_defaults(func=cmd_qc)

    c = sub.add_parser("compose", help="字幕 + 响度归一 + faststart 合成")
    c.add_argument("--project", required=True)
    c.add_argument("--transition", default=None, choices=["cut", "fade"])
    c.add_argument("--loudness", type=float, default=None)
    c.add_argument("--subtitle-size", dest="subtitle_size", type=float, default=None)
    c.add_argument("--range", nargs=2, type=int, default=None, help="只合成这个镜头区间（调试用）")
    c.add_argument("--no-subtitles", dest="no_subtitles", action="store_true")
    c.set_defaults(func=cmd_compose)

    st = sub.add_parser("status", help="项目状态")
    st.add_argument("--project", required=True)
    st.set_defaults(func=cmd_status)

    args = ap.parse_args()
    return args.func(args) or 0


if __name__ == "__main__":
    sys.exit(main())
