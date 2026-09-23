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
import difflib
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
# 封面与缩略图同比：成品列表缩略图是 56×32（≈16:9），竖版海报会被裁成中间一条
COVER_W, COVER_H = 1344, 768


def cover_brief(meta, params, plan=None):
    """
    封面提示词 —— **要的是"这一集的门面"，不是人物照**（用户明确要求）。

    定妆照是 Ref2VA 的身份锚点（正面半身、中性背景、表情克制），拿它当封面等于
    把海报做成证件照；而且它代表"某个人"，封面要代表整部片子。
    所以封面一律环境优先、人物只能是远处剪影（不出现可辨五官），并留出上部留白给标题
    —— 标题由界面叠在图上（.mj-covertitle），因此图里**绝不能带字**。

    素材来源：作品的题材 + 简介 + **它自己的场景设计**。
    用作品自己的场景当取景对象，封面才和正片是一套世界观；
    街市那类场景会招来招牌伪汉字，所以这里额外点名"不要招牌/匾额/幡布"。
    """
    style = (params.get("style") or "").strip()
    genre = str(meta.get("genre") or "").strip()
    syn = str(meta.get("synopsis") or "").strip()
    custom = str(meta.get("coverPrompt") or "").strip()
    parts = []
    # **绝不把片名写进提示词**：写进去模型就会把字画在图上，而 H3/Krea 画汉字必歪；
    # 况且界面本来就会把标题叠在缩略图上（.mj-covertitle）—— 图里再带字就是双标题 + 错字。
    parts.append("EPISODE KEY ART — one single iconic wide cinematic image serving as the cover of a Chinese 2.5D "
                 "animated series episode.")
    if genre:
        parts.append("Genre: " + genre + ".")
    if syn:
        parts.append("Story premise: " + syn)
    # 取作品自己的场景做取景对象 —— **只取一个**。
    # 实测教训：给两个场景，模型会画出**四宫格拼贴**（一眼就是"用模板套的"），
    # 明确写 no collage 也压不住。封面必须是"一张照片"，所以只喂一个场景。
    scenes = []
    for s in ((plan or {}).get("scenes") or [])[:1]:
        d = str(s.get("description") or "").strip()
        if d:
            scenes.append(d)
    if scenes:
        parts.append("SETTING — drawn from this series' own scene design: " + scenes[0])
    if custom:
        parts.append("Additional art direction: " + custom)
    parts.append("COMPOSITION: ONE single continuous photographic frame — a single environment-first wide shot that "
                 "captures the mood of the whole episode — a strong sense of place, dramatic light and atmosphere, deep "
                 "depth staging, clear silhouette and colour separation, rich incidental detail. A small distant figure "
                 "may appear only for scale, seen from behind or as an unlit silhouette, never showing a readable face. "
                 "Leave the upper third calm and uncluttered so an episode title can be overlaid later.")
    parts.append("MUST NOT: no collage, no split screen, no panels, no insets, no divided sections, no borders, no frames "
                 "within frames, no multiple views of different places, no character portrait, no close-up face, no "
                 "front-facing bust, no cast line-up, no beauty close-up, no market street, no shop fronts, no hanging "
                 "signboards, no plaques, no banners, no scrolls, no text, no lettering, no calligraphy, no glyphs, no "
                 "symbols that look like writing, no logo, no watermark, no UI."
                 " The image must read as the poster of a PLACE and a MOMENT, not as a portrait of a person and not as "
                 "a set of thumbnails.")
    if style:
        parts.append("RENDER STYLE (surface only, never changes features): " + style)
    return "\n\n".join(parts)


def cover_rel(pid):
    """项目封面的相对路径；没有则返回空串。"""
    meta = read_json(project_path(pid, "project.json"), {})
    rel = str(meta.get("cover") or "").strip()
    if rel and os.path.isfile(project_path(pid, rel.replace("/", os.sep))):
        return rel
    for name in ("cover.png", "cover.jpg", "cover.jpeg", "cover.webp"):
        if os.path.isfile(project_path(pid, name)):
            return name
    return ""


