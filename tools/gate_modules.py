#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gate_modules.py —— 模块卫生检查（模块化/解耦的自动化那部分）

规矩写在 docs/CONVENTIONS.md，这里只做**机器能判**的三件事：

1. **单文件体量**：一个 .py 超过 800 行就报警（不算失败，但每次跑检查都会出现）。
   单文件过大的代价是"改一处要通读全局、模块边界只能靠人记" —— 让它在每次检查里可见，
   而不是等攒到 2000 行才发现。要豁免就把它拆掉，而不是调阈值。
2. **循环依赖**：同仓库内 Python 模块互相 import 成环 → **失败**。
   出现环说明职责切错了（不是"加个 lazy import"能了事的）。
3. **包结构**：`tools/<pkg>/` 下有 .py 却没有 `__init__.py` → 失败（它就不是包，import 会漂）。

退出码：0 干净，1 有必须修的问题。
"""
import ast
import os
import sys

BIG_LINES = 800
SKIP_DIRS = {".git", "node_modules", "__pycache__", "venv", "models", "assets", "output"}


def py_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn.endswith(".py"):
                yield os.path.join(dirpath, fn)


def imports_of(path):
    """只看本仓库内的相对/包内 import（第三方不算依赖图）。"""
    try:
        tree = ast.parse(open(path, encoding="utf-8").read())
    except Exception:
        return set()
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                out.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.module:          # from .x import y
                out.add(node.module.split(".")[0])
            elif node.module:
                out.add(node.module.split(".")[0])
    return out


def main():
    roots = sys.argv[1:] or ["."]
    fails = 0
    warns = []

    for root in roots:
        if not os.path.isdir(root):
            continue
        files = list(py_files(root))
        local_mods = {os.path.splitext(os.path.basename(p))[0]: p for p in files}

        # 1. 单文件体量
        for p in files:
            try:
                n = sum(1 for _ in open(p, encoding="utf-8", errors="replace"))
            except Exception:
                continue
            if n > BIG_LINES:
                warns.append("%s 有 %d 行（> %d）—— 按 docs/CONVENTIONS.md 拆分，别调阈值"
                             % (os.path.relpath(p, root), n, BIG_LINES))

        # 2. 循环依赖
        graph = {}
        for name, p in local_mods.items():
            graph[name] = set(x for x in imports_of(p) if x in local_mods and x != name)
        seen, stack = set(), []

        def walk(n):
            if n in stack:
                cyc = " → ".join(stack[stack.index(n):] + [n])
                print("  CYCLE %s" % cyc)
                return True
            if n in seen:
                return False
            seen.add(n)
            stack.append(n)
            bad = False
            for m in sorted(graph.get(n, ())):
                if walk(m):
                    bad = True
            stack.pop()
            return bad

        for n in sorted(graph):
            if walk(n):
                fails += 1

        # 3. 包结构：有 .py 的目录必须有 __init__.py（顶层 tools/ 本身不算包）
        dirs = {}
        for p in files:
            d = os.path.dirname(p)
            if os.path.basename(d) == "tools" or d == root:
                continue
            dirs.setdefault(d, []).append(p)
        for d, ps in dirs.items():
            # 只有一个 .py 的目录是**脚本目录**（如 D:\Ai\Tools\ASR 直接跑 transcribe.py），
            # 不要求它是包；两个以上才说明这里是个多模块包，必须有 __init__.py。
            if len(ps) >= 2 and not os.path.isfile(os.path.join(d, "__init__.py")):
                print("  PKG %s 有 %d 个 .py 却没有 __init__.py（不是包，import 会漂）"
                      % (os.path.relpath(d, root), len(ps)))
                fails += 1

    for w in warns:
        print("  DEBT %s" % w)
    if fails:
        print("  → %d 处必须修（循环依赖 / 包结构）" % fails)
        return 1
    print("  OK 无循环依赖、包结构完整；%d 条体量债（见上）" % len(warns))
    return 0


if __name__ == "__main__":
    sys.exit(main())
