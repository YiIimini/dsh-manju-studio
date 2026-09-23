# -*- coding: utf-8 -*-
"""封面：独立封面提示词与生成（不拿主角定妆照当封面）。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import os
import shutil
import time

from .comfy import build_image_graph, comfy_alive, comfy_run_graph
from .jsonio import read_json, write_json
from .paths import COMFY_OUTPUT, need_project, params_of, project_path

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


def cmd_cover(args):
    pid = args.project
    need_project(pid)
    if cover_rel(pid) and not args.force:
        print("封面已有：" + cover_rel(pid) + "（--force 重做）")
        return 0
    if not comfy_alive():
        raise SystemExit("ComfyUI 不可达 —— 先 manju-headless.py comfy start")
    return gen_cover(pid, force=True)
