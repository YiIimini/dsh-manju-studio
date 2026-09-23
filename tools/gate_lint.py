#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gate_lint.py —— 抓"编辑吃掉了一行"这一类错误

事故原型（我连续犯过两次）：edit 时 old_string 只覆盖了某个块的一部分，
new_string 没把被覆盖的那一行原样带回 —— 于是 `def render_doc_path(...)` 那一行消失，
它的函数体被并进上一个函数，挂在 `return` 后面。**文件看起来完全正常**，
py_compile 也不报错（语法是合法的），只有真正调用时才 NameError。

能抓到的两类：
  1. 函数体里 `return` 之后还有语句（不可达代码）—— 上面那次就是这样暴露的；
  2. 模块级的裸字符串字面量（通常是没了 def 的孤立 docstring）。

退出码：0 干净，1 有问题（gate.cmd 会因此拦下）。
"""
import ast
import os
import sys


def check_file(path):
    problems = []
    try:
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
    except Exception as e:
        return [(path, 0, "读不了：%s" % e)]
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        return [(path, e.lineno or 0, "语法错误：%s" % e.msg)]

    # 1. return 之后的语句（同一层）
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not isinstance(body, list):
            continue
        for i, st in enumerate(body):
            if isinstance(st, ast.Return) and i < len(body) - 1:
                nxt = body[i + 1]
                problems.append((path, getattr(nxt, "lineno", 0),
                                 "return 之后还有不可达语句（第 %d 行起）—— 十有八九是编辑吃掉了 def 行"
                                 % getattr(nxt, "lineno", 0)))
                break

    # 2. 模块级裸字符串（孤立 docstring）——**但文件自己的头 docstring 是合法的**，
    #    只允许出现在第一条语句；其余位置的裸字符串一律可疑（第一版把这条判成误报）。
    for idx, st in enumerate(tree.body):
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Constant) and isinstance(st.value.value, str):
            if idx == 0:
                continue
            problems.append((path, st.lineno, "模块级裸字符串 —— 可能是丢了 def 的孤立 docstring"))
    return problems


def main():
    # 参数可以是文件，也可以是目录（目录会递归扫 .py）。
    # **没有参数时默认扫 tools/ 自己** —— 这一条是被"闸门空转"教会的：
    # gate.cmd 原来调用本脚本时一个路径都没传，于是循环体从不执行、永远打印 OK，
    # 这个检查步骤在闸门里空转了很久而没人发现。默认值让"空转"不可能再发生。
    args = sys.argv[1:] or [os.path.dirname(os.path.abspath(__file__))]
    paths = []
    for a in args:
        if os.path.isdir(a):
            for root, _dirs, names in os.walk(a):
                if os.sep + '__pycache__' in root:
                    continue
                for n in sorted(names):
                    if n.endswith(".py"):
                        paths.append(os.path.join(root, n))
        else:
            paths.append(a)
    bad = 0
    for path in paths:
        for p, line, why in check_file(path):
            bad += 1
            print("  LINT %s:%s %s" % (p, line, why))
    if bad:
        print("  → %d 处可疑，先修再往下跑" % bad)
        return 1
    print("  OK 扫了 %d 个 .py，没有不可达代码 / 孤立函数体" % len(paths))
    return 0


if __name__ == "__main__":
    sys.exit(main())
