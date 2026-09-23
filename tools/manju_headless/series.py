# -*- coding: utf-8 -*-
"""系列资产池：跨集复用同一张脸（先到先得，逐字节复制）。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import os
import shutil

from .jsonio import read_json, write_json
from .paths import ROOT, project_path

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