def gen_cover(pid, force=False):
    """生成独立封面 → 项目根 cover.png，并写回 project.json。"""
    if cover_rel(pid) and not force:
        print("封面已有，跳过（--force 可重做）")
        return 0
    meta, params = params_of(pid)
    if not str(meta.get("title") or "").strip():
        print("项目没有标题，跳过封面（封面按标题/题材/简介生成）")
        return 0
    prompt = cover_brief(meta, params, read_json(project_path(pid, "plan.json"), None))
    seed = 1000 + int(time.time() * 1000) % 900000
    print("生成封面「%s」%dx%d seed=%d …" % (meta.get("title"), COVER_W, COVER_H, seed), flush=True)
    files, err = comfy_run_graph(build_image_graph(prompt, COVER_W, COVER_H, seed))
    if err:
        print("    FAIL " + err)
        return 1
    f = files[0]
    src = os.path.join(COMFY_OUTPUT, str(f.get("subfolder") or "").replace("/", os.sep), f["filename"])
    dst = project_path(pid, "cover.png")
    shutil.copyfile(src, dst)
    if os.path.getsize(dst) < 1024:
        print("    FAIL 产物过小")
        return 1
    meta["cover"] = "cover.png"
    meta["coverSeed"] = seed
    meta["coverAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    write_json(project_path(pid, "project.json"), meta)
    print("    ✓ cover.png（独立封面，非人物定妆照）")
    return 0

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


def run(cmd, cwd=None, timeout=None, env=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout, env=env)
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


# ───────────────────────── sync（解析参考图）─────────────────────────

# ───────────────────────── 系列资产池（跨集一致性）─────────────────────────
#
# 为什么必须有：**每一集的定妆照如果各自重新生成，脸就会漂**。
# 单集内部靠 Ref2VA 锁得住脸，但 EP02 是一个新项目、新 seed、看起来"差不多"的另一个人
# —— 连载剧最致命的穿帮就是这个。
# 所以定妆照属于**系列**，不属于某一集：项目里写 `"series": "<系列名>"`，
# 生成时先查系列池，池里有就直接复制进来（逐字节同一张脸），池里没有才生成，生成后入池。
# 池是权威、先到先得：后一集永远不许覆盖前一集已经定下来的脸。
SERIES_DIRNAME = "_series"
SERIES_KINDS = ("characters", "scenes", "props")


def series_id(pid):
    meta = read_json(project_path(pid, "project.json"), {})
    return str(meta.get("series") or "").strip()


def series_dir(series):
    return os.path.join(ROOT, SERIES_DIRNAME, series) if series else ""


def series_assets(series):
    if not series:
        return {k: [] for k in SERIES_KINDS}
    d = read_json(os.path.join(series_dir(series), "assets.json"), {k: [] for k in SERIES_KINDS})
    for k in SERIES_KINDS:
        d.setdefault(k, [])
    return d


def series_find(series, kind, item):
    """在系列池里按 id 或 name 找已有条目（两者都认：不同集可能只带名字）。"""
    want_id = str(item.get("id") or "")
    want_name = str(item.get("name") or "")
    for a in (series_assets(series).get(kind) or []):
        if not a or not a.get("image"):
            continue
        if want_id and str(a.get("id")) == want_id:
            return a
        if want_name and str(a.get("name")) == want_name:
            return a
    return None


def series_register(series, kind, name, src_abs, extra=None):
    """把一个定妆照/场景图登记进系列池。**已存在则不覆盖**（池是权威，先到先得）。"""
    if not series:
        return None
    d = series_assets(series)
    for a in d[kind]:
        if a and (a.get("name") and a.get("name") == name):
            return a
    base = os.path.basename(src_abs)
    dst = os.path.join(series_dir(series), "img", base)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src_abs, dst)
    entry = {"name": name, "image": "img/" + base}
    if extra:
        entry.update(extra)
    d[kind].append(entry)
    write_json(os.path.join(series_dir(series), "assets.json"), d)
    return entry


def series_pull(pid, series, kind, item, assets):
    """
    把系列池里的条目复制进本项目并登记（返回 True 表示真的用上了池里的脸）。
    复制而不是引用：/manju-file 只允许项目内的相对路径，引项目外的文件界面就看不见图。
    """
    hit = series_find(series, kind, item)
    if not hit:
        return False
    src = os.path.join(series_dir(series), str(hit["image"]).replace("/", os.sep))
    if not os.path.isfile(src):
        return False
    base = os.path.basename(src)
    rel = "assets/img/" + base
    dst = project_path(pid, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    entry = {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "desc": str(item.get("description") or "")[:200],
        "image": rel,
        "fromSeries": series,
    }
    arr = assets.setdefault(kind, [])
    for i, a in enumerate(arr):
        if a and str(a.get("id")) == entry["id"]:
            arr[i] = dict(a, **entry)
            return True
    arr.append(entry)
    return True


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


def extract_last_frame(pid, clip_rel, dst_rel):
    """抽某一镜的**末帧**存成 jpg —— 用于把它钉到下一镜的第 0 帧（镜间衔接）。"""
    src = project_path(pid, clip_rel.replace("/", os.sep))
    if not os.path.isfile(src):
        return None
    dst = project_path(pid, dst_rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    # -sseof 从结尾往前 seek：不能用 -ss <时长>，容器时长有小数误差会取到黑帧
    code, _out, _err = run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                            "-sseof", "-0.12", "-i", src, "-frames:v", "1", "-q:v", "2", dst], timeout=180)
    if code != 0 or not os.path.isfile(dst):
        return None
    return dst


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
        if run and prev is not None and shot_run(prev) == run and not s.get("chain_from_prev"):
            s["chain_from_prev"] = True
            n += 1
        prev = s
    return n


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


