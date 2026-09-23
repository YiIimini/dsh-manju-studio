"""
驱动器行为锁（characterization test）—— 拆分 manju-headless.py 之前必须先有的安全网。

为什么要有它：驱动器是 2000+ 行的历史累积文件，里面每一条行为都是踩出来的
（接镜只在段内开、字幕尾部要扣掉叠化时长、普通话锁、封面不许拼贴…）。
把代码搬进模块时，**行为不能变**；而"没变"只能靠断言证明，不能靠"我看着搬对了"。

两条锁定口径：
  1. **公开面**：入口模块（tools/manju-headless.py）必须继续暴露这些函数与常量 ——
     拆分成包之后它们仍然要能从入口拿到（老脚本、老文档、我自己的肌肉记忆都依赖它）。
  2. **行为**：纯函数与四条子命令的实际输出。

用法：python -X utf8 tools/driver_probe.py
输出：每行 `  PASS …` / `  FAIL …`；退出码 0 = 全过。
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time

TOOLS = os.path.dirname(os.path.abspath(__file__))
ENTRY = os.path.join(TOOLS, "manju-headless.py")
PY = sys.executable

_pass = 0
_fail = 0


def ok(cond, msg, extra=""):
    global _pass, _fail
    if cond:
        _pass += 1
        print("  PASS " + msg)
    else:
        _fail += 1
        print("  FAIL " + msg + (("  <- " + str(extra)) if extra else ""))


def load_entry():
    spec = importlib.util.spec_from_file_location("mh_entry", ENTRY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_cli(*args, **kw):
    """跑一次命令行入口，回 (exitcode, 合并输出)。"""
    cmd = [PY, "-X", "utf8", ENTRY] + list(args)
    p = subprocess.run(cmd, cwd=kw.get("cwd") or TOOLS, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


mh = load_entry()
ROOT = mh.ROOT
PID = "_driver-test-" + time.strftime("%H%M%S")
PROJ = os.path.join(ROOT, PID)

# 夹具跑起来会写 <项目根>/_active.json（"全局活动记录"，界面据此显示"外部作业在跑"）。
# 跑完要还原成原来的样子 —— 否则用户会在工作台的运行条里看到一个莫名其妙的、
# 早已结束的"外部作业：render --project _driver-test-xxxx"。测试不该在用户界面上留痕。
ACTIVE_PATH = os.path.join(ROOT, "_active.json")
try:
    ACTIVE_BACKUP = open(ACTIVE_PATH, encoding="utf-8").read()
except Exception:
    ACTIVE_BACKUP = None

print("== 1. 入口公开面（拆分后仍须从这里拿得到）==")
PUBLIC = [
    # 路径与 IO
    "ROOT", "COMFY", "PY_EXE", "MANJU_PY", "FFMPEG", "FFPROBE", "project_path", "read_json",
    "write_json", "need_project", "params_of", "run", "render_doc_path", "write_active",
    # comfy 客户端
    "comfy_alive", "comfy_url_of", "comfy_free", "comfy_vram", "comfy_pids", "build_image_graph",
    "comfy_run_graph",
    # 提示词与场景锚点
    "IDENTITY_FIDELITY", "FRAMING_CHAR", "FRAMING_SCENE", "scene_anchors", "anchor_block",
    "ensure_mandarin",
    # 系列资产池
    "series_id", "series_dir", "series_find", "series_register", "series_pull", "resolve_refs",
    # 镜头与分集
    "shot_episode", "episodes_in", "shot_run", "auto_chain_in_runs",
    # 媒体 / 字幕
    "ffprobe_one", "clips_of", "extract_last_frame", "make_intro", "pick_font",
    "visual_width", "wrap_ass_text", "ass_time", "build_ass",
    # 质检 / 语音 / 封面
    "qc_one", "cover_brief", "cover_rel", "gen_cover", "dry_run_graphs",
    # 入口
    "main",
]
missing = [n for n in PUBLIC if not hasattr(mh, n)]
ok(not missing, "入口模块仍暴露 %d 个公开名字" % len(PUBLIC), "缺：" + "、".join(missing))

print("== 2. 纯函数行为 ==")
ok(mh.ass_time(0) == "0:00:00.00", "ass_time(0)", mh.ass_time(0))
ok(mh.ass_time(61.5) == "0:01:01.50", "ass_time(61.5)", mh.ass_time(61.5))
ok(mh.visual_width("汉字ab") == 3.0, "visual_width 中文=1 / 英文=0.5", mh.visual_width("汉字ab"))
wrapped = mh.wrap_ass_text("一二三四五六七八九十", 5)
ok("\\N" in wrapped and len(wrapped.split("\\N")) == 2, "wrap_ass_text 按全角单位折行", wrapped)

mand = mh.ensure_mandarin("台词：<d>[Chinese]别走。</d>")
ok("MANDARIN ONLY" in mand, "ensure_mandarin 给带 <d> 的提示词补普通话硬锁", mand[-60:])
ok(mh.ensure_mandarin("没有台词的纯景镜") == "没有台词的纯景镜", "没有 <d> 就不加锁（不给纯景镜塞无关约束）")
ok(mh.ensure_mandarin(mand).count("MANDARIN ONLY") == 1, "ensure_mandarin 幂等（重复调用不叠加）")

br = mh.cover_brief({"title": "测试", "genre": "玄幻"}, {"width": 1344, "height": 768})
ok("single continuous" in br, "封面提示词要求单张连续画面（防四宫格拼贴）")
ok("no panels" in br and "no multiple views" in br, "封面提示词明确禁止分格与多视角拼贴")
ok("测试" not in br, "封面提示词**不写片名**（写了模型会把字画到图上）")

anchors = mh.scene_anchors({"scenes": [{"id": "s1", "anchors": "牌坊在东侧"}]})
ok(anchors.get("s1") == "牌坊在东侧", "scene_anchors 取出空间锚点")
ok("SPATIAL CONTINUITY" in mh.anchor_block("正文", anchors.get("s1")), "anchor_block 追加空间连续块")
ok(mh.anchor_block("正文", "") == "正文", "没有锚点时不动正文")

shots_fixture = [
    {"id": "s01", "run": "A"},
    {"id": "s02", "run": "A"},
    {"id": "s03", "run": "B"},
    {"id": "s04", "run": "A"},
]
n = mh.auto_chain_in_runs(shots_fixture)
ok(n == 1 and shots_fixture[1].get("chain_from") == "s01",
   "接镜只在**同一 run 内**开（跨段是刻意硬切，接了更难看）", json.dumps(shots_fixture, ensure_ascii=False))
ok(not shots_fixture[2].get("chain_from_prev") and not shots_fixture[3].get("chain_from_prev"),
   "换段的第一镜不接镜")
ok(mh.episodes_in({"shots": [{"episode": "ep01"}, {"episode": "ep02"}, {"episode": "ep01"}]}) == ["ep01", "ep02"],
   "episodes_in 按出现顺序去重")
ok(mh.shot_episode({"episode": " ep01 "}) == "ep01", "shot_episode 去空白")

print("== 3. build_ass：字幕卡四类 + 淡入 + 说话人前缀 ==")
dlg = [
    {"speaker": "林小满", "text": "师兄，药好了。"},
    {"speaker": "", "text": "剩余时间 -3 天", "kind": "sys"},
    {"speaker": "", "text": "这药怕不是要凉", "kind": "danmaku"},
    {"speaker": "", "text": "轰", "kind": "sfx"},
]
ass_shots = [{"id": "s01", "dialogue": dlg, "_dur": 8.0}]
ass, cnt, size, max_units = mh.build_ass(ass_shots, [0.0], 1344, 768)
ok(cnt == 4, "四条台词各出一行字幕（实际 %d）" % cnt)
ok("[V4+ Styles]" in ass and "Style: 对白," in ass and "Style: 旁白," in ass, "样式表含对白/旁白")
ok("Style: 系统," in ass and "Style: 弹幕," in ass and "Style: 音效," in ass,
   "字幕卡三类的 Style **有定义**（引用未定义样式会让画面随播放器漂移）")
lines = [l for l in ass.split("\n") if l.startswith("Dialogue: ")]
ok(len(lines) == 4, "四条 Dialogue 行")
ok(",系统," in lines[1] and "\\an7\\pos(" in lines[1], "sys → 系统样式 + 左上定位", lines[1][:70])
ok(",弹幕," in lines[2] and "\\an8\\pos(" in lines[2], "danmaku → 弹幕样式 + 顶部定位")
ok(",音效," in lines[3] and "\\bord7" in lines[3], "sfx → 音效样式 + 粗描边")
ok(all("\\fad(" in l for l in lines), "每条字幕都有淡入（KB 漫剧字幕规则）")
ok("林小满：" in lines[0], "普通台词带说话人前缀")
ok("系统：" not in lines[1] and "林小满：" not in lines[1], "字幕卡不加说话人前缀")
ok(all("\\N" not in l for l in lines), "单行不折行（KB：同屏仅一行）")
ass2, cnt2, _, _ = mh.build_ass(ass_shots, [0.0], 1344, 768, tail_trim=0.5)
ok(cnt2 == 4, "叠化时尾部扣掉被下一镜吃掉的时长（tail_trim）仍能出满 4 行")

print("== 4. CLI 端到端（真项目夹具）==")
os.makedirs(os.path.join(PROJ, "prompts", "ep01"), exist_ok=True)
os.makedirs(os.path.join(PROJ, "output", "logs"), exist_ok=True)
with open(os.path.join(PROJ, "project.json"), "w", encoding="utf-8") as fh:
    json.dump({"title": "驱动器行为锁", "genre": "测试", "style": "TEST STYLE",
               "episodes": {"ep01": "第一集 · 夹具"}, "params": {"width": 1344, "height": 768}}, fh, ensure_ascii=False)
with open(os.path.join(PROJ, "prompts", "ep01", "s01.txt"), "w", encoding="utf-8") as fh:
    fh.write("subject_definitions:\n<Subject 1> is a test puppet.\n\ndetailed_description:\n"
             + "A clean shot of the puppet on a stage. " * 8)
with open(os.path.join(PROJ, "plan.meta.json"), "w", encoding="utf-8") as fh:
    json.dump({
        "style": "TEST STYLE",
        "characters": [{"id": "c1", "name": "木偶", "description": "机关木偶"}],
        "scenes": [{"id": "sc1", "name": "戏台", "description": "旧戏台"}],
        "shots": [{
            "id": "ep01-s01", "episode": "ep01", "run": "A", "prompt_file": "prompts/ep01/s01.txt",
            "length": 73, "width": 1344, "height": 768, "seed": 7, "mode": "t2v",
            "dialogue": dlg,
        }],
    }, fh, ensure_ascii=False)

code, out = run_cli("--help")
ok(code == 0 and "build" in out and "compose" in out and "episodes" in out and "voice" in out,
   "manju-headless.py --help 正常且列出子命令")
code, out = run_cli("status", "--project", PID)
ok(code == 0 and "驱动器行为锁" in out, "status 读得出项目", out.strip().split("\n")[0][:60])
code, out = run_cli("build", "--project", PID)
plan_path = os.path.join(PROJ, "plan.json")
ok(code == 0 and os.path.isfile(plan_path), "build 生成 plan.json", out.strip()[:70])
plan = json.load(open(plan_path, encoding="utf-8"))
one = (plan.get("shots") or [{}])[0]
ok(one.get("prompt") and one.get("h3_prompt"), "build 同时写 prompt 与 h3_prompt（渲染器只认 prompt）")
ok(len(one.get("dialogue") or []) == 4 and (one["dialogue"][1].get("kind") == "sys"),
   "build 原样保留 dialogue 与 kind（字幕卡的数据通路）")
code, out = run_cli("sync", "--project", PID, "--episode", "ep01")
rdoc = os.path.join(PROJ, "_render-ep01.json")
ok(code == 0 and os.path.isfile(rdoc), "sync 写出 _render-ep01.json", out.strip()[-90:])
doc = json.load(open(rdoc, encoding="utf-8"))
ok(len(doc.get("shots") or []) == 1 and doc["shots"][0].get("episode") == "ep01", "渲染清单只含本集镜头")
code, out = run_cli("episodes", "--project", PID)
ok(code == 0 and "ep01" in out, "episodes 列得出分集")
code, out = run_cli("logs", "--project", PID, "--tail", "5")
ok(code == 0, "logs 能读已落盘的日志")
code, out = run_cli("render", "--project", PID, "--episode", "ep01", "--dry-run")
ok(code == 0 and "构图检查" in out and "OK" in out, "render --dry-run 构图通过（渲染路径的行为锁）", out.strip()[:80])

shutil.rmtree(PROJ, ignore_errors=True)

# 还原全局活动记录（理由见文件头）：测试不该在用户界面上留痕
active_ok = True
try:
    if ACTIVE_BACKUP is None:
        if os.path.isfile(ACTIVE_PATH):
            os.remove(ACTIVE_PATH)
    else:
        with open(ACTIVE_PATH, "w", encoding="utf-8") as fh:
            fh.write(ACTIVE_BACKUP)
except Exception:
    active_ok = False
ok(active_ok, "跑完还原 <项目根>/_active.json（不在工作台的运行条上留下幽灵作业）")

print("\n结果：PASS=%d FAIL=%d" % (_pass, _fail))
sys.exit(1 if _fail else 0)
