# -*- coding: utf-8 -*-
"""子进程执行与"全局活动记录"（工作台的实时日志靠它）。

本文件由 manju-headless.py 按能力拆分而来（机械搬运，行为未改）；
行为由 tools/driver_probe.py 的断言锁住。
"""
from __future__ import annotations

import json
import os
import subprocess

from .paths import ROOT

def run(cmd, cwd=None, timeout=None, env=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout, env=env)
    return r.returncode, (r.stdout or ""), (r.stderr or "")


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