def render_doc_path(pid, episode):
    """某集的渲染清单路径；不传集就是项目级的 _render.json（兼容老用法）。"""
    return project_path(pid, ("_render-%s.json" % episode) if episode else "_render.json")


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


def _norm_text(s):
    """只留中日韩汉字与字母数字：标点/空白不参与比对（转写不会给一样的标点）。"""
    return re.sub(r"[^\u4e00-\u9fff0-9A-Za-z]", "", str(s or ""))


def _asr_segments(raw):
    """
    从转写文件里取出**分段**（带时间戳那些行），并补上"相邻段拼接"的候选。

    为什么要拼接：ASR 会按停顿把一句话切成两段（"我听不见人话" / "可我听得见规矩"），
    拿整句去比任何单段都只有 0.5 左右 —— 那是比对方式的错，不是语音的错（实测栽过）。
    """
    segs = []
    for line in str(raw or "").splitlines():
        m = re.match(r"^\[\s*[\d.]+-\s*[\d.]+\]\s*(.+)$", line.strip())
        if m and m.group(1).strip():
            segs.append(_norm_text(m.group(1)))
    out = list(segs)
    for i in range(len(segs) - 1):
        out.append(segs[i] + segs[i + 1])
    for i in range(len(segs) - 2):
        out.append(segs[i] + segs[i + 1] + segs[i + 2])
    return out


def _best_sim(want, cands):
    """
    台词 vs 转写候选的最高相似度。

    先用"包含"做快路径（听对了就是这么回事），再退到相似度 —— ASR 必错同音字
    （守/首、默/末、应/硬），全等会把"听对了"判成"没听对"。
    """
    if not want:
        return 0.0
    best = 0.0
    for c in cands:
        if not c:
            continue
        if want in c:
            return 1.0
        r = difflib.SequenceMatcher(None, want, c).ratio()
        if r > best:
            best = r
    return best


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
    rec = {"file": os.path.basename(path), "problems": [], "warnings": [], "ok": False}
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
    # **`ok` 是工作台故事板判"合格/不合格"的唯一依据**（客户端读 qc.byFile[sid].ok）。
    # 漏了它 → undefined → 全部镜头显示"不合格"。工作台自己的 qcOneClip 也写这个字段
    # （lib/index.js 的 rec.ok = rec.problems.length === 0），必须一致。
    rec["ok"] = len(rec["problems"]) == 0
    return rec


def clips_of(pid):
    out = []
    d = project_path(pid)
    for name in sorted(os.listdir(d)):
        if not name.lower().endswith(".mp4"):
            continue
        # 下划线开头是内部中间产物（片头卡等），不算镜头：质检与产物清单都不该看见它
        if name.startswith("_"):
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
    reports, bad, warned = [], 0, 0
    print("%-8s%8s%12s%8s%9s%7s  %s" % ("镜头", "时长", "分辨率", "帧数", "均值dB", "黑场", "问题"))
    for c in clips:
        rec = qc_one(project_path(pid, c["name"]))
        reports.append(rec)
        if rec["problems"]:
            bad += 1
        if rec["warnings"]:
            warned += 1
        print("%-8s%8.2f%12s%8s%9s%7s  %s" % (
            c["shot"], rec.get("duration", 0),
            "%sx%s" % (rec.get("width"), rec.get("height")), rec.get("nb_frames") or "-",
            ("%.1f" % rec["mean_volume"]) if rec.get("mean_volume") is not None else "-",
            ("%.0f%%" % (rec.get("dark_ratio", 0) * 100)),
            "；".join(rec["problems"] + rec["warnings"]) or "OK"))
    write_json(project_path(pid, "output", "qc_report.json"),
               {"total": len(reports), "failed": bad, "warned": warned, "reports": reports,
                "checkedAt": time.strftime("%Y-%m-%d %H:%M:%S")})
    print("\n质检：%d 镜，%s" % (len(reports), "全部通过" if bad == 0 else "%d 镜不合格" % bad))
    print("提醒：脚本查不出「人物崩了/风格跑偏」——画面必须抽帧后用视觉亲自看。")
    return 0 if bad == 0 else 1


