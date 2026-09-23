#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gate_ascii.py —— 批处理文件不许有非 ASCII 字节

事故原型：`.cmd` 用 UTF-8 写中文注释，cmd.exe 按 OEM 代码页（本机 936）读，
中文字节被劈成乱命令 —— 实测报 `'mfyUI' is not recognized`、`'HF_ENDPOINT' is not recognized`，
整个脚本静默跑一半就废。同一个坑在 .ps1 上也踩过（PS 5.1 把无 BOM 的 UTF-8 当 ANSI 读）。

规则：
  * .cmd / .bat：**必须纯 ASCII**（中文说明写进同目录 README.md）
  * .ps1：**纯 ASCII，或带 UTF-8 BOM**（带 BOM 时 PS 5.1 能正确读中文）

退出码：0 干净，1 有问题。
"""
import os
import sys

TARGETS = (".cmd", ".bat", ".ps1")
BOM = b"\xef\xbb\xbf"


def scan(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    ext = os.path.splitext(path)[1].lower()
    has_bom = raw.startswith(BOM)
    body = raw[3:] if has_bom else raw
    if not any(b > 127 for b in body):
        return None
    if ext == ".ps1" and has_bom:
        return None                      # 带 BOM 的 ps1 允许中文
    bad_bytes = sum(1 for b in body if b > 127)
    return "%d 个非 ASCII 字节（%s）" % (
        bad_bytes,
        "cmd.exe 按 OEM 代码页读会劈断命令行，中文说明请写进 README"
        if ext != ".ps1" else "PS 5.1 会按 ANSI 读，加 UTF-8 BOM 或改用纯 ASCII",
    )


def main():
    roots = sys.argv[1:] or ["."]
    bad = 0
    seen = 0
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git", "venv", "models", "__pycache__")]
            for fn in filenames:
                if not fn.lower().endswith(TARGETS):
                    continue
                seen += 1
                p = os.path.join(dirpath, fn)
                why = scan(p)
                if why:
                    bad += 1
                    print("  ASCII %s: %s" % (p, why))
    if bad:
        print("  → %d 个批处理/脚本文件有非 ASCII 字节" % bad)
        return 1
    print("  OK 扫了 %d 个 .cmd/.bat/.ps1，全部合规" % seen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
