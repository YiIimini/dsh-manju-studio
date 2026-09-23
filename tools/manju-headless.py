#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 注意：下面这段说明是 **raw 字符串**（r"""）。里面写着 Windows 路径 `D:\Ai\漫剧\<id>\`，
# 普通字符串会把 `\A` 当成非法转义 —— 于是每次运行都打一条 SyntaxWarning。
# "习惯性警告"正是让人错过真问题的那种噪音，所以在源头掐掉。
r"""
manju-headless.py —— 漫剧工作台「无头驱动器」

## 为什么存在

工作台的命令接口 `POST /api/manju-studio` 只在 DSH Desktop 的 Electron 渲染器内可用：
`lib/webserver.js` → `decideDesktopBrowserAccess()` 会校验 `x-dsh-desktop-renderer` 能力令牌，
外部进程（curl / Agent / CI）拿到的永远是 `403 forbidden`。于是 Agent 无法驱动工作台。

本脚本按**工作台自己的项目契约与配方**补齐这条无头通路：同一套目录布局、同一套
Krea-2 定妆配方、同一个渲染器（manju.py）、同一套合成规则（ASS 字幕 + loudnorm +
faststart）。产物落进同一个项目目录，因此工作台界面照样能列出、预览、播放。

## 项目目录 D:\Ai\漫剧\<id>\

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

import os
import sys

# 让"直接 python tools/manju-headless.py"也能 import 到本包（脚本目录自动进 sys.path，
# 但被别处 import 时不会 —— 显式加一道，省得报 ModuleNotFoundError）。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from manju_headless import *  # noqa: F401,F403
from manju_headless.asr import _asr_segments, _best_sim, _norm_text  # noqa: F401
from manju_headless.cli import main  # noqa: F401
from manju_headless.procs import _Tee  # noqa: F401

if __name__ == "__main__":
    sys.exit(main())