# ───────────────────────── compose（ported from composeFinal）─────────────────────────

# 片头卡字体：优先行楷/楷体（国风），退回雅黑。**用 .ttf**：.ttc 字体集合在 drawtext 里
# 需要 `fontindex` 才能选到字面，取不准就会退成方块。
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\STXINGKA.TTF",
    r"C:\Windows\Fonts\simkai.ttf",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
]


def pick_font():
    for p in FONT_CANDIDATES:
        if os.path.isfile(p):
            return p
    return ""


def make_intro(pid, seconds=3.0, ep=""):
    """
    片头卡：把一张场景图压暗，叠上片名与集名，带淡入淡出。

    * 文字一律走 `textfile=`，**不写进 filter 字符串** —— 中文字面量 + 冒号 + 反斜杠
      在 filtergraph 里要三层转义，是稳定的事故源；写进 UTF-8 文件只受一处影响。
    * 音轨用 anullsrc **且必须是 32000 Hz 立体声**：合成用的是 concat 解复用器，
      各段流参数必须一致，H3 产物就是 32 kHz，混进 48 kHz 会拼坏。
    """
    meta, params = params_of(pid)
    title = str(meta.get("title") or "").strip()
    ep_id = str(ep or "").strip()
    ep_label = str(meta.get("episode") or "").strip()
    # 分集片头：project.json 的 episodes 映射给每一集自己的集名
    eps = meta.get("episodes") or {}
    if ep_id and isinstance(eps, dict) and eps.get(ep_id):
        ep_label = str(eps[ep_id])
    ep = ep_label
    if not title:
        return None
    font = pick_font()
    if not font:
        print("⚠ 找不到可用中文字体，跳过片头卡")
        return None
    w = int(params.get("width") or 1344)
    h = int(params.get("height") or 768)
    fps = int(params.get("fps") or 24)

    bg = None
    assets = read_json(project_path(pid, "assets.json"), {})
    for a in (assets.get("scenes") or []):
        p = project_path(pid, str(a.get("image") or "").replace("/", os.sep))
        if os.path.isfile(p):
            bg = p
            break
    if not bg:
        first = [c["name"] for c in clips_of(pid) if not c["final"] and not c["take"]]
        if first:
            r = run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i",
                     project_path(pid, first[0]), "-frames:v", "1",
                     project_path(pid, "_intro_bg.png")], timeout=120)
            if r[0] == 0:
                bg = project_path(pid, "_intro_bg.png")
    if not bg:
        print("⚠ 没有可用的片头底图，跳过片头卡")
        return None

    tf_title = project_path(pid, "_intro_title.txt")
    tf_sub = project_path(pid, "_intro_sub.txt")
    with open(tf_title, "w", encoding="utf-8") as fh:
        fh.write(title)
    with open(tf_sub, "w", encoding="utf-8") as fh:
        fh.write(ep)

    # 字体路径里的冒号要**两层转义**（写成 `\\:`）：
    # filtergraph 解析器会先吃掉一层反斜杠，只写 `\:` 的话冒号会被当成选项分隔符，
    # ffmpeg 报 "No option name near '/Windows/Fonts/...'"（实测踩过）。
    font_arg = "fontfile=" + font.replace("\\", "/").replace(":", "\\\\:")
    # textfile 一律用**相对文件名**（ffmpeg 以项目根为 cwd 运行）：
    # filtergraph 里反斜杠是转义符，绝对路径 D:\Ai\漫剧\... 会被啃成 D:Ai漫剧...，
    # 结果就是"找不到文本文件"，而报错只显示 Invalid argument（实测踩过）。
    size_t = max(48, int(h * 0.115))
    size_s = max(20, int(h * 0.048))
    fade_out = max(0.1, seconds - 0.6)
    # 标题轻微上浮：y 从 +18px 落到最终位（0.9s），比纯淡入有呼吸感
    chain = (
        "scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d," % (w, h, w, h)
        + "eq=brightness=-0.16:saturation=0.86,"
        + "drawtext=%s:textfile=%s:fontcolor=0xF3E6C8:fontsize=%d:borderw=3:bordercolor=0x1A0F06@0.85:"
          "x=(w-text_w)/2:y='%d+18*(1-min(t/0.9,1))':alpha='min(t/0.8,1)',"
          % (font_arg, os.path.basename(tf_title), size_t, int(h * 0.33))
        + "drawtext=%s:textfile=%s:fontcolor=0xD9E4F2:fontsize=%d:borderw=2:bordercolor=0x101820@0.8:"
          "x=(w-text_w)/2:y='%d+14*(1-min(max(t-0.7,0)/0.9,1))':alpha='min(max(t-0.7,0)/0.9,1)',"
          % (font_arg, os.path.basename(tf_sub), size_s, int(h * 0.50))
        + "fade=t=in:st=0:d=0.5,fade=t=out:st=%.2f:d=0.6,format=yuv420p[v]" % fade_out
    )
    out = project_path(pid, ("_intro-%s.mp4" % ep_id) if ep_id else "_intro.mp4")
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
           "-loop", "1", "-framerate", str(fps), "-i", bg,
           "-f", "lavfi", "-i", "anullsrc=r=32000:cl=stereo",
           "-t", "%.2f" % seconds,
           "-filter_complex", chain, "-map", "[v]", "-map", "1:a",
           "-c:v", "libx264", "-preset", "medium", "-crf", "18",
           "-c:a", "aac", "-b:a", "192k", "-ar", "32000", "-ac", "2",
           "-shortest", out]
    code, _o, err = run(cmd, cwd=project_path(pid), timeout=600)
    if code != 0:
        print("⚠ 片头卡生成失败（跳过）：" + (err or "")[-300:])
        return None
    info = ffprobe_one(out)
    print("片头卡 %s（%s / %s）%.2fs" % (os.path.basename(out), title, ep or "-",
                                        (info or {}).get("duration") or 0))
    # **返回真正写出来的那个文件名**。原来硬编码 return "_intro.mp4"，
    # 分集之后就变成"两集都去用同一个老文件"——ep02 的成片里嵌的是 ep01 那张卡（实测踩到）。
    return os.path.basename(out)


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


