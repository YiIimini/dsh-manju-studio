# -*- coding: utf-8 -*-
"""manju_headless —— 漫剧工作台无头驱动器的模块化实现。

模块职责：
    paths      路径与项目定位（常量与纯路径函数）
    jsonio     JSON 读写
    procs      子进程执行 + 全局活动记录（工作台实时日志靠它）
    comfy      ComfyUI 客户端与引擎治理（含 cmd_comfy）
    prompts    提示词片段（身份保真 / 构图框定 / 普通话锁 / 空间锚点）
    series     系列资产池（跨集同一张脸）
    shots      镜头与分集的纯逻辑（集号 / 连续段 / 段内自动接镜）
    sync       解析参考图 → _render-<集>.json
    media      媒体工具（探测 / 切片清单 / 末帧 / 片头卡）
    subtitles  字幕（宽度 / 折行 / 时间码 / ASS，含字幕卡三类）
    render     构图检查与调用渲染器
    compose    字幕 + 响度归一 + faststart 合成成片
    qc         机械质检
    asr        语音转写的文本比对
    voice      语音验收
    assets     资产定妆（Krea-2 生成定妆照与场景图）
    cover      独立封面
    project    项目级操作（状态 / plan.json / 分集 / 吸收 / 日志）
    cli        命令行入口（薄）

**入口仍然是 tools/manju-headless.py**（薄壳），公开名通过本包再导出，
老的脚本、文档、肌肉记忆照旧可用；行为由 tools/driver_probe.py 的断言锁住。

注意：`from .x import *` **不会**带下划线开头的名字，所以那几个
（_Tee / _post / _get / _asr_segments / _best_sim / _norm_text）在下面逐条显式导入 ——
`__all__` 里列了却没真正导入，会在 `from manju_headless import *` 时直接抛 AttributeError。
"""

from .asr import *  # noqa: F401,F403
from .asr import _asr_segments, _best_sim, _norm_text  # noqa: F401
from .assets import *  # noqa: F401,F403
from .cli import *  # noqa: F401,F403
from .comfy import *  # noqa: F401,F403
from .comfy import _get, _post  # noqa: F401
from .compose import *  # noqa: F401,F403
from .cover import *  # noqa: F401,F403
from .jsonio import *  # noqa: F401,F403
from .media import *  # noqa: F401,F403
from .paths import *  # noqa: F401,F403
from .procs import *  # noqa: F401,F403
from .procs import _Tee  # noqa: F401
from .project import *  # noqa: F401,F403
from .prompts import *  # noqa: F401,F403
from .qc import *  # noqa: F401,F403
from .render import *  # noqa: F401,F403
from .series import *  # noqa: F401,F403
from .shots import *  # noqa: F401,F403
from .subtitles import *  # noqa: F401,F403
from .sync import *  # noqa: F401,F403
from .voice import *  # noqa: F401,F403

__all__ = [
    'ACTIVE',
    'ACTIVE_PATH',
    'CHAR_H',
    'CHAR_W',
    'COMFY',
    'COMFY_DIR',
    'COMFY_GOVERNANCE_FLAGS',
    'COMFY_LOGDIR',
    'COMFY_OUTPUT',
    'COVER_H',
    'COVER_W',
    'FFMPEG',
    'FFPROBE',
    'FONT_CANDIDATES',
    'FRAMING_CHAR',
    'FRAMING_SCENE',
    'IDENTITY_FIDELITY',
    'IMG_CFG',
    'IMG_CLIP',
    'IMG_CLIP_TYPE',
    'IMG_STEPS',
    'IMG_UNET',
    'IMG_VAE',
    'MANJU_PY',
    'PY_EXE',
    'ROOT',
    'SCENE_H',
    'SCENE_W',
    'SERIES_DIRNAME',
    'SERIES_KINDS',
    'TIMEOUT_GEN',
    '_Tee',
    '_asr_segments',
    '_best_sim',
    '_get',
    '_norm_text',
    '_post',
    'anchor_block',
    'ass_time',
    'auto_chain_in_runs',
    'build_ass',
    'build_image_graph',
    'clips_of',
    'cmd_absorb',
    'cmd_assets',
    'cmd_build',
    'cmd_comfy',
    'cmd_compose',
    'cmd_cover',
    'cmd_episodes',
    'cmd_logs',
    'cmd_qc',
    'cmd_render',
    'cmd_status',
    'cmd_sync',
    'cmd_voice',
    'comfy_alive',
    'comfy_free',
    'comfy_pids',
    'comfy_rss_gb',
    'comfy_run_graph',
    'comfy_url_of',
    'comfy_vram',
    'cover_brief',
    'cover_rel',
    'dry_run_graphs',
    'ensure_mandarin',
    'episodes_in',
    'extract_last_frame',
    'ffprobe_one',
    'gen_cover',
    'main',
    'make_intro',
    'need_project',
    'params_of',
    'pick_font',
    'project_path',
    'qc_one',
    'read_json',
    'render_doc_path',
    'resolve_refs',
    'run',
    'scene_anchors',
    'series_assets',
    'series_dir',
    'series_find',
    'series_id',
    'series_pull',
    'series_register',
    'shot_episode',
    'shot_run',
    'visual_width',
    'write_active',
    'write_json',
    'wrap_ass_text',
]