def build_ass(shots, starts, width, height, size_pct=5.0, tail_trim=0.0, fade_ms=140):
    """生成 ASS 字幕。

    `tail_trim` 是"每镜尾部被下一镜吃掉的秒数"：
      * 硬切 = 0；
      * 叠化 = 转场时长 F（默认 0.5）。
    **不扣掉它就会出事故**：字幕窗口原本铺满整镜时长，而叠化时下一镜提前 F 秒开始，
    于是每处转场都有 F 秒两条字幕同时压在屏幕上（实测 15 镜 = 14 处重叠、每处 0.44s）。
    观感就是"字和画都在重影"，直接被读成"镜头前后不连贯"。
    """
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
    total = len(shots)
    for i, s in enumerate(shots):
        dlg = s.get("dialogue") or []
        if not dlg:
            continue
        start = starts[i] if i < len(starts) else 0
        dur = s.get("_dur") or 0
        # 本镜真正独占画面的时长：最后一镜不用扣，中间各镜要扣掉被下一镜吃掉的那段
        avail = dur - (tail_trim if i < total - 1 else 0.0)
        if avail <= 0.05:
            continue
        each = avail / len(dlg)
        for k, d in enumerate(dlg):
            txt = str((d or {}).get("text") or "").strip()
            if not txt:
                continue
            name = str((d or {}).get("speaker") or "").strip()
            is_narr = bool(re.search(r"旁白|narrator|voiceover", name, re.I))
            # **角色台词带说话人**：观众要能知道是谁在说。
            # 旁白不加前缀（它本来就没有"人"）。前缀并入折行计算，免得顶出画面。
            label = "" if (is_narr or not name) else (name + "：")
            t0 = start + each * k
            t1 = start + each * (k + 1) - 0.06
            if t1 - t0 < 0.2:
                continue
            lines.append("Dialogue: 0,%s,%s,%s,%s,0,0,0,,%s%s" % (
                ass_time(t0), ass_time(t1), "旁白" if is_narr else "对白",
                name,
                ("{\\fad(%d,%d)}" % (int(fade_ms), int(fade_ms))) if fade_ms else "",
                wrap_ass_text(label + txt, max_units)))
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
    # ── 分集合成 ──
    # 按该集的渲染清单选片并**按清单顺序**排列（不靠文件名字典序猜），
    # 产物写 成片-<ep>.mp4 —— 都以「成片」开头，工作台的 clipsOf 会把它当 final 排除掉。
    ep = str(getattr(args, "episode", "") or "").strip()
    out_name = "成片.mp4"
    ass_rel = "output/final.ass"
    if ep:
        rdoc = read_json(render_doc_path(pid, ep), None)
        if not rdoc or not rdoc.get("shots"):
            raise SystemExit("缺少 _render-%s.json —— 先 sync --episode %s" % (ep, ep))
        want = [str(s.get("id")) for s in rdoc["shots"]]
        order = {sid: i for i, sid in enumerate(want)}
        clips = [c for c in clips if c["shot"] in order]
        clips.sort(key=lambda c: order.get(c["shot"], 10 ** 6))
        miss = [sid for sid in want if not any(c["shot"] == sid for c in clips)]
        if miss:
            raise SystemExit("这一集还有 %d 镜没渲染：%s" % (len(miss), "、".join(miss[:8])))
        out_name = "成片-%s.mp4" % ep
        ass_rel = "output/final-%s.ass" % ep
    names = [c["name"] for c in clips]
    if not names:
        raise SystemExit("没有可合成的镜头")
    if args.range:
        lo, hi = args.range

        # 先削掉扩展名再取数字：直接对 "s01.mp4" 抽 \d+ 会把 mp4 里的 4 也捞进来，
        # 得到 "014" = 14，于是 --range 1 1 一个镜头都筛不出来（实测踩过）。
        def shot_num(name):
            m = re.search(r"(\d+)", os.path.splitext(name)[0])
            return int(m.group(1)) if m else 0

        names = [n for n in names if lo <= shot_num(n) <= hi]

    # 片头卡：作为第 1 段参与时长/起点累加，字幕时间轴会自动整体后移 ——
    # 它不在 plan 里，没有台词，所以不产生任何字幕。
    if args.intro:
        card = make_intro(pid, args.intro_seconds, ep)
        if card:
            names = [card] + names

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

    # **注意别写 `args.no_subtitles is False or True`** —— 那个表达式恒为 True，
    # --no-subtitles 就成了死参数：用户以为出的是无字幕母版，实际拿到烧死字幕的版本（审计发现）。
    want_subs = not args.no_subtitles
    # 叠化时每镜尾部有 F 秒被下一镜吃掉，字幕窗口必须扣掉它，否则两条字幕会同时在屏
    tail_trim = F if (transition == "fade" and len(names) > 1) else 0.0
    built = build_ass(board, starts, canvas_w, canvas_h, size_pct, tail_trim)
    sub_filter = ""
    if built[1] > 0:
        os.makedirs(project_path(pid, "output"), exist_ok=True)
        with open(project_path(pid, ass_rel.replace("/", os.sep)), "w", encoding="utf-8") as fh:
            fh.write(built[0])
        # libass 不认带引号的 Windows 盘符绝对路径 → 用相对路径 + cwd=项目根
        sub_filter = "subtitles=filename=" + ass_rel

    af = "loudnorm=I=%s:TP=-1.5:LRA=11" % loud
    venc = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]
    aenc = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    target = os.path.join(d, out_name)
    # **先编码到临时文件，成功后再原子替换**。
    # 原实现是"先 os.remove(target) 再编码"：这一次 ffmpeg 一旦失败（镜头缺失/滤镜报错/磁盘满），
    # 旧成片已经被删、新成片又没生成 —— 交付物直接消失（审计发现）。
    tmp_target = target + ".tmp.mp4"
    if os.path.isfile(tmp_target):
        try:
            os.remove(tmp_target)
        except OSError:
            pass

    if transition == "cut" or len(names) == 1:
        lst = os.path.join(d, "_concat.txt")
        with open(lst, "w", encoding="utf-8") as fh:
            for nm in names:
                fh.write("file '" + os.path.join(d, nm).replace("\\", "/") + "'\n")
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-f", "concat", "-safe", "0", "-i", lst]
        if sub_filter:
            cmd += ["-vf", sub_filter]
        cmd += venc + ["-af", af] + aenc + ["-movflags", "+faststart", tmp_target]
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
        # 响度归一必须**并进滤镜图**：叠化路径的音轨已经过 filter_complex，
        # 再用 `-af loudnorm` 会撞 "Simple and complex filtering cannot be used
        # together for the same stream" 直接失败（工作台的 fade 分支就有这个隐患，
        # 只是它默认走 cut 才没暴露）。
        parts.append("[%s]%s[aout]" % (alab, af))
        alab = "aout"
        cmd += ["-filter_complex", ";".join(parts), "-map", "[%s]" % vlab, "-map", "[%s]" % alab] \
            + venc + aenc + ["-movflags", "+faststart", tmp_target]

    print("合成 %d 镜 · 转场 %s · 字幕 %d 条（字号 %dpx / 每行最多 %d 全角字）"
          % (len(names), transition, built[1], built[2], built[3]), flush=True)
    code, out, err = run(cmd, cwd=d, timeout=1800)
    if code != 0:
        print((err or out)[-2000:])
        # 失败时**保留**上一版成片（原来会先删掉它，交付物就没了）
        raise SystemExit("ffmpeg 合成失败（退出码 %s）；已保留原有 %s" % (code, out_name if os.path.isfile(target) else "（无）"))
    # 成功才原子替换：os.replace 在同盘上是原子操作，中途断电也不会留下半个成片
    os.replace(tmp_target, target)
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


def cmd_cover(args):
    pid = args.project
    need_project(pid)
    if cover_rel(pid) and not args.force:
        print("封面已有：" + cover_rel(pid) + "（--force 重做）")
        return 0
    if not comfy_alive():
        raise SystemExit("ComfyUI 不可达 —— 先 manju-headless.py comfy start")
    return gen_cover(pid, force=True)


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


class _Tee(object):
    """把 stdout 同时写到终端和日志文件。"""

    def __init__(self, stream, fh):
        self.stream = stream
        self.fh = fh

    def write(self, s):
        try:
            self.stream.write(s)
        except Exception:
            pass
        try:
            self.fh.write(s)
            # **每写完一行就刷盘**：工作台的全局作业监视器是 tail 这个文件来显示实时日志的，
            # 缓冲住的话界面要等到命令结束才有输出（等于没有"实时"）。
            if s and ("\n" in s):
                self.fh.flush()
        except Exception:
            pass
        return len(s) if s else 0

    def flush(self):
        for t in (self.stream, self.fh):
            try:
                t.flush()
            except Exception:
                pass


ACTIVE_PATH = os.path.join(ROOT, "_active.json")
# 进程内的活动记录（写入 _active.json 用；模块级以免 main 里到处传）
ACTIVE = {}


def write_active(payload):
    """
    全局活动记录：让工作台**不依赖项目选择**就知道"现在有没有管线在跑、跑到哪了"。

    为什么需要：以前工作台的日志窗口只读"当前项目的历史日志文件"，
    于是我从命令行起的渲染它一无所知（用户原话：只要管线渲染就要显示实时日志，他不针对单项目）。
    写法是"临时文件 + rename"，避免界面读到写了一半的 JSON。
    """
    try:
        tmp = ACTIVE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, ACTIVE_PATH)
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser(prog="manju-headless", description="漫剧工作台无头驱动器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="plan.meta.json + prompts/*.txt → plan.json")
    b.add_argument("--project", required=True)
    b.set_defaults(func=cmd_build)

    a = sub.add_parser("assets", help="Krea-2 生成缺失的定妆照/场景图（顺带补独立封面）")
    a.add_argument("--project", required=True)
    a.add_argument("--only", nargs="*", help="只生成这些 id")
    a.add_argument("--force", action="store_true")
    a.add_argument("--seed", type=int, default=0)
    a.add_argument("--no-cover", dest="no_cover", action="store_true", help="跳过封面")
    a.add_argument("--force-cover", dest="force_cover", action="store_true", help="重做已有封面")
    a.set_defaults(func=cmd_assets)

    cv = sub.add_parser("cover", help="只生成/重做项目封面（独立封面，非人物定妆照）")
    cv.add_argument("--project", required=True)
    cv.add_argument("--force", action="store_true")
    cv.set_defaults(func=cmd_cover)

    # ── 子命令注册 ──
    ab = sub.add_parser("absorb", help="把一个独立项目吸收成本项目的某一集")
    ab.add_argument("--project", required=True, help="目标（主）项目")
    ab.add_argument("--source", required=True, help="要被吸收的项目")
    ab.add_argument("--episode", required=True, help="集号，如 ep02")
    ab.set_defaults(func=cmd_absorb)

    ep = sub.add_parser("episodes", help="列出本项目的分集概况")
    ep.add_argument("--project", required=True)
    ep.set_defaults(func=cmd_episodes)

    vo = sub.add_parser("voice", help="语音验收：转写成片音轨并与剧本台词逐条比对")
    vo.add_argument("--project", required=True)
    vo.add_argument("--episode", default="")
    vo.add_argument("--model", default="medium", help="whisper 模型，默认 medium")
    vo.add_argument("--min-sim", dest="min_sim", type=float, default=0.6, help="判定阈值，默认 0.6")
    vo.set_defaults(func=cmd_voice)

    s = sub.add_parser("sync", help="解析参考图 → _render.json")
    s.add_argument("--project", required=True)
    s.add_argument("--episode", default="", help="只同步这一集（shots.json 仍写全本）")
    s.set_defaults(func=cmd_sync)

    r = sub.add_parser("render", help="调 manju.py 渲染")
    r.add_argument("--project", required=True)
    r.add_argument("--force", action="store_true")
    r.add_argument("--only", nargs="*", help="只重渲这些镜头 id（单镜返修，隐含 --force）")
    r.add_argument("--out", default=None, help="产物目录（默认项目目录；A/B 对比时指向别处）")
    r.add_argument("--no-free", dest="no_free", action="store_true", help="渲染后不归还 ComfyUI 显存")
    r.add_argument("--dry-run", dest="dry_run", action="store_true",
                   help="只构图检查（不提交渲染）：0 秒内暴露参数/接线错误")
    r.add_argument("--episode", default="", help="只渲染这一集")
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
    c.add_argument("--intro", action="store_true", help="加片头卡（片名 + 集名，取自 project.json）")
    c.add_argument("--intro-seconds", dest="intro_seconds", type=float, default=3.0)
    c.add_argument("--no-subtitles", dest="no_subtitles", action="store_true")
    c.add_argument("--episode", default="", help="只合成这一集 → 成片-<集>.mp4")
    c.set_defaults(func=cmd_compose)

    st = sub.add_parser("status", help="项目状态")
    st.add_argument("--project", required=True)
    st.set_defaults(func=cmd_status)

    cf = sub.add_parser("comfy", help="ComfyUI 资源治理（status/free/stop/start）")
    cf.add_argument("action", choices=["status", "free", "stop", "start"])
    cf.add_argument("--project", default="")
    cf.set_defaults(func=cmd_comfy)

    lg = sub.add_parser("logs", help="列出/查看已落盘的任务日志")
    lg.add_argument("--project", required=True)
    lg.add_argument("--name", default="", help="指定日志文件名（缺省看最新一份）")
    lg.add_argument("--tail", type=int, default=60)
    lg.set_defaults(func=cmd_logs)

    args = ap.parse_args()
    # 每个子命令的输出都落一份到 <项目>/output/logs/：
    # 渲染为什么慢、质检报了哪一条，都是事后才要查的东西，
    # 只留在终端里等于没有。logs 命令自己不再落盘（否则看日志会生成日志）。
    raw_out = sys.stdout
    raw_err = sys.stderr
    logf = None
    jp = getattr(args, "project", "") or ""
    if args.cmd != "logs" and jp and os.path.isdir(project_path(jp)):
        try:
            logdir = project_path(jp, "output", "logs")
            os.makedirs(logdir, exist_ok=True)
            stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
            logpath = os.path.join(logdir, "%s-%s.log" % (args.cmd, stamp))
            logf = open(logpath, "w", encoding="utf-8")
            sys.stdout = _Tee(raw_out, logf)
            sys.stderr = _Tee(raw_err, logf)
            # 登记全局活动：工作台据此显示实时日志（含命令行发起的渲染）
            ACTIVE.update({
                "project": jp, "cmd": args.cmd, "startedAt": time.time(),
                "iso": time.strftime("%Y-%m-%d %H:%M:%S"),
                "rel": "%s/output/logs/%s" % (jp, os.path.basename(logpath)),
                "argv": " ".join(sys.argv[1:]),
            })
            write_active(ACTIVE)
        except Exception:
            logf = None
    code = 0
    try:
        code = args.func(args) or 0
    finally:
        if logf:
            try:
                sys.stdout.flush()
                logf.close()
            except Exception:
                pass
            sys.stdout = raw_out
            sys.stderr = raw_err
            # 收尾：把结束时间与退出码写回活动记录（界面据此判断"跑完了/失败了"）
            ACTIVE.update({"endedAt": time.time(), "code": code})
            write_active(ACTIVE)
            raw_out.write("[log] 已落盘：" + logpath + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
