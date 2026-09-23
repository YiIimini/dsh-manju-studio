/**
 * dsh-manju-studio —— 漫剧工作台 · 客户端半
 *
 * 界面结构对齐 NiliX（视频管理 / 小说管理 / ComfyUI 三视图）：
 *   顶栏导航 + 系统状态条
 *   视频管理 = 成品列表 | 项目(参数) + 渲染配置 | 内容来源 + 执行管线 | 运行状态，底部产物
 *
 * 注册两个槽位：
 *   sidebar.panellist  id=manju-studio  —— 侧栏入口（场记板图标）
 *   main               key=manju-studio —— 中央主面板
 *
 * 与 Host 的通信：POST /api/manju-studio {cmd,args}；媒体：GET /manju-file?p=&r=
 */
window.__ModuleLoader__.load({
	id: "dsh-manju-studio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const API = "/api/manju-studio";
		const FILE = "/manju-file";
		const NL = String.fromCharCode(10);

		/** 七阶段固定顺序与中文名 —— 与宿主 STAGES 必须一致。 */
		const STAGE_DEF = [
			["env", "环境"], ["plan", "方案"], ["asset", "资产"], ["encode", "编码"],
			["render", "渲染"], ["judge", "质检"], ["merge", "合成"],
		];
		const STAGE_ORDER = ["plan", "asset", "encode", "render", "judge", "merge"];

		const CSS = `.mj-root{--mj-r:var(--mj-r-lg);--mj-rs:var(--mj-r-md);--mj-r-lg:14px;--mj-r-md:9px;--mj-r-sm:6px;--mj-r-xs:4px;--mj-r-cap:999px;--mj-s1:4px;--mj-s2:8px;--mj-s3:12px;--mj-s4:16px;--mj-s5:24px;--mj-fs-micro:12px;--mj-fs-body:13px;--mj-fs-title:15px;--mj-fs-head:18px;--mj-fs-display:22px;--mj-lh-tight:1.25;--mj-lh-body:1.55;--mj-e1:0 2px 6px rgba(0,0,0,.20),0 12px 32px rgba(0,0,0,.28);--mj-t:150ms cubic-bezier(.4,0,.2,1);--mj-surface:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));--mj-surface2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));--mj-overlay:var(--dsw-alias-bg-overlay,#1e1e22);--mj-line:var(--dsw-alias-border-l1,rgba(128,128,128,.22));--mj-line2:var(--dsw-alias-border-l2,rgba(128,128,128,.36));--mj-text:var(--dsw-alias-label-primary,inherit);--mj-dim:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));--mj-acc:var(--dsw-alias-brand-primary,#4a86ff);--mj-ok:var(--dsw-alias-state-success-primary,#2fa96b);--mj-warn:var(--dsw-alias-state-warn-primary,#d99a2b);--mj-bad:var(--dsw-alias-state-error-primary,#e05252);--mj-take:#e8833a;--mj-sh1:var(--mj-e1);--mj-sh2:var(--mj-e1);display:flex;flex-direction:column;height:100%;min-height:0;color:var(--mj-text);font-size:var(--mj-fs-body);line-height:var(--mj-lh-body);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;background:radial-gradient(1100px 320px at 12% -8%,color-mix(in srgb,var(--mj-acc) 9%,transparent),transparent 68%),var(--dsw-alias-bg-base,transparent)}
.mj-root *{box-sizing:border-box}
.mj-root{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--mj-dim) 42%,transparent) transparent}
.mj-root ::-webkit-scrollbar{width:12px;height:12px}
.mj-root ::-webkit-scrollbar-track{background:transparent}
.mj-root ::-webkit-scrollbar-thumb{background:linear-gradient(180deg,color-mix(in srgb,var(--mj-dim) 52%,transparent),color-mix(in srgb,var(--mj-dim) 32%,transparent));border-radius:var(--mj-r-cap);border:3px solid transparent;background-clip:content-box;transition:background var(--mj-t),border-width var(--mj-t)}
.mj-root ::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,color-mix(in srgb,var(--mj-acc) 72%,transparent),color-mix(in srgb,var(--mj-acc) 44%,transparent));background-clip:content-box;border-width:2px}
.mj-root ::-webkit-scrollbar-thumb:active{background:color-mix(in srgb,var(--mj-acc) 88%,transparent);background-clip:content-box;border-width:2px}
.mj-root ::-webkit-scrollbar-corner{background:transparent}
/* 滚动条出现/消失时别让内容横向跳一下 —— 那一下也是"闪"的一部分 */
.mj-boardgrid,.mj-plist,.mj-pb,.mj-log,.mj-modalbody,.mj-col{scrollbar-gutter:stable}
/* ── 故事板表头 ────────────────────────────────────────────────
   这个 class 此前**根本没有样式**（裸奔的 div），所以标题、筛选、时间戳是散的，
   右上角也没有落点放刷新。 */
.mj-boardbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;width:100%;min-width:0}
.mj-boardbar .mj-lab.sec{border-top:none;margin-top:0;padding-top:0}
.mj-refresh{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--mj-line2);background:var(--mj-surface2);color:var(--mj-text);border-radius:var(--mj-rs);padding:4px 11px;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;font-family:inherit;transition:transform var(--mj-t),background var(--mj-t),border-color var(--mj-t),box-shadow var(--mj-t),opacity var(--mj-t)}
/* 窄列（成品列表 224px）用图标版：标题 + 计数 + 按钮在 224px 里塞不下带字的按钮 */
.mj-refresh.ic{padding:4px 7px;gap:0;flex:0 0 auto}
.mj-refresh:hover:not([disabled]){background:color-mix(in srgb,var(--mj-acc) 16%,transparent);border-color:color-mix(in srgb,var(--mj-acc) 46%,transparent);transform:translateY(-1px);box-shadow:0 3px 12px color-mix(in srgb,var(--mj-acc) 20%,transparent)}
.mj-refresh:active:not([disabled]){transform:translateY(0) scale(.97)}
.mj-refresh[disabled]{opacity:.55;cursor:default}
.mj-refresh .mj-refi{display:inline-block;line-height:1;font-size:13px}
.mj-refresh.busy .mj-refi{animation:mjSpin .9s linear infinite}
/* 封面只在元素创建时淡入一次；复用时不重播，所以不会"一闪一闪" */
.mj-shotthumb{animation:mjFade 260ms ease both}
.mj-root button:focus-visible,.mj-root input:focus-visible,.mj-root select:focus-visible,.mj-root textarea:focus-visible{outline:2px solid color-mix(in srgb,var(--mj-acc) 62%,transparent);outline-offset:2px}
.mj-top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:11px;padding:9px 14px;flex-wrap:wrap;border-bottom:1px solid var(--mj-line);background:color-mix(in srgb,var(--mj-surface) 94%,transparent);backdrop-filter:blur(14px) saturate(1.4)}
.mj-nav{display:flex;gap:2px;padding:3px;border-radius:var(--mj-r-md);background:var(--mj-surface2);border:1px solid var(--mj-line)}
.mj-navb{position:relative;border:none;background:transparent;color:var(--mj-text);opacity:.6;border-radius:var(--mj-r-sm);white-space:nowrap;padding:5px 14px;font-size:12.5px;cursor:pointer;font-family:inherit;transition:opacity var(--mj-t),background var(--mj-t),color var(--mj-t),box-shadow var(--mj-t)}
.mj-navb:hover{opacity:.92;background:color-mix(in srgb,var(--mj-text) 8%,transparent)}
.mj-navb.on{opacity:1;font-weight:650;color:var(--mj-acc);background:color-mix(in srgb,var(--mj-acc) 16%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--mj-acc) 40%,transparent),0 1px 8px color-mix(in srgb,var(--mj-acc) 22%,transparent)}
.mj-sys{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}
.mj-pill{display:flex;align-items:center;gap:6px;border:1px solid var(--mj-line);border-radius:var(--mj-r-md);padding:4px 10px;font-size:13px;white-space:nowrap;background:var(--mj-surface);font-variant-numeric:tabular-nums;transition:border-color var(--mj-t),background var(--mj-t)}
.mj-pill:hover{border-color:var(--mj-line2);background:var(--mj-surface2)}
.mj-pill b{font-weight:650}
.mj-pill i{font-style:normal;color:var(--mj-dim)}
.mj-led{width:7px;height:7px;border-radius:50%;background:var(--mj-bad);display:inline-block;flex:0 0 auto}
.mj-led.on{background:var(--mj-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--mj-ok) 22%,transparent),0 0 9px var(--mj-ok)}
.mj-head{display:flex;align-items:baseline;gap:11px;padding:14px 16px 9px;flex-wrap:wrap}
.mj-h1{font-size:var(--mj-fs-display);font-weight:700;margin:0;line-height:var(--mj-lh-tight);color:var(--mj-text)}
.mj-sub{color:var(--mj-dim);font-size:var(--mj-fs-body)}
.mj-body,.mj-views{flex:1 1 auto;min-height:0;display:flex;gap:12px;padding:0 14px 12px;overflow:auto}
.mj-products{flex:0 0 auto;display:flex;padding:0 14px;margin-top:var(--mj-s3);min-height:0;width:100%}
.mj-products>.mj-p{flex:1 1 auto;max-height:56vh}
/* 侧栏是**单个大页签面板**，不该受 30vh 限制 —— 那个上限是面板纵向堆叠时代的约束。
   不加这条的话，参数页 663px 的内容只有 196px 可视区，70% 看不见。 */
.mj-side .mj-p{max-height:none;flex:1 1 auto;min-height:0}
.mj-col{display:flex;flex-direction:column;gap:12px;min-height:0;overflow-y:auto;overflow-x:hidden}
.mj-c2,.mj-c3{padding-right:2px}
.mj-c1{flex:0 0 320px}
.mj-c2{flex:0 0 332px}
.mj-c3{flex:0 0 332px}
.mj-c4{flex:1 1 262px;min-width:242px}
.mj-grow{flex:1 1 auto;min-width:0}
.mj-p{position:relative;border:1px solid var(--mj-line);border-radius:var(--mj-r);background:var(--mj-surface);display:flex;flex-direction:column;min-height:0;overflow:hidden;flex:0 0 auto;transition:border-color var(--mj-t),box-shadow var(--mj-t)}
.mj-p:hover{border-color:var(--mj-line2)}
.mj-p.grow{flex:1 1 auto;min-height:150px}
.mj-ph{display:flex;align-items:center;gap:8px;padding:9px 12px;flex:0 0 auto;min-width:0;flex-wrap:nowrap;font-size:var(--mj-fs-micro);font-weight:700;border-bottom:1px solid var(--mj-line);background:linear-gradient(180deg,color-mix(in srgb,var(--mj-text) 5%,transparent),transparent)}
/* 标题独占一行内的可伸缩位：窄列（成品列表只有 224px）里被挤的应该是它后面的东西，
   而不是让"成品列表"四个字折成两行。nowrap + ellipsis 是这里唯一体面的解。 */
.mj-phtitle{flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 表头右侧槽位一律不参与压缩：按钮被压成 10px 宽比换行更难看 */
.mj-ph>.mj-row,.mj-ph>.mj-tag,.mj-ph>.mj-fill{flex:0 0 auto}
.mj-ph>.mj-fill{flex:1 1 auto;min-width:0}
.mj-sq{width:9px;height:9px;border-radius:var(--mj-r-xs);flex:0 0 auto;background:linear-gradient(140deg,var(--mj-acc),color-mix(in srgb,var(--mj-acc) 40%,#d94fd0));box-shadow:0 0 0 1px color-mix(in srgb,var(--mj-acc) 32%,transparent),0 0 9px color-mix(in srgb,var(--mj-acc) 45%,transparent)}
.mj-pb{padding:9px 12px;overflow:auto;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:7px}
.mj-sp{flex:1 1 auto}
.mj-btn{position:relative;border:1px solid var(--mj-line2);background:var(--mj-surface2);color:var(--mj-text);border-radius:var(--mj-rs);padding:5px 11px;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;font-family:inherit;transition:transform var(--mj-t),background var(--mj-t),border-color var(--mj-t),box-shadow var(--mj-t),color var(--mj-t),opacity var(--mj-t)}
.mj-btn:hover:not([disabled]){background:color-mix(in srgb,var(--mj-text) 13%,transparent);border-color:color-mix(in srgb,var(--mj-text) 26%,transparent);transform:translateY(-1px);box-shadow:0 3px 10px rgba(0,0,0,.16)}
.mj-btn:active:not([disabled]){transform:translateY(0) scale(.985)}
.mj-btn[disabled]{opacity:.36;cursor:not-allowed}
.mj-btn.wide{width:100%;text-align:center;padding:5px 11px;font-size:12px}
.mj-btn.pri{color:var(--mj-acc);border-color:color-mix(in srgb,var(--mj-acc) 44%,transparent);background:color-mix(in srgb,var(--mj-acc) 13%,transparent)}
.mj-btn.pri:hover:not([disabled]){background:color-mix(in srgb,var(--mj-acc) 22%,transparent);border-color:color-mix(in srgb,var(--mj-acc) 62%,transparent);box-shadow:0 4px 15px color-mix(in srgb,var(--mj-acc) 26%,transparent)}
.mj-btn.go{color:var(--mj-ok);border-color:color-mix(in srgb,var(--mj-ok) 58%,transparent);background:color-mix(in srgb,var(--mj-ok) 20%,transparent);font-weight:650}
.mj-btn.go:hover:not([disabled]){background:color-mix(in srgb,var(--mj-ok) 24%,transparent);border-color:color-mix(in srgb,var(--mj-ok) 66%,transparent);box-shadow:0 4px 16px color-mix(in srgb,var(--mj-ok) 30%,transparent)}
.mj-btn.bad{color:var(--mj-bad);border-color:color-mix(in srgb,var(--mj-bad) 55%,transparent)}
.mj-btn.ai{color:#fff;border-color:transparent;font-weight:650;background:linear-gradient(100deg,var(--mj-acc),color-mix(in srgb,#7b5cff 40%,var(--mj-acc)) 55%,#d94fd0);box-shadow:0 4px 16px color-mix(in srgb,#d94fd0 30%,transparent)}
.mj-btn.ai:hover:not([disabled]){filter:brightness(1.14) saturate(1.06);box-shadow:0 6px 22px color-mix(in srgb,#d94fd0 44%,transparent)}
.mj-in,.mj-ta{width:100%;border:1px solid var(--mj-line2);background:var(--mj-surface2);color:var(--mj-text);border-radius:var(--mj-rs);padding:3px 8px;font-size:13px;font-family:inherit;transition:border-color var(--mj-t),box-shadow var(--mj-t),background var(--mj-t)}
.mj-in::placeholder,.mj-ta::placeholder{color:color-mix(in srgb,var(--mj-dim) 78%,transparent)}
.mj-in:hover,.mj-ta:hover{border-color:color-mix(in srgb,var(--mj-text) 28%,transparent)}
.mj-in:focus,.mj-ta:focus{outline:none;border-color:color-mix(in srgb,var(--mj-acc) 60%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--mj-acc) 20%,transparent);background:var(--mj-surface)}
.mj-in option{background:var(--mj-overlay);color:var(--mj-text)}
.mj-root select.mj-in{appearance:none;padding-right:24px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 13px) 54%,calc(100% - 9px) 54%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
.mj-ta{min-height:220px;font-family:inherit;line-height:var(--mj-lh-body);font-size:var(--mj-fs-body);resize:vertical}
.mj-params{display:flex;flex-direction:column;gap:3px}
.mj-kv>label{flex:0 0 58px;color:var(--mj-dim);font-size:13px}
.mj-kv>div{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px}
.mj-lab{font-size:13px;color:var(--mj-dim);margin-top:3px}
.mj-lab.sec{display:flex;align-items:center;gap:9px;margin-top:var(--mj-s3);font-weight:700;font-size:var(--mj-fs-micro);border-top:1px solid var(--mj-line);padding-top:var(--mj-s2)}
.mj-lab.sec::after{content:'';flex:1 1 auto;height:1px;background:linear-gradient(90deg,var(--mj-line),transparent)}
.mj-card{position:relative;border:1px solid var(--mj-line);border-radius:var(--mj-r-md);padding:8px;background:var(--mj-surface);cursor:pointer;transition:transform var(--mj-t),border-color var(--mj-t),box-shadow var(--mj-t),background var(--mj-t)}
.mj-card:hover{border-color:var(--mj-line2);background:var(--mj-surface2)}
.mj-card.on{border-color:color-mix(in srgb,var(--mj-acc) 55%,transparent);background:color-mix(in srgb,var(--mj-acc) 8%,var(--mj-surface));box-shadow:inset 3px 0 0 0 var(--mj-acc)}
.mj-thumbwrap{position:relative;border-radius:var(--mj-r-sm);overflow:hidden;background:var(--mj-surface2);height:112px}
.mj-cover{width:100%;height:100%;object-fit:cover;display:block;transition:transform 380ms cubic-bezier(.4,0,.2,1)}
.mj-card:hover .mj-cover{transform:scale(1.06)}
.mj-cover-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--mj-dim);font-size:13px;background:repeating-linear-gradient(45deg,transparent,transparent 7px,color-mix(in srgb,var(--mj-text) 5%,transparent) 7px,color-mix(in srgb,var(--mj-text) 5%,transparent) 14px)}
.mj-covermask{position:absolute;left:0;right:0;bottom:0;height:66px;background:linear-gradient(180deg,transparent,rgba(0,0,0,.86))}
.mj-covertitle{position:absolute;left:9px;right:9px;bottom:22px;font-size:13px;font-weight:650;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.95);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mj-coverstats{position:absolute;left:9px;bottom:6px;font-size:12.5px;color:rgba(255,255,255,.9);font-variant-numeric:tabular-nums;letter-spacing:.2px}
.mj-cardmeta{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px;min-width:0;padding:0 9px}
.mj-cardmeta .mj-tag{max-width:100%;overflow:hidden;text-overflow:ellipsis}
.mj-tag{font-size:12.5px;padding:1.5px 7px;border-radius:var(--mj-r-cap);border:1px solid var(--mj-line2);color:var(--mj-dim);white-space:nowrap;transition:color var(--mj-t),border-color var(--mj-t),background var(--mj-t)}
.mj-tag.ok{color:var(--mj-ok);border-color:color-mix(in srgb,var(--mj-ok) 50%,transparent);background:color-mix(in srgb,var(--mj-ok) 12%,transparent)}
.mj-tag.warn{color:var(--mj-warn);border-color:color-mix(in srgb,var(--mj-warn) 50%,transparent);background:color-mix(in srgb,var(--mj-warn) 12%,transparent)}
.mj-tag.bad{color:var(--mj-bad);border-color:color-mix(in srgb,var(--mj-bad) 50%,transparent);background:color-mix(in srgb,var(--mj-bad) 12%,transparent)}
.mj-mut{color:var(--mj-dim)}
.mj-mono{font-size:var(--mj-fs-body);white-space:pre-wrap;word-break:break-word;line-height:var(--mj-lh-body);font-variant-numeric:tabular-nums}
.mj-err{color:var(--mj-bad);font-size:13px}
.mj-ok{color:var(--mj-ok)}
.mj-a{color:var(--mj-acc);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--mj-acc) 40%,transparent);transition:opacity var(--mj-t),border-color var(--mj-t)}
.mj-a:hover{opacity:.85;border-bottom-color:var(--mj-acc)}
.mj-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.mj-grid2{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.mj-grid4{display:grid;grid-template-columns:repeat(auto-fill,minmax(134px,1fr));gap:9px}
.mj-chips{display:flex;flex-wrap:wrap;gap:5px}
.mj-chip{display:flex;align-items:center;gap:6px;border:1px solid var(--mj-line);border-radius:var(--mj-r-cap);padding:3px 10px;font-size:12.5px;background:var(--mj-surface2);color:var(--mj-dim);cursor:help;transition:color var(--mj-t),border-color var(--mj-t),background var(--mj-t)}
.mj-chip .d{width:6px;height:6px;border-radius:50%;background:color-mix(in srgb,var(--mj-dim) 70%,transparent);flex:0 0 auto}
.mj-chip.running{color:var(--mj-acc);border-color:color-mix(in srgb,var(--mj-acc) 55%,transparent);background:color-mix(in srgb,var(--mj-acc) 14%,transparent)}
.mj-chip.running .d{background:var(--mj-acc);animation:mjPulse 1.2s ease-in-out infinite}
.mj-chip.done{color:var(--mj-ok);border-color:color-mix(in srgb,var(--mj-ok) 48%,transparent);background:color-mix(in srgb,var(--mj-ok) 12%,transparent)}
.mj-chip.done .d{background:var(--mj-ok);box-shadow:0 0 7px var(--mj-ok)}
.mj-chip.failed{color:var(--mj-bad);border-color:color-mix(in srgb,var(--mj-bad) 55%,transparent);background:color-mix(in srgb,var(--mj-bad) 13%,transparent)}
.mj-chip.failed .d{background:var(--mj-bad)}
.mj-chip.manual{color:var(--mj-warn);border-color:color-mix(in srgb,var(--mj-warn) 48%,transparent);background:color-mix(in srgb,var(--mj-warn) 11%,transparent)}
.mj-chip.manual .d{background:var(--mj-warn)}
@keyframes mjPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.72)}}
@keyframes mjSpin{to{transform:rotate(360deg)}}
@keyframes mjFade{from{opacity:0}to{opacity:1}}
@keyframes mjRise{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.mj-spin{width:11px;height:11px;border-radius:50%;display:inline-block;animation:mjSpin .7s linear infinite;border:2px solid color-mix(in srgb,var(--mj-acc) 28%,transparent);border-top-color:var(--mj-acc)}
.mj-log{flex:1 1 auto;min-height:96px;overflow:auto;border:1px solid var(--mj-line);border-radius:var(--mj-r-md);padding:9px 11px;font-family:ui-monospace,Consolas,'Cascadia Mono',monospace;font-size:12.5px;line-height:1.62;background:color-mix(in srgb,var(--mj-overlay) 76%,#000);box-shadow:inset 0 1px 6px rgba(0,0,0,.3)}
/* ── 日志分段 ──────────────────────────────────────────────────
   一段日志几百行，全部糊成一片就没人看得下去：「哪一步」与「这一步的第几镜」
   必须在视觉上分层 —— 阶段头（高对比、吸顶）＞ 镜头块（左侧竖线）＞ 日志行。 */
.mj-lsec{margin:0 0 8px}
.mj-lsec:last-child{margin-bottom:0}
/* ── 日志正文的排版 ──
   原来整行是一坨纯文本：几十行长得一模一样，眼睛找不到"哪句是结果、哪句是噪声"。
   现在：左边标签成片、关键标记上色、数字等宽、长路径压暗换行，行距与内边距也放宽。 */
.mj-ln{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;padding:1.5px 0;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.mj-ln.fail{color:color-mix(in srgb,var(--mj-bad) 78%,var(--mj-text))}
.mj-ln.done{color:color-mix(in srgb,var(--mj-ok) 74%,var(--mj-text))}
.mj-lhead{flex:0 0 auto;display:inline-flex;gap:5px;align-items:baseline}
.mj-ltag{flex:0 0 auto;font-size:10.5px;line-height:1.5;padding:0 5px;border-radius:4px;
  background:color-mix(in srgb,var(--mj-acc) 15%,transparent);
  color:color-mix(in srgb,var(--mj-acc) 68%,var(--mj-text));font-variant-numeric:tabular-nums}
.mj-ltok{font-weight:600}
.mj-lok{color:var(--mj-ok)}
.mj-lbad{color:var(--mj-bad)}
.mj-lwarn{color:var(--mj-warn)}
.mj-lnum{color:color-mix(in srgb,var(--mj-acc) 62%,var(--mj-text));font-weight:600;font-variant-numeric:tabular-nums}
.mj-lpath{color:var(--mj-dim);font-weight:400}
.mj-lrep{flex:0 0 auto;font-size:10px;line-height:1.5;padding:0 5px;border-radius:999px;
  background:var(--mj-surface2);color:var(--mj-dim);font-variant-numeric:tabular-nums}
.mj-lsech{position:sticky;top:-9px;z-index:2;display:flex;align-items:center;gap:7px;padding:4px 8px;margin:2px 0 5px;border-radius:var(--mj-r-sm);background:linear-gradient(180deg,color-mix(in srgb,var(--mj-acc) 18%,var(--mj-overlay)),color-mix(in srgb,var(--mj-acc) 7%,var(--mj-overlay)));border:1px solid color-mix(in srgb,var(--mj-acc) 32%,transparent);font-family:inherit;font-size:12px;font-weight:700;color:color-mix(in srgb,var(--mj-acc) 70%,var(--mj-text))}
.mj-lsecd{width:7px;height:7px;border-radius:2px;flex:0 0 auto;background:linear-gradient(140deg,var(--mj-acc),color-mix(in srgb,var(--mj-acc) 40%,#d94fd0));box-shadow:0 0 8px color-mix(in srgb,var(--mj-acc) 50%,transparent)}
.mj-lsecn{font-weight:600;font-size:11px;color:var(--mj-dim);font-variant-numeric:tabular-nums}
.mj-lsecwrap{padding-left:3px}
.mj-lsub{border-left:2px solid color-mix(in srgb,var(--mj-line2) 75%,transparent);padding-left:9px;margin:7px 0 7px 5px}
.mj-lsubh{display:flex;align-items:center;gap:6px;font-family:inherit;font-size:11.5px;font-weight:700;color:var(--mj-dim);margin-bottom:2px}
.mj-lsubn{font-weight:600;font-size:10.5px;opacity:.85;font-variant-numeric:tabular-nums}
/* 危险动作按钮：默认只是"红边"，点过一次才变实心红并脉动 —— 两步确认，
   既不用再开一层弹窗，也不会让手滑一次就永久删库。 */
.mj-btn.danger{border-color:color-mix(in srgb,var(--mj-bad) 52%,transparent);color:var(--mj-bad)}
.mj-btn.danger:hover:not([disabled]){background:color-mix(in srgb,var(--mj-bad) 15%,transparent);border-color:color-mix(in srgb,var(--mj-bad) 72%,transparent)}
.mj-btn.danger.armed{background:color-mix(in srgb,var(--mj-bad) 26%,transparent);border-color:var(--mj-bad);color:#fff;font-weight:700;animation:mjPulse 1.15s ease-in-out infinite}
.mj-dangerbox{border:1px solid color-mix(in srgb,var(--mj-bad) 40%,transparent);border-radius:var(--mj-r-md);padding:9px 11px;background:color-mix(in srgb,var(--mj-bad) 8%,transparent)}
.mj-ln{white-space:pre-wrap;word-break:break-all;color:color-mix(in srgb,var(--mj-text) 76%,transparent)}
.mj-ln.stage{color:var(--mj-acc);font-weight:650}
.mj-ln.fail{color:var(--mj-bad)}
.mj-ln.done{color:var(--mj-ok)}
.mj-radio{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;color:var(--mj-dim);padding:3px 2px;transition:color var(--mj-t)}
.mj-radio:hover{color:var(--mj-text)}
.mj-radio.on{color:var(--mj-acc);font-weight:650}
.mj-radio .b{width:12px;height:12px;border-radius:50%;border:1.5px solid currentColor;display:inline-block;position:relative;flex:0 0 auto;transition:box-shadow var(--mj-t)}
.mj-radio.on .b{box-shadow:0 0 0 3px color-mix(in srgb,var(--mj-acc) 18%,transparent)}
.mj-radio.on .b:after{content:'';position:absolute;inset:2px;border-radius:50%;background:currentColor}
.mj-errbar{display:flex;align-items:center;gap:10px;margin:0 14px 9px;padding:8px 12px;border-radius:var(--mj-r-md);font-size:13px;border:1px solid color-mix(in srgb,var(--mj-bad) 45%,transparent);background:color-mix(in srgb,var(--mj-bad) 12%,transparent)}
.mj-mask{position:fixed;inset:0;background:color-mix(in srgb,#000 62%,transparent);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9999;animation:mjFade 160ms ease-out}
.mj-modal{background:var(--mj-overlay);border:1px solid var(--mj-line2);border-radius:var(--mj-r-lg);min-width:440px;max-width:min(780px,92vw);max-height:86vh;display:flex;flex-direction:column;box-shadow:var(--mj-sh2);color:var(--mj-text);animation:mjRise 200ms cubic-bezier(.2,.9,.3,1)}
.mj-modalhead{display:flex;align-items:center;gap:9px;padding:13px 16px;border-bottom:1px solid var(--mj-line);font-weight:650;font-size:13.5px}
.mj-modalbody{padding:15px 16px;overflow:auto;display:flex;flex-direction:column;gap:11px}
.mj-x{border:none;background:transparent;color:var(--mj-dim);font-size:20px;line-height:1;cursor:pointer;padding:0 7px;border-radius:var(--mj-r-sm);transition:color var(--mj-t),background var(--mj-t)}
.mj-x:hover{color:var(--mj-text);background:color-mix(in srgb,var(--mj-text) 10%,transparent)}
.mj-thumb{width:100%;height:58px;object-fit:cover;border-radius:var(--mj-r-sm);background:var(--mj-surface2);display:block;transition:transform var(--mj-t)}
.mj-card:hover .mj-thumb{transform:scale(1.04)}
.mj-vid{width:100%;border-radius:var(--mj-r-sm);background:#000;max-height:112px;display:block}
.mj-bar{height:6px;border-radius:var(--mj-r-cap);background:var(--mj-surface2);overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,.2)}
.mj-bar>i{display:block;height:100%;border-radius:var(--mj-r-cap);transition:width .4s cubic-bezier(.4,0,.2,1);background:linear-gradient(90deg,color-mix(in srgb,var(--mj-acc) 65%,transparent),var(--mj-acc));box-shadow:0 0 9px color-mix(in srgb,var(--mj-acc) 55%,transparent)}
.mj-pre{margin:0;font-family:ui-monospace,Consolas,'Cascadia Mono',monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-word;line-height:1.6;max-height:130px;overflow:auto;color:var(--mj-dim);background:var(--mj-surface2);border:1px solid var(--mj-line);border-radius:var(--mj-r-sm);padding:8px 10px}
.mj-crash{padding:16px 18px;display:flex;flex-direction:column;gap:10px;color:var(--mj-text)}
.mj-crash-h{font-size:var(--mj-fs-head);font-weight:700}
.mj-crash-m{color:var(--mj-bad);font-size:var(--mj-fs-body);word-break:break-word}
.mj-crash-s{margin:0;max-height:34vh;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;color:var(--mj-dim);background:var(--mj-surface2);border:1px solid var(--mj-line);border-radius:var(--mj-r-sm);padding:8px 10px}
/* 画风生效预览：把"会加上什么、作用在哪"摆明。以前只有一行 12px 灰字，说了等于没说。 */
/* 渲染配置块：标签 + 控件一行，说明一行常驻可见 */
.mj-opt{display:flex;flex-direction:column;gap:2px;padding:5px 0}
.mj-opt+.mj-opt{border-top:1px solid var(--mj-line)}
.mj-optrow{display:flex;align-items:center;gap:8px;min-width:0}
.mj-optlab{flex:0 0 46px;font-size:13px;color:var(--mj-dim)}
.mj-opthelp{font-size:var(--mj-fs-micro);line-height:1.5;color:var(--mj-dim);padding-left:54px}
.mj-opthelp b{color:var(--mj-text);font-weight:600}
.mj-opthelp .warn{color:var(--mj-warn)}
/* 按钮式二选一（VAE int8/fp16 这类）；.mj-seg 是计数分段的样式，不要混用 */
.mj-segs{display:inline-flex;gap:4px}
.mj-sg{border:1px solid var(--mj-line);background:transparent;color:var(--mj-dim);font-family:inherit;
font-size:var(--mj-fs-micro);padding:3px 10px;border-radius:var(--mj-r-xs);cursor:pointer;
transition:color var(--mj-t),border-color var(--mj-t),background var(--mj-t)}
.mj-sg.on{color:var(--mj-text);border-color:color-mix(in srgb,var(--mj-acc) 55%,transparent);
background:color-mix(in srgb,var(--mj-acc) 14%,transparent)}
/* 当前配方：一眼看清最终生效的组合 */
.mj-recipe{display:flex;flex-direction:column;gap:2px;border:1px solid var(--mj-line);
border-radius:var(--mj-r-md);background:var(--mj-surface2);padding:8px 10px;
font-size:var(--mj-fs-micro);color:var(--mj-text);line-height:1.5;font-variant-numeric:tabular-nums}
.mj-recipe i{display:inline-block;width:38px;font-style:normal;color:var(--mj-dim)}
.mj-stybox{border:1px solid var(--mj-line);border-radius:var(--mj-r-md);background:var(--mj-surface2);padding:8px 10px;display:flex;flex-direction:column;gap:5px}
.mj-styhead{display:flex;align-items:center;gap:6px;font-size:var(--mj-fs-micro);color:var(--mj-dim)}
.mj-styval{font-size:var(--mj-fs-body);line-height:1.5;word-break:break-word;color:var(--mj-text);font-variant-numeric:tabular-nums}
.mj-styfoot{font-size:var(--mj-fs-micro);color:var(--mj-dim);line-height:1.45;border-top:1px solid var(--mj-line);padding-top:5px}
.mj-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:18px 10px;color:var(--mj-dim);font-size:13px;text-align:center}
.mj-pre.mj-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-height:none}
.mj-foot{display:flex;align-items:center;gap:9px;padding:8px 16px 10px;font-size:13px;flex-wrap:wrap}
.mj-brand{display:flex;align-items:center;gap:9px}
.mj-brandmark{width:24px;height:24px;border-radius:var(--mj-r-sm);display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(140deg,var(--mj-acc),color-mix(in srgb,var(--mj-acc) 25%,#d94fd0));box-shadow:0 2px 10px color-mix(in srgb,var(--mj-acc) 38%,transparent)}
.mj-grid4>.mj-empty,.mj-grid2>.mj-empty{grid-column:1/-1}
.mj-empty>span:first-child{font-size:17px;opacity:.45;line-height:1}
.mj-stack{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.mj-work{flex:1 1 auto;min-height:0;display:flex;gap:12px;padding:0 14px;overflow:hidden}
/* ★ 工作区必须有高度下限。
   不加的话它会被下面的运行条 + 产物面板挤到几十像素（实测 77px），
   于是侧栏面板只剩 105px 可视区，参数页 663px 的内容 84% 看不见 —— 
   而根因根本不在侧栏本身，在这里。给下限，让下面两块去分剩下的。 */
.mj-work{min-height:38vh}
.mj-side{flex:0 0 336px;display:flex;flex-direction:column;min-height:0;gap:10px}
.mj-side.off{flex:0 0 42px}
.mj-sidebody{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:12px}
.mj-rail{flex:1 1 auto;writing-mode:vertical-rl;display:flex;align-items:center;justify-content:center;gap:10px;border:1px solid var(--mj-line);border-radius:var(--mj-r);background:var(--mj-surface);color:var(--mj-dim);cursor:pointer;font-size:12px;letter-spacing:4px;font-family:inherit;padding:14px 0;transition:color var(--mj-t),border-color var(--mj-t),background var(--mj-t)}
.mj-rail:hover{color:var(--mj-acc);border-color:color-mix(in srgb,var(--mj-acc) 45%,transparent);background:color-mix(in srgb,var(--mj-acc) 8%,var(--mj-surface))}
.mj-board{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;min-height:0}
.mj-boardscroll{flex:1 1 auto;min-height:0;overflow:auto;padding:1px}
/* 分集分组后**滚动只发生在最外层**：网格自己再带 flex/overflow 会变成每组各滚一遍 */
.mj-boardgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:11px;align-content:start}
/* 分集分组的表头：多集项目里 24 张卡平铺认不出归属，靠它切开 */
.mj-epgroup{margin-bottom:14px}
.mj-ephead{display:flex;align-items:center;gap:8px;padding:0 2px 7px;margin-bottom:9px;border-bottom:1px solid var(--mj-line)}
.mj-eptag{font-size:12px;font-weight:700;letter-spacing:.02em;padding:2px 9px;border:1px solid var(--mj-line);border-radius:999px;background:var(--mj-surface2)}
.mj-shot{border:1px solid var(--mj-line);border-radius:var(--mj-r-md);background:var(--mj-surface);overflow:hidden;display:flex;flex-direction:column;transition:border-color var(--mj-t),box-shadow var(--mj-t),transform var(--mj-t)}
.mj-shot:hover{border-color:var(--mj-line2)}
.mj-shot.ok{border-color:color-mix(in srgb,var(--mj-ok) 42%,transparent)}
.mj-shot.bad{border-color:color-mix(in srgb,var(--mj-bad) 62%,transparent)}
.mj-shot.done{border-color:color-mix(in srgb,var(--mj-acc) 40%,transparent)}
.mj-shot.running{border-color:color-mix(in srgb,var(--mj-take) 78%,transparent);box-shadow:inset 3px 0 0 0 var(--mj-take);animation:mjShotPulse 1.6s ease-in-out infinite}
@keyframes mjShotPulse{0%,100%{box-shadow:0 0 0 1px color-mix(in srgb,var(--mj-acc) 32%,transparent),0 0 10px color-mix(in srgb,var(--mj-acc) 20%,transparent)}50%{box-shadow:0 0 0 1px color-mix(in srgb,var(--mj-acc) 55%,transparent),0 0 24px color-mix(in srgb,var(--mj-acc) 40%,transparent)}}
.mj-shotmedia{position:relative;aspect-ratio:16/9;background:#07101f;cursor:pointer;display:block;overflow:hidden}
.mj-shotthumb{width:100%;height:100%;object-fit:cover;display:block}
.mj-lbmask{position:fixed;inset:0;z-index:10000;background:rgba(4,8,16,.88);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:24px;animation:mjFade 140ms ease-out}
.mj-lb{display:flex;flex-direction:column;max-width:min(1400px,94vw);max-height:92vh;background:var(--mj-overlay);border:1px solid var(--mj-line2);border-radius:var(--mj-r-lg);box-shadow:var(--mj-e1);overflow:hidden;animation:mjRise 180ms cubic-bezier(.2,.9,.3,1)}
.mj-lbhead{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:0 0 auto;border-bottom:1px solid var(--mj-line);font-size:var(--mj-fs-body)}
.mj-lbname{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.mj-lbcount{font-size:var(--mj-fs-micro);color:var(--mj-dim);font-variant-numeric:tabular-nums}
.mj-lbbody{position:relative;display:flex;align-items:center;justify-content:center;min-height:0;background:#05080f;padding:8px}
.mj-lbmedia{max-width:100%;max-height:calc(92vh - 110px);object-fit:contain;display:block;border-radius:var(--mj-r-sm);background:#000}
.mj-lbnav{position:absolute;top:50%;transform:translateY(-50%);width:38px;height:64px;display:flex;align-items:center;justify-content:center;font-size:26px;line-height:1;border:1px solid var(--mj-line2);background:rgba(6,12,24,.82);color:var(--mj-text);font-family:inherit;cursor:pointer;border-radius:var(--mj-r-md);opacity:.75;transition:opacity var(--mj-t),background var(--mj-t)}
.mj-lbnav:hover:not([disabled]){opacity:1;background:rgba(6,12,24,.96)}
.mj-lbnav[disabled]{opacity:.22;cursor:default}
.mj-lbnav.prev{left:10px}
.mj-lbnav.next{right:10px}
.mj-lbnote{padding:8px 12px;font-size:var(--mj-fs-micro);color:var(--mj-dim);border-top:1px solid var(--mj-line);font-variant-numeric:tabular-nums}
.mj-zoomable{cursor:zoom-in}
.mj-zoomable:hover{outline:2px solid color-mix(in srgb,var(--mj-acc) 55%,transparent);outline-offset:-2px}
.mj-shotmedia video,.mj-shotmedia img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.mj-shotph{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:var(--mj-dim);font-size:13px;text-align:center;padding:6px;background:repeating-linear-gradient(45deg,transparent,transparent 8px,color-mix(in srgb,var(--mj-text) 6%,transparent) 8px,color-mix(in srgb,var(--mj-text) 6%,transparent) 16px)}
.mj-shotno{position:absolute;left:7px;top:7px;font-size:12.5px;font-weight:700;padding:1.5px 7px;border-radius:var(--mj-r-xs);background:rgba(0,0,0,.66);color:#fff;font-variant-numeric:tabular-nums;border:1px solid rgba(255,255,255,.22)}
.mj-shotdur{position:absolute;right:7px;bottom:7px;font-size:12px;padding:1px 6px;border-radius:var(--mj-r-xs);background:rgba(0,0,0,.66);color:#fff;font-variant-numeric:tabular-nums}
.mj-shotbody{padding:8px 9px 9px;display:flex;flex-direction:column;gap:7px;flex:1 1 auto;min-height:0}
.mj-shotprompt{font-size:var(--mj-fs-micro);line-height:1.5;color:var(--mj-dim);display:-webkit-box;overflow-wrap:anywhere;word-break:break-word;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.mj-shotacts{display:flex;gap:5px;margin-top:auto}
.mj-run{flex:0 0 auto;display:flex;flex-direction:column;gap:8px;margin:12px 14px 0;padding:9px 12px;border:1px solid var(--mj-line);border-radius:var(--mj-r);background:var(--mj-surface)}
.mj-runbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mj-runbar .mj-log{margin-top:2px}
.mj-dots{position:absolute;right:6px;top:6px;z-index:3;width:22px;height:22px;padding:0;display:flex;align-items:center;justify-content:center;line-height:1;border:1px solid rgba(255,255,255,.22);border-radius:var(--mj-r-xs);background:rgba(0,0,0,.55);color:rgba(255,255,255,.82);font-family:inherit;font-size:14px;cursor:pointer;opacity:0;transition:opacity var(--mj-t),background var(--mj-t)}
.mj-card:hover .mj-dots,.mj-card.on .mj-dots,.mj-dots.on{opacity:1}
.mj-dots:hover{background:rgba(0,0,0,.78);color:#fff}
.mj-menu{position:absolute;right:6px;top:30px;z-index:5;min-width:124px;display:flex;flex-direction:column;padding:4px;background:var(--mj-overlay);border:1px solid var(--mj-line2);border-radius:var(--mj-r-md);box-shadow:var(--mj-e1)}
.mj-menu-fixed{position:fixed;right:auto;top:auto;z-index:60}
.mj-plist{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;overflow:auto;min-width:0}
.mj-prow{position:relative;display:flex;align-items:center;gap:9px;padding:7px 8px;border:1px solid transparent;border-radius:var(--mj-r-sm);cursor:pointer;min-width:0;transition:background var(--mj-t),border-color var(--mj-t),transform var(--mj-t)}
.mj-prow:hover{background:var(--mj-surface2);border-color:var(--mj-line)}
.mj-prow.on{background:color-mix(in srgb,var(--mj-acc) 11%,var(--mj-surface));border-color:color-mix(in srgb,var(--mj-acc) 45%,transparent);box-shadow:inset 3px 0 0 0 var(--mj-acc)}
.mj-pthumb{flex:0 0 auto;width:84px;height:48px;border-radius:var(--mj-r-sm);object-fit:cover;background:var(--mj-surface2);outline:1px solid rgba(255,255,255,.10);outline-offset:-1px}
.mj-pthumb-ph{display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:var(--mj-dim);background:linear-gradient(135deg,color-mix(in srgb,var(--mj-acc) 26%,var(--mj-surface2)),var(--mj-surface2))}
.mj-pinfo{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;padding-right:26px}
/* 标题允许两行：单行 + ellipsis 会把「机心问道」截成「机心…」，读不出是哪部剧 */
.mj-ptitle{font-size:13.5px;font-weight:700;line-height:1.35;letter-spacing:.01em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.mj-pmeta{font-size:11.5px;color:var(--mj-dim);line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
/* 进度条只在**没渲完**时出现：渲完时它是满宽绿线，正好压在题材下面，
   视觉上就是"给标题划了条下划线"（用户原话：这什么排版啊） */
.mj-pbar{height:3px;border-radius:1px;background:var(--mj-line);overflow:hidden;margin-top:5px}
.mj-pbar i{display:block;height:100%;border-radius:1px;background:var(--mj-warn);transition:width var(--mj-t)}
.mj-pbar.done{display:none}
.mj-pfinal{flex:0 0 auto;color:var(--mj-ok);font-size:12px;font-weight:700;line-height:1;opacity:.95}
/* ── 大屏播放 ──
   产物面板原来被 max-height:30vh 限死、视频卡再叠 max-height:112px，
   结果是"只能弹出小窗看"。大屏区把选中项铺满宽度、最高 56vh，直接在这里看完。 */
.mj-bigplay{margin:6px 0 10px;border:1px solid var(--mj-line);border-radius:var(--mj-r-md);overflow:hidden;background:#000}.mj-bigvid{width:100%;max-height:56vh;display:block;background:#000}

.mj-bigbar{display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--mj-surface);border-top:1px solid var(--mj-line)}
.mj-clipcard .mj-vid{max-height:112px;cursor:pointer}
/* 成片列表：成片是交付物，给足尺寸（2 列大播放器），不与分镜小卡混排 */
.mj-filmgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px}
.mj-filmcard{display:flex;flex-direction:column;gap:0;border:1px solid var(--mj-line);border-radius:var(--mj-r-sm);overflow:hidden;background:var(--mj-surface)}
.mj-filmcard .mj-vid{width:100%;aspect-ratio:16/9;background:#000;display:block}
.mj-prow .mj-dots{position:static;width:20px;height:20px;font-size:13px;background:transparent;border-color:transparent;color:var(--mj-dim)}
.mj-prow:hover .mj-dots,.mj-prow.on .mj-dots,.mj-prow .mj-dots.on{opacity:1}
.mj-prow .mj-dots:hover{color:var(--mj-text);border-color:var(--mj-line2);background:var(--mj-surface2)}
.mj-prename{width:100%;background:var(--mj-surface2);border:1px solid var(--mj-acc);border-radius:var(--mj-r-xs);color:var(--mj-text);font-family:inherit;font-size:var(--mj-fs-body);padding:1px 5px;outline:none}
.mj-clipgrid{display:grid;gap:var(--mj-s3);grid-template-columns:repeat(auto-fill,minmax(224px,1fr));padding-bottom:2px}
.mj-clipcard{display:flex;flex-direction:column;min-width:0;overflow:hidden;border:1px solid var(--mj-line);border-radius:var(--mj-r-md);background:var(--mj-surface);transition:border-color var(--mj-t)}
.mj-clipcard:hover{border-color:var(--mj-line2)}
.mj-clipcard.on{border-color:color-mix(in srgb,var(--mj-acc) 42%,transparent)}
.mj-clipcard .mj-vid{display:block;width:100%;aspect-ratio:16/9;background:#07101f;border:0;border-radius:0;object-fit:contain}
.mj-clipinfo{display:flex;align-items:center;gap:6px;padding:6px 8px 0;min-width:0}
.mj-clipname{flex:1 1 auto;min-width:0;font-size:var(--mj-fs-body);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mj-cliptag{flex:0 0 auto;font-size:var(--mj-fs-micro);color:var(--mj-dim);border:1px solid var(--mj-line);border-radius:var(--mj-r-xs);padding:1px 6px}
.mj-cliptag.on{color:var(--mj-ok);border-color:color-mix(in srgb,var(--mj-ok) 42%,transparent)}
.mj-clipmeta{display:flex;align-items:center;gap:5px;padding:5px 8px 8px;font-size:var(--mj-fs-micro);color:var(--mj-dim);font-variant-numeric:tabular-nums}
.mj-mi{text-align:left;border:0;background:transparent;color:var(--mj-text);font-family:inherit;font-size:var(--mj-fs-body);padding:6px 10px;border-radius:var(--mj-r-xs);cursor:pointer;transition:background var(--mj-t),color var(--mj-t)}
.mj-mi:hover{background:var(--mj-surface2)}
.mj-mi.danger:hover{color:var(--mj-bad);background:color-mix(in srgb,var(--mj-bad) 12%,transparent)}
.mj-menu-backdrop{position:fixed;inset:0;z-index:4}
.mj-mini{border:1px solid var(--mj-line);background:transparent;color:var(--mj-dim);font-family:inherit;font-size:var(--mj-fs-micro);padding:2px 8px;border-radius:var(--mj-r-xs);cursor:pointer;transition:color var(--mj-t),border-color var(--mj-t),background var(--mj-t)}
.mj-mini:hover{color:var(--mj-text);border-color:var(--mj-line2);background:var(--mj-surface2)}
.mj-mini.danger:hover{color:var(--mj-bad);border-color:color-mix(in srgb,var(--mj-bad) 55%,transparent)}
.mj-fill{flex:1 1 auto;min-width:0;display:flex;gap:6px;padding:0 var(--mj-s2)}
.mj-seg{flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--mj-line);background:transparent;color:var(--mj-dim);font-family:inherit;font-size:var(--mj-fs-micro);padding:3px 6px;border-radius:var(--mj-r-xs);cursor:pointer;transition:color var(--mj-t),border-color var(--mj-t),background var(--mj-t)}
.mj-seg:hover{color:var(--mj-text);border-color:var(--mj-line2);background:var(--mj-surface2)}
.mj-seg.on{border-color:color-mix(in srgb,var(--mj-acc) 55%,transparent);color:var(--mj-text)}
.mj-seg .k{opacity:.75}
.mj-seg b{font-weight:700;font-variant-numeric:tabular-nums}
.mj-coverrename{position:absolute;left:9px;right:9px;bottom:38px;width:auto;background:rgba(0,0,0,.8);border:1px solid var(--mj-acc);border-radius:var(--mj-r-xs);color:#fff;font-family:inherit;font-size:var(--mj-fs-body);padding:3px 7px;outline:none}`;

		// ───────────────────────── 数据通道 ─────────────────────────

		async function api(cmd, args) {
			try {
				const r = await fetch(API, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ cmd: cmd, args: args || {} }),
				});
				return await r.json();
			} catch (e) {
				return { error: String((e && e.message) || e) };
			}
		}

		function mediaUrl(pid, rel) {
			return FILE + "?p=" + encodeURIComponent(pid) + "&r=" + encodeURIComponent(rel);
		}

		// ───────────────────────── 小工具 ─────────────────────────

		function fmtGB(n) {
			if (!n && n !== 0) return "—";
			return (n / 1073741824).toFixed(1) + "G";
		}

		function fmtMB(n) {
			return ((n || 0) / 1048576).toFixed(1) + " MB";
		}

		/** 人话时长：渲染一镜要 5 分钟，监视条上写"已跑 3720 秒"没人读得出来。 */
		function fmtDur(sec) {
			const s = Math.max(0, Math.round(Number(sec) || 0));
			if (s < 60) return s + " 秒";
			const m = Math.floor(s / 60);
			if (m < 60) return m + " 分 " + (s % 60) + " 秒";
			return Math.floor(m / 60) + " 小时 " + (m % 60) + " 分";
		}

		function stateText(j) {
			if (!j) return "空闲";
			if (j.running) return "执行中";
			if (j.exitCode === 0) return "已完成";
			if (j.exitCode === -2) return "已停止";
			return "异常结束";
		}

		function logClass(L) {
			if (L.indexOf("━━━") >= 0) return "mj-ln stage";
			if (/^\s*(FAIL|失败|\[管线异常\])/.test(L) || L.indexOf("失败") >= 0) return "mj-ln fail";
			if (/^\s*(完成|质检通过|===)/.test(L) || L.indexOf("===") >= 0) return "mj-ln done";
			return "mj-ln";
		}

		const LOG_TOK = /(\u2713|\u2715|\u26a0|失败|不合格|质检通过|完成|渲染中|已存在|跳过|错误|Error|FAIL)|(\d+(?:\.\d+)?\s*(?:s|帧|MB|KB|GB|%|dB))|([A-Za-z]:\\[^\s]+|[\w\u4e00-\u9fff./-]+\.(?:mp4|png|jpg|jpeg|json|log|txt|ass|safetensors))/g;

		const logSev = (t) => (/[\u2713]|完成|质检通过/.test(t) ? "mj-lok"
			: /[\u2715]|失败|不合格|错误|Error|FAIL/.test(t) ? "mj-lbad" : "mj-lwarn");

		/**
		 * 进度行折叠：渲染时每 30 秒打一行"渲染中 30s …"，一镜十几行、一小时上百行，
		 * 全铺出来就是"一排排一样的字"，这是日志排版显丑的第一大来源。
		 * 同一镜的**连续**进度只留最后一行，旁边标 ×N 说明折叠了几次。
		 */
		function collapseProgress(rows) {
			const out = [];
			let last = null;
			for (let i = 0; i < rows.length; i++) {
				const L = String(rows[i]);
				const m = /^\s*\[([^\]]+)\]\s*渲染中\s+\d+s/.exec(L);
				if (m) {
					if (last && last.tag === m[1]) { last.n++; last.text = L; continue }
					last = { tag: m[1], n: 1, text: L };
					out.push(last);
					continue;
				}
				last = null;
				out.push({ tag: "", n: 0, text: L });
			}
			return out;
		}

		/**
		 * 一行日志的排版：`[标签]` 抽成小片、关键标记上色、数字等宽、长路径压暗。
		 * 原来整行是一坨纯文本 —— 没有视觉层级，眼睛在几十行里找不到"哪句是结果、哪句是噪声"。
		 */
		function LogLine(props) {
			const L = String(props.text === undefined || props.text === null ? "" : props.text);
			const mTag = /^\s*\[([^\]]+)\]\s*/.exec(L);
			const head = [];
			let rest = L;
			if (mTag) {
				head.push(h("span", { className: "mj-ltag", key: "t" }, mTag[1]));
				rest = L.slice(mTag[0].length);
			}
			const parts = [];
			let at = 0;
			rest.replace(LOG_TOK, (mm, sev, num, path, off) => {
				if (off > at) parts.push(rest.slice(at, off));
				parts.push(h("span", {
					className: "mj-ltok " + (sev ? logSev(mm) : num ? "mj-lnum" : "mj-lpath"),
					key: "s" + off,
				}, mm));
				at = off + mm.length;
				return mm;
			});
			if (at < rest.length) parts.push(rest.slice(at));
			return h("div", { className: logClass(L) },
				head.length ? h("span", { className: "mj-lhead" }, head) : null,
				parts,
				props.n > 1
					? h("span", { className: "mj-lrep", title: "中间重复的进度行已折叠" }, "\u00d7" + props.n)
					: null);
		}

		/**
		 * 把一份日志切成「阶段 → 镜头块」两级分段。
		 *
		 * 两种标记都认，因为它们真的会在同一份日志里同时出现：
		 *   * 管线日志：`━━━ 阶段 渲染 ━━━`（宿主 execStage 打的）
		 *   * 渲染日志：`[3/15] s03  1344x768 …`（manju.py 每个镜头一条）
		 * 渲染阶段里 manju.py 的输出被原样并进管线日志，所以两级结构正好对上
		 * 「哪一步」与「这一步的第几镜」。
		 */
		function splitLogSections(lines) {
			const secs = [];
			let stage = null;
			let shot = null;
			const openStage = (name, kind) => {
				// 默认容器用 kind:"boot" 与真正的阶段标记（"stage"）区分开 ——
				// 都是 "stage" 的话，"这份日志有没有阶段标记"就永远判成真，平铺逻辑等于没写。
				stage = { title: name, kind: kind || "stage", lines: [], subs: [] };
				secs.push(stage);
				shot = null;
			};
			for (let i = 0; i < lines.length; i++) {
				const L = String(lines[i] === undefined || lines[i] === null ? "" : lines[i]);
				const ms = /^\s*━+\s*阶段\s*(.+?)\s*━+\s*$/.exec(L);
				if (ms) { openStage(ms[1]); continue }
				if (!stage) openStage("启动", "boot");
				const mh = /^\[(\d+)\/(\d+)\]\s+(\S+)/.exec(L);
				if (mh) {
					shot = { title: "镜头 " + mh[3], kind: "shot", num: mh[1], total: mh[2], lines: [] };
					stage.subs.push(shot);
					continue;
				}
				if (shot) shot.lines.push(L);
				else stage.lines.push(L);
			}
			// 整份日志一个阶段标记都没有时（纯渲染日志就是这种），
			// **不要把 15 个镜头全塞进一个壳里**：直接把镜头块升成顶层分段，
			// 读者一眼就能找到"哪一镜"。壳的名字只留给真有阶段标记时的引导行。
			const hasStage = secs.some((s) => s.kind === "stage");
			if (!hasStage) {
				const out = [];
				for (let i = 0; i < secs.length; i++) {
					const lead = secs[i].lines.filter((L) => L.trim() !== "");
					if (lead.length) out.push({ title: "启动", kind: "boot", lines: lead, subs: [] });
					for (let j = 0; j < secs[i].subs.length; j++) {
						const sub = secs[i].subs[j];
						out.push({ title: sub.title, kind: "shot", lines: sub.lines, subs: [], num: sub.num, total: sub.total });
					}
				}
				if (out.length) return out;
			}
			return secs;
		}

		/** 取日志尾部若干行：几百 KB 的渲染日志整段塞进 DOM 会把界面卡死。 */
		function logTailLines(text, max) {
			const lines = String(text || "").split(/\r?\n/);
			const n = max || 1500;
			return lines.length > n ? lines.slice(lines.length - n) : lines;
		}

		/** 一段日志的"有效行数"（空行不算，否则计数会虚高）。 */
		function sectionCount(s) {
			let n = 0;
			for (let i = 0; i < s.lines.length; i++) if (s.lines[i].trim() !== "") n += 1;
			for (let j = 0; j < s.subs.length; j++) {
				const sub = s.subs[j];
				let k = 0;
				for (let i = 0; i < sub.lines.length; i++) if (sub.lines[i].trim() !== "") k += 1;
				if (k) n += k + 1;   // +1 是镜头标题那一行
			}
			return n;
		}

		/**
		 * 分段渲染日志。`reversed` 打开时**段与行都倒序**（最新的在上），
		 * 因为查日志的人 99% 是在问"刚刚发生了什么"。
		 */
		function LogSections(props) {
			const secs = props.sections || [];
			const rev = props.reversed !== false;
			const list = rev ? secs.slice().reverse() : secs.slice();
			const out = [];
			for (let i = 0; i < list.length; i++) {
				const s = list[i];
				const kids = [];
				const own = s.lines.filter((L) => L.trim() !== "");
				if (own.length) {
					const rows = rev ? own.slice().reverse() : own;
					const cols = collapseProgress(rows);
					kids.push(h("div", { className: "mj-lsecbody", key: "own" },
						cols.map((c, k) => h(LogLine, { key: k, text: c.text, n: c.n }))));
				}
				const subs = rev ? s.subs.slice().reverse() : s.subs.slice();
				for (let j = 0; j < subs.length; j++) {
					const sub = subs[j];
					const ls = sub.lines.filter((L) => L.trim() !== "");
					if (!ls.length) continue;
					const rows = rev ? ls.slice().reverse() : ls;
					const cols = collapseProgress(rows);
					kids.push(h("div", { className: "mj-lsub", key: "sub" + j },
						h("div", { className: "mj-lsubh" }, sub.title,
							sub.total ? h("span", { className: "mj-lsubn" }, sub.num + "/" + sub.total) : null),
						cols.map((c, k) => h(LogLine, { key: k, text: c.text, n: c.n }))));
				}
				out.push(h("div", { className: "mj-lsec", key: "sec" + i },
					h("div", { className: "mj-lsech" },
						h("span", { className: "mj-lsecd" }),
						s.title,
						h("span", { className: "mj-sp" }),
						h("span", { className: "mj-lsecn" }, sectionCount(s) + " 行")),
					kids.length ? h("div", { className: "mj-lsecwrap" }, kids) : null));
			}
			return out;
		}

		// ───────────────────────── 通用小件 ─────────────────────────

		function Pane(props) {
			const kids = [];
			if (props.title) {
				kids.push(h("div", { className: "mj-ph", key: "h" },
					h("span", { className: "mj-sq" }),
					h("span", { className: "mj-phtitle", title: props.title }, props.title),
					h("span", { className: "mj-sp" }),
					// fill 槽：吃掉标题与右侧按钮之间的弹性空白。
					// 面板拉满宽度后，中间那块空间不能白白空着（结构要承载信息）。
					props.fill ? h("div", { className: "mj-fill", key: "f" }, props.fill) : null,
					props.right || null));
			}
			if (!props.collapsed) {
				kids.push(h("div", { className: "mj-pb", key: "b", style: props.bodyStyle }, props.children));
			}
			return h("div", {
				className: "mj-p" + (props.grow && !props.collapsed ? " grow" : "") + (props.className ? " " + props.className : ""),
				style: props.style,
			}, kids);
		}

		function KV(props) {
			return h("div", { className: "mj-kv" },
				h("label", null, props.label),
				h("div", null, props.children));
		}

		function Chip(props) {
			const s = props.state || "pending";
			const title = props.note ? props.name + "：" + props.note : props.name;
			return h("span", { className: "mj-chip " + s, title: title },
				h("span", { className: "d" }), props.name);
		}

		/**
		 * 一行渲染配置：标签 + 控件一行，**说明常驻显示在下面**。
		 *
		 * 以前说明只写在 title 里 —— 不悬停就看不到，等于没有说明。
		 * 引擎/渲染这类"选错了要重渲几十分钟"的配置，说明必须一眼可见。
		 */
		function Opt(props) {
			return h("div", { className: "mj-opt" },
				h("div", { className: "mj-optrow" },
					h("span", { className: "mj-optlab" }, props.label),
					props.children),
				props.help ? h("div", { className: "mj-opthelp" }, props.help) : null);
		}

		/**
		 * 媒体预览（灯箱）。
		 *
		 * 统一处理图片与视频：整页里任何缩略图点一下都能放大看，
		 * 并且**带 ←/→ 在同批里翻页** —— 从故事板点开一张参考图，
		 * 可以直接翻到下一镜的参考图，不用关掉再点。
		 *
		 * 交互约定：点背景 / Esc 关闭；←/→ 翻页；图片另给「打开原图」。
		 */
		function Lightbox(props) {
			const v = props.viewer;
			const items = (v && v.items) || [];
			const i = Math.max(0, Math.min((v && v.index) || 0, items.length - 1));
			const it = items[i] || {};
			React.useEffect(() => {
				if (!v) return undefined;
				const onKey = (e) => {
					if (e.key === "Escape") props.onClose();
					else if (e.key === "ArrowLeft" && items.length > 1) props.onStep(-1);
					else if (e.key === "ArrowRight" && items.length > 1) props.onStep(1);
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [v, items.length, props]);
			if (!v || !items.length) return null;
			return h("div", { className: "mj-lbmask", onClick: props.onClose },
				h("div", { className: "mj-lb", onClick: (e) => e.stopPropagation() },
					h("div", { className: "mj-lbhead" },
						h("span", { className: "mj-lbname", title: it.label }, it.label || ""),
						h("span", { className: "mj-sp" }),
						items.length > 1
							? h("span", { className: "mj-lbcount" }, (i + 1) + " / " + items.length)
							: null,
						it.src
							? h("a", {
								className: "mj-btn", href: it.src, target: "_blank", rel: "noreferrer",
								title: "在新标签页打开原图",
							}, "原图 \u2197")
							: null,
						h("button", { className: "mj-x", onClick: props.onClose, title: "关闭（Esc）" }, "\u00d7")),
					h("div", { className: "mj-lbbody" },
						items.length > 1
							? h("button", {
								className: "mj-lbnav prev", disabled: i === 0,
								title: "上一个（←）", onClick: () => props.onStep(-1),
							}, "\u2039")
							: null,
						it.kind === "video"
							? h("video", {
								className: "mj-lbmedia", src: it.src, controls: true, autoPlay: true,
								loop: true, playsInline: true,
							})
							: h("img", { className: "mj-lbmedia", src: it.src, alt: it.label || "" }),
						items.length > 1
							? h("button", {
								className: "mj-lbnav next", disabled: i === items.length - 1,
								title: "下一个（→）", onClick: () => props.onStep(1),
							}, "\u203a")
							: null),
					it.note ? h("div", { className: "mj-lbnote" }, it.note) : null));
		}

		function Modal(props) {
			return h("div", { className: "mj-mask", onClick: props.onClose },
				h("div", { className: "mj-modal", onClick: (e) => e.stopPropagation() },
					h("div", { className: "mj-modalhead" },
						props.title,
						h("span", { className: "mj-sp" }),
						props.actions || null,
						h("button", { className: "mj-x", onClick: props.onClose }, "\u00d7")),
					h("div", { className: "mj-modalbody" }, props.children)));
		}

		function PanelIcon(props) {
			const s = props.size || 18;
			return h("svg", {
				width: s, height: s, viewBox: "0 0 24 24", fill: "none",
				stroke: "currentColor", strokeWidth: props.active ? 1.9 : 1.5,
				strokeLinecap: "round", strokeLinejoin: "round",
				style: { opacity: props.active ? 1 : 0.75 },
			},
				h("rect", { x: 3, y: 5, width: 18, height: 15, rx: 2 }),
				h("path", { d: "M3 10h18" }),
				h("path", { d: "M7.5 5l2 5" }),
				h("path", { d: "M12.5 5l2 5" }),
				h("path", { d: "M17.5 5l2 5" }),
				h("path", { d: "M10 14.5l4 2.2-4 2.3z" }));
		}

		// ───────────────────────── 主组件 ─────────────────────────

		const EMPTY_PROD = { characters: [], scenes: [], props: [], clips: [], novels: [] };

			const ShotCard = React.memo(function ShotCard(props) {
				const r = props.row;
				const s = r.shot;
				const STATE = {
					ok: ["已完成", "ok"], done: ["已渲染", ""], bad: ["不合格", "bad"],
					running: ["渲染中", "warn"], idle: ["待渲染", ""],
				};
				const st = STATE[r.state] || STATE.idle;
				const first = r.refs.length ? r.refs[0] : null;
				const refImg = first && first.image ? first.image : (r.scene && r.scene.image ? r.scene.image : "");
				let media;
				if (r.clip && r.clip.poster) {
					// 用宿主抽好的静态帧当缩略图。
					// 不用 <video> 的原因：preload="metadata" 的视频要等 seek 解码完才有画面，
					// 此前是黑的，任何重绘都会退回黑再重画 —— 那就是"一闪一闪"。
					media = h("img", {
						className: "mj-shotthumb", src: mediaUrl(props.pid, r.clip.poster),
						alt: "", loading: "lazy", decoding: "async",
					});
				} else if (r.clip) {
					// 还没抽到缩略图（首次加载或抽帧失败）→ 退回旧行为，不报错
					media = h("video", {
						src: mediaUrl(props.pid, r.clip.name) + "#t=0.5",
						preload: "metadata", muted: true, playsInline: true,
					});
				} else if (refImg) {
					media = h("img", {
						className: "mj-zoomable", src: mediaUrl(props.pid, refImg),
						alt: "", loading: "lazy", title: "点击放大看参考图（可用 ← → 翻页）",
						onClick: (e) => { e.stopPropagation(); props.onZoom(r, "refs"); },
					});
				} else {
					media = h("div", { className: "mj-shotph" },
						h("span", { style: { fontSize: 15, opacity: .5 } }, "\u25a3"),
						h("span", null, s.shot_size || "待渲染"));
				}
				return h("div", { className: "mj-shot " + r.state },
					h("div", {
						className: "mj-shotmedia", title: "点击查看这一镜的完整提示词与质检结果",
						onClick: () => (r.clip ? props.onZoom(r, "clip") : props.onOpen(r)),
						title: r.clip ? "点击播放这一镜（灯箱内可循环播放）" : "点击查看这一镜的完整提示词与质检结果",
					},
					media,
						h("span", { className: "mj-shotno" }, r.id),
						r.clip ? h("span", { className: "mj-shotdur" }, fmtMB(r.clip.size)) : null),
					h("div", { className: "mj-shotbody" },
						h("div", { className: "mj-row", style: { gap: 4 } },
							h("span", { className: "mj-tag" + (st[1] ? " " + st[1] : "") }, st[0]),
							s.shot_size ? h("span", { className: "mj-tag" }, s.shot_size) : null,
							r.secs ? h("span", { className: "mj-tag" }, r.secs + "s") : null,
							s.mode === "r2v" ? h("span", { className: "mj-tag" }, "Ref2VA") : null),
						h("div", { className: "mj-shotprompt" }, r.prompt || "（无提示词）"),
						r.qc && !r.qc.ok
							? h("div", { className: "mj-err", style: { fontSize: 12 } }, r.qc.problems.join("；"))
							: null,
						h("div", { className: "mj-shotacts" },
							h("button", {
								className: "mj-btn", style: { flex: "1 1 auto" },
								disabled: props.jobRunning, title: "删掉这一镜重新渲染（同时会换 seed）",
								onClick: () => props.onRerender(r.id),
							}, "重渲"),
							h("button", {
								className: "mj-btn", style: { flex: "0 0 auto" },
								onClick: () => props.onOpen(r),
							}, "详情"))));
			});

		// ShotCard 必须定义在**模块级**：定义在 Studio 内部时，每次重绘都是新的组件类型，
		// React 只能把每张卡片卸载重建，卡片里的封面图因此反复重新加载 —— 那就是用户看到的"一闪一闪"。
		// （React.memo 在这时也失效：被比较的类型本身就变了。）

		function Studio() {
			const [view, setView] = React.useState("video");
			const [boot, setBoot] = React.useState({ root: "", projects: [] });
			const [sys, setSys] = React.useState(null);
			const [err, setErr] = React.useState("");
			const [busy, setBusy] = React.useState("");

			const [pid, setPid] = React.useState("");
			const [proj, setProj] = React.useState(null);
			// 初值给 `{}` 而不是 `null`：投影式里到处都在读 params.xxx，
			// 而侧栏初始页签就是「参数」—— `null` 初值意味着**页面一加载就崩**。
			// 空对象让每个字段读出来是 undefined，各处的 `|| 默认值` 自然生效。
			const [params, setParams] = React.useState({});
			const [providers, setProviders] = React.useState([]);
			const [prod, setProd] = React.useState(EMPTY_PROD);

			const [novel, setNovel] = React.useState("");
			const [novelDirty, setNovelDirty] = React.useState(false);
			const [scriptRel, setScriptRel] = React.useState("script/ep01.md");
			const [scriptText, setScriptText] = React.useState("");
			const [scriptDirty, setScriptDirty] = React.useState(false);
			const [scriptList, setScriptList] = React.useState([]);
			const [source, setSource] = React.useState("script");
			const [novelSrc, setNovelSrc] = React.useState("");
			const [scriptSrc, setScriptSrc] = React.useState("");

			const [range, setRange] = React.useState({ chapter: "", episode: "", shots: "" });
			const [scope, setScope] = React.useState(null);

			const [job, setJob] = React.useState(null);
			const [logOpen, setLogOpen] = React.useState(true);
			const [prodTab, setProdTab] = React.useState("characters");
			const [envText, setEnvText] = React.useState("");

			const [showNew, setShowNew] = React.useState(false);
			const [showCast, setShowCast] = React.useState(false);
			const [newP, setNewP] = React.useState({ id: "", title: "", genre: "", style: "" });
			const [castForm, setCastForm] = React.useState({ kind: "characters", srcPath: "", name: "", desc: "" });
			// 追加在末尾：hook 顺序保持稳定，避免插在中间打乱已有索引
			// 产物区默认折叠（对齐 NiliX 的折叠条），需要时一键展开
			const [prodOpen, setProdOpen] = React.useState(false);
			const [presets, setPresets] = React.useState([]);
			// 工作区版式：故事板为主，参数侧栏可折叠
			const [shotFilter, setShotFilter] = React.useState("all");
			const [sideOpen, setSideOpen] = React.useState(true);
			const [detailShot, setDetailShot] = React.useState(null);
			const [qcRep, setQcRep] = React.useState({ total: 0, failed: 0, warned: 0, byFile: {} });
			const [sideTab, setSideTab] = React.useState("params");
			const [comfy, setComfy] = React.useState({ up: false, port: "", pids: [], vram: null });
			const [imgModels, setImgModels] = React.useState(null);
			const [renaming, setRenaming] = React.useState("");
			const [notice, setNotice] = React.useState("");
			const [menuFor, setMenuFor] = React.useState("");
			const [menuAt, setMenuAt] = React.useState({ x: 0, y: 0 });
			// 媒体预览灯箱：{ items: [{src,label,kind,note}], index }
			const [viewer, setViewer] = React.useState(null);
			// 自绘确认框：{ kind, id, title }（替代原生 confirm）
			const [confirm, setConfirm] = React.useState(null);

			// 手动刷新（故事板右上角那颗按钮）与日志查看器的状态。
			// 追加在末尾：hook 顺序保持稳定。
			const [refreshing, setRefreshing] = React.useState(false);
			const refreshingRef = React.useRef(false);
			const [logView, setLogView] = React.useState(null);
			// 日志倒序：默认开 —— 查日志的人 99% 是在问"刚刚发生了什么"。
			const [logReverse, setLogReverse] = React.useState(true);
			// 活日志面板保持自然追加顺序（它本来就是随跑随滚），但允许一键翻过来。
			const [liveReverse, setLiveReverse] = React.useState(false);
			// 「直接删除」上膛状态：点第一次只是上膛，第二次才真删。
			const [purgeArm, setPurgeArm] = React.useState(false);
			// 大屏播放：点成片/镜头卡就把它铺满宽度放上面看，不再只能弹小窗。
			// **必须加在状态清单末尾**：tools/sweep-blank.mjs 是按**索引**注入状态的
			// （a[29]=prodOpen、a[40]=menuFor…），插在中间会把后面所有索引整体错位，
			// 结果是 menuAt 注入成 null、读 menuAt.x 直接崩（45 个用例全红，实测踩过）。
			const [playerFor, setPlayerFor] = React.useState("");
			// 全局作业监视（不针对单项目）：任何管线在跑都要看得见实时日志，
			// 包括**命令行**发起的渲染 —— 驱动器每次命令都会更新 <项目根>/_active.json。
			const [act, setAct] = React.useState(null);
			const [actOpen, setActOpen] = React.useState(true);
			// 故事板排序：镜号顺序 / 倒序 / 按状态（把不合格顶到最前）
			const [shotSort, setShotSort] = React.useState("asc");

			const logRef = React.useRef(null);
			const saveTimer = React.useRef(null);
			const pidRef = React.useRef("");
			pidRef.current = pid;

			const jobId = job && job.jobId;
			const jobRunning = !!(job && job.running);

			// ── 加载 ──
			const loadBoot = React.useCallback(async () => {
				const r = await api("boot");
				if (r && r.error) setErr(r.error);
				else setBoot({ root: r.root || "", projects: r.projects || [] });
			}, []);

			const loadSys = React.useCallback(async () => {
				const r = await api("sysinfo", { id: pidRef.current });
				if (r && !r.error) setSys(r);
			}, []);

			const loadProd = React.useCallback(async (id) => {
				const r = await api("products", { id: id });
				if (r && !r.error) setProd(r);
			}, []);

			const loadScripts = React.useCallback(async (id) => {
				const r = await api("script.list", { id: id });
				if (r && !r.error) setScriptList(r.files || []);
			}, []);

			/**
			 * 项目卡上的短标签。风格句常是整句英文
			 * （"CHINESE 2D ANIME STYLE, CLEAN LINEWORK, VIBRANT CEL SHADING, DONGHUA QUALITY"），
			 * 直接塞进标签会把卡片撑到溢出 —— 取第一个逗号前的片段并限长。
			 */
			function shortLabel(s) {
				const t = String(s || "").trim();
				if (!t) return "未设定";
				const head = t.split(/[,;，；/]/)[0].trim();
				return head.length > 14 ? head.slice(0, 13) + "\u2026" : head;
			}

			/** 加速机制的中文说明（界面上要能一眼看出实际走哪条路）。 */
			function normAccel(a, nfe) {
				const s = String(a || "").toLowerCase();
				if (s === "pdd") {
					const n = Number(nfe) || 8;
					return "pdd" + ([4, 6, 8].indexOf(n) >= 0 ? n : 8);
				}
				return ["pdd8", "pdd6", "pdd4", "turbo4", "none"].indexOf(s) >= 0 ? s : "pdd8";
			}

			function accelLabel(a) {
				const m = {
					pdd8: "PDD 8 步（官方训练档）",
					pdd6: "PDD 6 步（非均匀分区）",
					pdd4: "PDD 4 步（两块并一步）",
					turbo4: "Turbo 4 步 + 配套采样器",
					none: "原模型（不做加速）",
				};
				return m[a] || m[String(a || "").replace(/\d+$/, "")] || "未设置";
			}

			/** 抽卡「选用」：把备选升为该镜定稿（原定稿退回成备选，可反悔）。 */
			const pickTake = async (name) => {
				setBusy("选用抽卡");
				const r = await api("shot.pick", { id: pid, src: name });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr("");
				await loadProd(pid);
				setNotice("已选用 " + name + "（原定稿退回为 " + (r && r.demoted) + "）");
			};

			const dropTakes = async (shot) => {
				setBusy("清理备选");
				const r = await api("shot.dropTakes", { id: pid, shot: shot });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr("");
				await loadProd(pid);
				setNotice(shot + " 清掉 " + ((r && r.removed) || []).length + " 张备选");
			};

			/**
			 * 打开媒体预览。`items` 传整批（同镜参考图 / 同屏资产 / 全部镜头），
			 * 这样灯箱里能直接翻页看下一张，而不是关掉再点。
			 */
			const openViewer = React.useCallback((items, index) => {
				const list = (items || []).filter((x) => x && x.src);
				if (list.length) setViewer({ items: list, index: Math.max(0, index || 0) });
			}, []);

			/** 某一类资产 → 灯箱条目（同屏资产整批传入，可翻页）。 */
			const assetItems = React.useCallback((kind) => {
				const arr = (prod && prod[kind]) || [];
				return arr.filter((a) => a && a.image).map((a) => ({
					src: mediaUrl(pid, a.image),
					label: a.name || a.id || "",
					note: a.desc || "",
				}));
			}, [prod, pid]);

			/** 资产 id → 在 assetItems 里的下标（名字与 id 都认）。 */
			const indexOfAsset = React.useCallback((kind, id) => {
				const arr = ((prod && prod[kind]) || []).filter((a) => a && a.image);
				for (let i = 0; i < arr.length; i++) {
					if (String(arr[i].id) === String(id)) return i;
				}
				return 0;
			}, [prod]);

			/**
			 * 故事板镜头卡的放大：`what` 为 refs 时给该镜的参考图，为 clip 时给视频。
			 * 整批传进去，灯箱里可以直接翻页看下一镜。
			 */
			const zoomShot = React.useCallback((row, what) => {
				const s = (row && row.shot) || {};
				if (what === "clip" && row && row.clip) {
					setViewer({
						items: [{ src: mediaUrl(pid, row.clip.name), label: row.id + " 渲染结果", kind: "video" }],
						index: 0,
					});
					return;
				}
				const items = [];
				const refs = (row && row.refs) || [];
				for (let i = 0; i < refs.length; i++) {
					if (refs[i] && refs[i].image) {
						items.push({ src: mediaUrl(pid, refs[i].image), label: row.id + " · " + (refs[i].name || refs[i].id || "参考图") });
					}
				}
				if (row && row.scene && row.scene.image) {
					items.push({ src: mediaUrl(pid, row.scene.image), label: row.id + " · " + (row.scene.name || "场景") });
				}
				if (items.length) setViewer({ items: items, index: 0 });
				else if (s.prompt) setDetailShot(row);
			}, [pid]);

			/** 打开单镜详情。**稳定引用**（useCallback），否则 ShotCard 的 memo 白做。 */
			const openShotDetail = React.useCallback((row) => { setDetailShot(row); }, []);

			/** 改标题：只动 project.json 的 title，不改目录名（改目录名会打断已有引用）。 */
			const doRename = async (id, title) => {
				setRenaming("");
				const t = String(title || "").trim();
				if (!t) return;
				const r = await api("rename", { id: id, title: t });
				if (r && r.error) { setErr(r.error); return; }
				setErr("");
				await loadBoot();
			};

			const doDuplicate = async (id) => {
				setBusy("复制项目");
				const r = await api("duplicate", { id: id });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr("");
				await loadBoot();
				setNotice("已复制为「" + r.id + "」");
			};

			/** 删除 = 移进 .trash，可恢复。所以这里问一次就够，不必做成两步确认。 */
			const doRemove = async (id, title) => {
				// 自绘确认而不是原生 confirm：原生弹窗在 Electron 里风格割裂，
				// 也没法把"可恢复"写清楚（用户看到"删除"会以为不可逆）。
				setPurgeArm(false);   // 每次打开都从"未上膛"开始
				setConfirm({ kind: "remove", id: id, title: title || id });
			};

			/** 确认后真正执行删除。 */
			const doRemoveConfirmed = async (id) => {
				setConfirm(null);
				setPurgeArm(false);
				setBusy("移入回收站");
				const r = await api("remove", { id: id });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr("");
				if (pid === id) setPid("");
				await loadBoot();
				setNotice("已移入回收站：" + id);
			};

			/**
			 * 永久删除（不进回收站）—— 由弹窗里"点两次"的按钮触发。
			 * 宿主侧还会再挡两道：只允许删根目录的直接子目录、有任务在跑就拒删。
			 */
			const doPurgeConfirmed = async (id) => {
				setConfirm(null);
				setPurgeArm(false);
				setBusy("永久删除项目");
				const r = await api("purge", { id: id });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr("");
				if (pid === id) setPid("");
				await loadBoot();
				setNotice("已永久删除：" + id
					+ (r && r.files ? "（" + r.files + " 个文件 / " + fmtMB(r.bytes) + "）" : ""));
			};

			/**
			 * 生成 / 重做项目封面。
			 *
			 * 封面是**独立一张图**（环境优先、人物只作远处剪影），不是主角定妆照 ——
			 * 定妆照是 Ref2VA 的身份锚点，正面半身 + 中性背景，拿它当门面等于把海报做成证件照。
			 */
			const doGenCover = async (id) => {
				setBusy("生成封面");
				const r = await api("cover.gen", { id: id, force: true });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr("");
				await loadBoot();
				if (pid === id) { await loadProd(id); await loadSys(); }
				setNotice((r && r.skipped) ? "已有封面，未重做" : "封面已生成：" + ((r && r.rel) || "cover.png"));
			};

			/** 目录浏览：宿主列目录，点到哪儿算哪儿。 */

			/** 扫描小说目录。 */


			/** 把某个文件导入为当前项目的正文。 */


			const loadComfy = React.useCallback(async () => {
				const r = await api("comfy.status", { id: pidRef.current });
				if (r && !r.error) setComfy(r);
			}, []);

			/** 启动 / 停止 / 重启 / 读模型清单。启动可能要等几分钟，所以给足超时。 */
			const comfyAction = async (what) => {
				if (what === "models") {
					setBusy("ComfyUI 读取模型清单");
					const r = await api("asset.models", { id: pid });
					setBusy("");
					if (r && r.ok) { setImgModels(r); setErr(""); }
					else setErr(String((r && r.error) || "读取失败"));
					return;
				}
				// 归还显存/内存：空转时 ComfyUI 会一直压着权重不放（实测 21.9 GB 显存
				// + 26 GB 内存，GPU 利用率只有 5%）。这条是给用户的"我现在就要它还回来"的出口。
				if (what === "free") {
					setBusy("ComfyUI 归还显存");
					const r = await api("comfy.free", { id: pid });
					await loadComfy();
					setBusy("");
					if (r && r.ok) {
						const b = (r.before && r.before.usedMB) || 0;
						const a2 = (r.after && r.after.usedMB) || 0;
						setErr("");
						setNotice("已归还显存：" + b + "MB → " + a2 + "MB");
					} else {
						setErr("释放失败：" + String((r && r.error) || "未知原因"));
					}
					return;
				}
				const label = what === "start" ? "ComfyUI 启动中" : what === "stop" ? "ComfyUI 停止中" : "ComfyUI 重启中";
				setBusy(label + "（启动要等模型索引，可能一两分钟）");
				const r = await api("comfy." + what, { id: pid });
				await loadComfy();
				setBusy("");
				if (what === "stop") {
					if (r && r.ok) setErr("");
					else setErr("停止未干净：" + JSON.stringify((r && r.leftPids) || []));
					return;
				}
				const started = what === "start" ? r : (r && r.started);
				if (started && started.ok) { setErr(""); return; }
				setErr("ComfyUI " + what + " 失败："
					+ String((started && started.error) || "未知原因")
					+ (started && started.tail ? "\n" + String(started.tail).slice(-400) : ""));
			};

			React.useEffect(() => {
				loadBoot();
				loadSys();
				loadComfy();
				// 大模型路由：供「方案」阶段选择。llm 是可选依赖，取不到就退回手填。
				api("llm.providers").then((r) => {
					if (r && !r.error && r.providers) setProviders(r.providers);
				});
				// 风格预设表（服务端持有唯一真源，前端不复制一份）
				api("style.presets").then((r) => {
					if (r && !r.error && r.presets) setPresets(r.presets);
				});
			}, [loadBoot, loadSys, loadComfy]);

			// 系统状态轮询：只在这个面板真的显示时才跑，避免空转 nvidia-smi
			React.useEffect(() => {
				const t = setInterval(loadSys, 3000);
				return () => clearInterval(t);
			}, [loadSys, pid]);

			// ── 全局作业监视（2.5 秒一刷，**不依赖 pid**）──
			// 用户诉求原话："只要管线渲染就需要显示实时日志啊，他不针对单项目"。
			// 所以数据源是全局活动记录，切项目、切视图都不会把它弄丢；
			// 命令行起的渲染（manju-headless.py）同样落在这条记录里。
			React.useEffect(() => {
				let alive = true;
				const tick = async () => {
					const r = await api("activity", {});
					if (!alive || !r || r.error) return;
					setAct(r);
					if (r.running) setActOpen(true);
				};
				tick();
				const t = setInterval(tick, 2500);
				return () => { alive = false; clearInterval(t); };
			}, []);

			// 管线轮询
			React.useEffect(() => {
				if (!jobId || !jobRunning) return undefined;
				let alive = true;
				const tick = async () => {
					const r = await api("pipelinePoll", { jobId: jobId });
					if (!alive || !r || r.error) return;
					setJob((prev) => Object.assign({}, prev, r));
					if (!r.running) {
						loadBoot();
						if (pidRef.current) {
							loadProd(pidRef.current);
							api("read", { id: pidRef.current }).then((rr) => {
								if (alive && rr && !rr.error) setProj(rr);
							});
							api("qc.report", { id: pidRef.current }).then((qq) => {
								if (alive && qq && !qq.error) setQcRep(qq);
							});
						}
					}
				};
				const t = setInterval(tick, 1500);
				tick();
				return () => { alive = false; clearInterval(t); };
			}, [jobId, jobRunning, loadBoot, loadProd]);

			// 日志自动滚动：倒序时新内容在最上面，要跟着吸顶；正序时吸底
			const lineCount = (job && job.lines && job.lines.length) || 0;
			React.useEffect(() => {
				const el = logRef.current;
				if (!el) return;
				el.scrollTop = liveReverse ? 0 : el.scrollHeight;
			}, [lineCount, liveReverse]);

			/**
			 * 故事板的行数据 —— **必须按内容记忆化**。
			 *
			 * 病史：不记忆化时，每 3 秒的系统状态轮询（loadSys → setSys）都会重渲染
			 * 整棵树，而 shotData() 每次都新建 rows 对象 → 所有镜头卡跟着重渲染，
			 * 观感就是「一闪一闪」。按**对象引用**记忆化只解决了一半：管线运行时
			 * 每 1.5 秒 `setJob(Object.assign({}, prev, r))` 会换掉 job 的引用、
			 * loadProd 会换掉 prod 的引用 —— 内容没变，依赖却变了，照样整板重算。
			 *
			 * 所以这里改成：先把"真正影响行内容"的字段压成一个字符串签名，
			 * 再拿签名当依赖。内容不变 → 行对象引用不变 → React.memo 的 ShotCard
			 * 连重渲染都不发生，封面自然不闪。
			 *
			 * **注意**：这个 hook 必须待在 Studio 的 hook 区（顺序稳定）——
			 * shotBoard() 是普通函数调用，把 hook 放进去会在切到 ComfyUI 视图时
			 * 因为少调用一次而破坏 hook 顺序。
			 */
			function strHash(s) {
				let x = 0;
				const str = String(s || "");
				for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) | 0;
				return x;
			}
			function rowSignature(p, pr, j, qc) {
				const shots = (p && ((p.plan && p.plan.shots) || (p.shotsDoc && p.shotsDoc.shots))) || [];
				const parts = [];
				for (let i = 0; i < shots.length; i++) {
					const s = shots[i] || {};
					parts.push([s.id || i, strHash(s.prompt || s.h3_prompt || ""), s.length || 0,
						(s.characters || []).join("|"), s.scene || ""].join(":"));
				}
				const clips = (pr && pr.clips) || [];
				const c2 = [];
				for (let i = 0; i < clips.length; i++) {
					const c = clips[i] || {};
					c2.push([c.name, c.size || 0, c.poster ? 1 : 0, c.final ? "f" : "", c.take || 0].join(":"));
				}
				const kinds = ["characters", "scenes", "props"];
				const as = [];
				for (let k = 0; k < kinds.length; k++) {
					const arr = (pr && pr[kinds[k]]) || [];
					for (let i = 0; i < arr.length; i++) as.push(String(arr[i].id) + ":" + String(arr[i].image || ""));
				}
				const byFile = (qc && qc.byFile) || {};
				const ks = Object.keys(byFile);
				const q = [];
				for (let i = 0; i < ks.length; i++) {
					const one = byFile[ks[i]] || {};
					q.push(ks[i] + ":" + (one.ok ? 1 : 0) + ":" + ((one.problems || []).length));
				}
				return [parts.join(","), c2.join(","), as.join(","), q.join(","),
					(qc && qc.checkedAt) || "", (j && j.progress && j.progress.label) || "",
					(j && j.running) ? "run" : "idle"].join("\u00a7");
			}
			const rowsSig = rowSignature(proj, prod, job, qcRep);
			const shotRows = React.useMemo(
				() => shotData(),
				[rowsSig],
			);

			/**
			 * 手动刷新 —— 故事板右上角那颗按钮。
			 *
			 * 三个讲究，缺一个体验就垮：
			 *   * **先取数据再整体替换**：不清空现有内容，列表不会先白一下再长回来；
			 *   * **最短旋转 450ms**：本地接口 20ms 就回来了，没有可视反馈用户会以为
			 *     没点到、于是连点 —— 那才是真的刷屏；
			 *   * 重入保护：刷新中再点直接忽略。
			 */
			const refreshAll = React.useCallback(async () => {
				if (refreshingRef.current) return;
				refreshingRef.current = true;
				setRefreshing(true);
				const t0 = Date.now();
				try {
					await loadBoot();
					const cur = pidRef.current;
					if (cur) {
						const r = await api("read", { id: cur });
						if (r && !r.error) setProj(r);
						await loadProd(cur);
						const qq = await api("qc.report", { id: cur });
						if (qq && !qq.error) setQcRep(qq);
						await loadScripts(cur);
					}
					await loadComfy();
					await loadSys();
					setErr("");
				} catch (e) {
					setErr("刷新失败：" + String((e && e.message) || e));
				} finally {
					const el = Date.now() - t0;
					if (el < 450) await new Promise((r) => setTimeout(r, 450 - el));
					refreshingRef.current = false;
					setRefreshing(false);
				}
			}, [loadBoot, loadProd, loadScripts, loadComfy, loadSys]);

			/**
			 * 日志查看器：把已落盘的渲染/管线日志翻出来。
			 * 活日志（job.lines）在管线面板里随跑随滚；这里查的是"跑完之后还在"的那份。
			 */
			const openLogs = async () => {
				const id = pidRef.current;
				if (!id) return;
				const r = await api("logs.list", { id: id });
				if (!r || r.error) { setErr(String((r && r.error) || "日志清单读取失败")); return; }
				const list = r.logs || [];
				let name = "";
				let text = "";
				if (list.length) {
					name = list[0].name;
					const one = await api("logs.read", { id: id, name: "output/logs/" + name });
					text = (one && one.text) || "";
				}
				setLogView({ list: list, name: name, text: text, pid: id });
			};
			const openLogFile = async (name) => {
				if (!logView) return;
				const one = await api("logs.read", { id: logView.pid, name: "output/logs/" + name });
				setLogView(Object.assign({}, logView, { name: name, text: (one && one.text) || "" }));
			};

			// 镜头范围预览
			const rShots = range.shots;
			const rEp = range.episode;
			const rCh = range.chapter;
			React.useEffect(() => {
				if (!pid) { setScope(null); return undefined; }
				let alive = true;
				const t = setTimeout(async () => {
					const r = await api("shots.preview", {
						id: pid, range: { shots: rShots, episode: rEp, chapter: rCh },
					});
					if (alive && r && !r.error) setScope(r);
				}, 320);
				return () => { alive = false; clearTimeout(t); };
			}, [pid, rShots, rEp, rCh, proj]);

			React.useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

			// ── 动作 ──
			const openProject = async (id) => {
				setBusy("读取项目");
				const r = await api("read", { id: id });
				if (r && r.error) { setErr(r.error); setBusy(""); return; }
				setErr("");
				setPid(id);
				setProj(r);
				setNovel(r.novel || "");
				setNovelDirty(false);
				setJob(null);
				const p = await api("params.get", { id: id });
				if (p && !p.error) setParams(p.params);
				const s = await api("script.read", { id: id });
				if (s && !s.error) { setScriptText(s.text || ""); setScriptRel(s.rel || "script/ep01.md"); }
				setScriptDirty(false);
				setScriptSrc("");
				setNovelSrc("");
				await loadProd(id);
				await loadScripts(id);
				const q = await api("qc.report", { id: id });
				if (q && !q.error) setQcRep(q);
				setBusy("");
			};

			function setParam(k, v) {
				const o = {};
				o[k] = v;
				patchParams(o);
			}

			/** 一次合并多个参数改动再落盘 —— 风格预设要同时改 styleHit 与 style，不能分两次存。 */
			function patchParams(patch) {
				const next = Object.assign({}, params, patch);
				setParams(next);
				if (!pid) return;
				if (saveTimer.current) clearTimeout(saveTimer.current);
				saveTimer.current = setTimeout(async () => {
					const r = await api("params.set", { id: pid, params: next });
					if (r && r.error) setErr(r.error);
				}, 700);
			}

			/** 风格预设可组合：点击切换，命中的片段拼成 style 句（前置到每镜提示词开头）。 */
			/**
			 * 只切换 styleHit —— 风格句由**宿主**拼（effectiveStyle）。
			 * 界面自己也拼一份写回 style 的话，预设会被拼两遍，而且两处真源必然漂移。
			 */
			/**
			 * 切换画风预设 —— **单选**。
			 *
			 * 这 10 个预设是互相冲突的「整体画风方向」（水墨国风 vs 赛博朋克、
			 * 3D 皮克斯 vs 国漫二维），拼在一起会给图像模型互相打架的指令。
			 * 所以点一个就只留一个，再点同一个则取消（回到"只写额外要求"）。
			 * 额外要求写在「画风」文本框里，宿主会把它拼在预设之后。
			 */
			function toggleStyle(key) {
				const P = params || {};
				const cur = Array.isArray(P.styleHit) ? P.styleHit : [];
				const only = cur.length === 1 && cur[0] === key;
				patchParams({ styleHit: only ? [] : [key] });
			}

			/** 只是给用户看的预览，与宿主的拼接规则一致。
			 * **必须走本地 P 兜底**：这个函数在"还没打开项目"时就会被调用
			 * （侧栏初始页签就是「参数」），而那时 params 可能仍是空的。
			 * 直接读模块作用域的 params.styleHit 会抛 null 解引用，整块面板渲染失败。 */
			function stylePreview() {
				const P = params || {};
				const hit = Array.isArray(P.styleHit) ? P.styleHit : [];
				const parts = [];
				for (let i = 0; i < hit.length; i++) {
					for (let j = 0; j < presets.length; j++) {
						if (presets[j].key === hit[i]) parts.push(presets[j].prompt);
					}
				}
				const free = String(P.style || "").trim();
				return (parts.join(" + ") + (parts.length && free ? "; " : "") + free).trim();
			}

			const saveNovel = async () => {
				if (!pid) return;
				setBusy("保存正文");
				const r = await api("saveNovel", { id: pid, text: novel });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr(""); setNovelDirty(false); loadBoot();
			};

			const importNovel = async () => {
				if (!pid || !novelSrc.trim()) return;
				setBusy("导入小说");
				const r = await api("novel.import", { id: pid, srcPath: novelSrc.trim() });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr(""); setNovel(r.text || ""); setNovelDirty(false); setNovelSrc(""); loadBoot();
			};

			const saveScript = async () => {
				if (!pid) return;
				setBusy("保存脚本");
				const r = await api("script.write", { id: pid, rel: scriptRel, text: scriptText });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr(""); setScriptDirty(false); loadScripts(pid); loadBoot();
			};

			const importScript = async () => {
				if (!pid || !scriptSrc.trim()) return;
				setBusy("导入脚本");
				const r = await api("script.import", { id: pid, rel: scriptRel, srcPath: scriptSrc.trim() });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr(""); setScriptText(r.text || ""); setScriptDirty(false);
				setScriptSrc(""); loadScripts(pid); loadBoot();
			};

			const clearScript = async () => {
				if (!pid) return;
				setBusy("清除脚本");
				const r = await api("script.write", { id: pid, rel: scriptRel, text: "" });
				setBusy("");
				if (r && r.error) { setErr(r.error); return; }
				setErr(""); setScriptText(""); setSource("novel");
			};

			const startPipeline = async (opts) => {
				if (!pid) { setErr("请先在左侧打开一个项目"); return; }
				setErr("");
				setLogOpen(true);
				const body = Object.assign({ id: pid, range: range }, opts);
				const r = await api("pipelineStart", body);
				if (r && r.error) { setErr(r.error); return; }
				setJob({
					jobId: r.jobId, running: true, exitCode: null, lines: [],
					progress: { index: 0, total: 0 },
					stages: STAGE_DEF.map((s) => ({ key: s[0], name: s[1], state: "pending", note: "" })),
				});
				setView("video");
			};

			const stopPipeline = async () => {
				if (!jobId) return;
				await api("pipelineStop", { jobId: jobId });
			};

			/** 节点预检：缺 H3 根节点就当场点名，而不是等渲染跑到一半才炸 node_errors。 */
			const doPreflight = async () => {
				setBusy("节点预检");
				const r = await api("render.preflight", { id: pid });
				setBusy("");
				const miss = (r && r.missing) || [];
				if (r && r.ok) {
					setErr("");
					setEnvText("节点预检通过：H3 的 15 个根节点齐备。");
				} else {
					setEnvText(String((r && r.text) || ""));
					setErr(miss.length
						? ("缺 H3 节点：" + miss.join(", ") + " —— 请先在 ComfyUI 装齐再渲染")
						: "节点预检未通过，详见 ComfyUI 体检输出");
				}
			};

			const doEnv = async () => {
				setBusy("环境体检");
				const r = await api("envCheck");
				setBusy("");
				setEnvText(String((r && r.text) || (r && r.error) || ""));
				if (r && !r.ok) setErr("环境体检未通过");
			};

			const doAssemble = async () => {
				if (!pid) return;
				setBusy("拼接成片");
				const r = await api("assemble", { id: pid });
				setBusy("");
				setEnvText(String((r && r.text) || ""));
				if (r && r.error) setErr(r.error);
				loadProd(pid); loadBoot();
			};

			const createProject = async () => {
				const r = await api("create", newP);
				if (r && r.error) { setErr(r.error); return; }
				setErr("");
				setShowNew(false);
				const id = r.id;
				setNewP({ id: "", title: "", genre: "", style: "" });
				await loadBoot();
				await openProject(id);
			};

			const addCast = async () => {
				if (!pid) return;
				const r = await api("addAsset", {
					id: pid, kind: castForm.kind, name: castForm.name,
					desc: castForm.desc, srcPath: castForm.srcPath,
				});
				if (r && r.error) { setErr(r.error); return; }
				setErr("");
				setCastForm(Object.assign({}, castForm, { srcPath: "", name: "", desc: "" }));
				loadProd(pid); loadBoot();
			};

			const delCast = (kind, aid) => async () => {
				const r = await api("removeAsset", { id: pid, kind: kind, assetId: aid });
				if (r && r.error) { setErr(r.error); return; }
				loadProd(pid); loadBoot();
			};

			const doQc = () => startPipeline({ only: ["judge"] });

			/**
			 * 重渲单镜。
			 *
			 * **必须 useCallback**：它是 ShotCard 的 prop，普通函数每次渲染都是新引用，
			 * 会让 ShotCard 的 React.memo 完全失效 —— 于是每 3 秒的系统状态轮询
			 * 都会把 7 张镜头卡连同卡里的 <video> 全部重渲染，观感就是"封面一闪一闪"。
			 * 实测（flicker-test）就是靠 props 浅比较抓到这个 prop 的。
			 */
			const rerenderShot = React.useCallback(async (sid) => {
				if (!pidRef.current) return;
				setErr(""); setLogOpen(true);
				const r = await api("shot.rerender", { id: pidRef.current, shotId: sid });
				if (r && r.error) { setErr(r.error); return; }
				setJob({
					jobId: r.jobId, running: true, exitCode: null, lines: [],
					progress: { index: 0, total: 0 },
					stages: STAGE_DEF.map((s) => ({ key: s[0], name: s[1], state: "pending", note: "" })),
				});
			}, []);

			// ── 渲染：成品列表列 ──
			/**
			 * 成品列表 = **紧凑行**，不是大封面卡。
			 *
			 * 换掉旧版的原因（旧版一张卡 ~330px，整个列表只看得到 2 个项目）：
			 *   * 封面是一大块空渐变，标题压在上面**对比度极低**
			 *   * 标签 pill 会换行成两三排，再吃掉一条高度
			 *   * ⋯ 菜单浮在卡内，**盖住标题与进度**
			 *   * 没封面时只显示"无封面"三个字，等于白占一块
			 * 现在：56×32 缩略图 + 标题/元信息并排 + 行底进度条，约 52px 一行。
			 */
			function colProjects() {
				const ps = boot.projects || [];
				return h("div", { className: "mj-col mj-c1", key: "c1" },
					h(Pane, { title: "成品列表", grow: true,
						right: h("div", { className: "mj-row", style: { gap: 4, flex: "0 0 auto" } },
							h("span", { className: "mj-tag", title: ps.length + " 个项目" }, ps.length + " 部"),
							h("button", {
								className: "mj-refresh ic" + (refreshing ? " busy" : ""),
								disabled: refreshing || !!busy,
								title: "刷新项目列表（不清空当前画面）",
								onClick: refreshAll,
							}, h("span", { className: "mj-refi" }, "\u21bb"))) },
						h("div", { className: "mj-plist" },
							ps.length
								? ps.map((p) => {
									const total = Number(p.shotCount) || 0;
									const doneN = Math.min(Number(p.clipCount) || 0, total || Number(p.clipCount) || 0);
									const pct = total ? Math.round((doneN / total) * 100) : (doneN ? 100 : 0);
									return h("div", {
										key: p.id,
										className: "mj-prow" + (p.id === pid ? " on" : ""),
										title: p.title || p.id,
										onClick: () => { if (renaming !== p.id) { setMenuFor(""); openProject(p.id) } },
									},
										p.cover
											? h("img", {
												className: "mj-pthumb mj-zoomable", tabIndex: 0, role: "button", onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (e.currentTarget.click) e.currentTarget.click(); } },  src: mediaUrl(p.id, p.cover),
												alt: "", loading: "lazy", decoding: "async", title: "点击放大看封面",
												onClick: (e) => {
													e.stopPropagation();
													openViewer([{ src: mediaUrl(p.id, p.cover), label: (p.title || p.id) + " 封面" }], 0);
												},
											})
											: h("div", { className: "mj-pthumb mj-pthumb-ph" },
												String(p.title || p.id).slice(0, 1)),
										h("div", { className: "mj-pinfo" },
											renaming === p.id
												? h("input", {
													className: "mj-prename", defaultValue: p.title, autoFocus: true,
													onClick: (e) => e.stopPropagation(),
													onKeyDown: (e) => {
														if (e.key === "Enter") doRename(p.id, e.target.value);
														else if (e.key === "Escape") setRenaming("");
													},
													onBlur: (e) => doRename(p.id, e.target.value),
												})
												: h("div", { className: "mj-ptitle" }, p.title || p.id),
											// 元信息要能回答"这是哪一部、做到哪了"：
											// 题材 · 集数 · 已渲/总镜 · 成片数（缺一项都认不出项目）
											h("div", { className: "mj-pmeta", title: (p.style || p.genre || "") + " / " + p.id },
												[
													shortLabel(p.genre || p.style),
													Number(p.episodeCount) ? Number(p.episodeCount) + " 集" : "",
													doneN + "/" + total + " 镜",
													Number(p.finalCount) ? "成片 " + p.finalCount : "",
												].filter(Boolean).join(" · ")),
											h("div", { className: "mj-pbar" + (pct >= 100 && total ? " done" : "") },
												h("i", { style: { width: pct + "%" } }))),
										// ✓ 已经并入元信息行的「成片 N」，这里不再占一行宽度
										// （每多一个 flex 子项就从标题上抢走 ~20px，标题就短到认不出）
										null,
										h("button", {
											className: "mj-dots" + (menuFor === p.id ? " on" : ""),
											title: "更多操作",
											onClick: (e) => {
												e.stopPropagation();
												// 菜单用 **fixed 定位浮在行外**：列表是 overflow:auto，
												// 菜单若长在行内会被裁掉、也会盖住标题。
												// 位置要做**边界钳制** —— 否则靠近视口底部/右侧的行
												// 会把菜单推到屏幕外，看不到也点不着。
												const W = (typeof window !== "undefined" && window.innerWidth) || 1200;
												const H = (typeof window !== "undefined" && window.innerHeight) || 800;
												const r = e.currentTarget.getBoundingClientRect
													? e.currentTarget.getBoundingClientRect()
													: { right: 8, bottom: 8 };
												setMenuAt({
													x: Math.min(Math.max(8, (r.right || 8) - 132), W - 148),
													y: Math.min((r.bottom || 8) + 4, H - 132),
												});
												setMenuFor(menuFor === p.id ? "" : p.id);
											},
										}, "\u22ef"));
								})
								: h("div", { className: "mj-empty" },
									h("span", null, "\u25a2"),
									"还没有作品",
									h("button", {
										className: "mj-btn pri", style: { marginTop: 4 },
										onClick: () => setShowNew(true),
									}, "\uff0b 新建项目"))),
						// 菜单放在列表**外面**并固定定位，这样滚动与 overflow 都裁不到它
						menuFor
							? h("div", {
								className: "mj-menu mj-menu-fixed",
								style: { left: (menuAt.x || 8) + "px", top: (menuAt.y || 8) + "px" },
								onClick: (e) => e.stopPropagation(),
							},
								h("button", {
									className: "mj-mi",
									onClick: () => { setMenuFor(""); setRenaming(menuFor) },
								}, "改名"),
								h("button", {
									className: "mj-mi",
									onClick: () => { const id = menuFor; setMenuFor(""); doDuplicate(id) },
								}, "复制"),
								// 封面是成品列表的门面：**独立生成，不拿主角定妆照顶替**。
								// 已有封面时这一项变成"重做封面"。
								h("button", {
									className: "mj-mi",
									title: "按标题/题材/简介生成一张独立封面（环境优先、人物只作远处剪影）",
									onClick: () => { const id = menuFor; setMenuFor(""); doGenCover(id); },
								}, (ps.filter((x) => x.id === menuFor)[0] || {}).cover ? "重做封面" : "生成封面"),
								h("button", {
									className: "mj-mi danger",
									onClick: () => {
										const id = menuFor;
										const p = ps.filter((x) => x.id === id)[0] || {};
										setMenuFor("");
										doRemove(id, p.title);
									},
								}, "移入回收站"))
							: null,
						menuFor ? h("div", { className: "mj-menu-backdrop", onClick: () => setMenuFor("") }) : null,
						h("button", {
							className: "mj-btn pri wide",
							onClick: () => setShowNew(true),
						}, "\uff0b 新建项目")));
			}

			// ── 渲染：项目 + 参数 ──
			function colParams() {
				const P = params || {};
				const curProvider = () => {
					const want = P.provider || "";
					for (let i = 0; i < providers.length; i++) {
						if (providers[i].id === want) return providers[i];
					}
					// 参数里还没落盘 provider 时，回退到第一个可用路由，避免下拉显示空白
					return providers.length ? providers[0] : null;
				};
				const curModels = () => {
					const c = curProvider();
					return c ? (c.models || []) : [];
				};
				const num = (k, w, tip) => h("input", {
					className: "mj-in", style: { width: w || 62 }, type: "number", title: tip || "", value: P[k] === undefined ? "" : P[k],
					onChange: (e) => setParam(k, e.target.value === "" ? "" : Number(e.target.value)),
				});
				const txt = (k, ph, w) => h("input", {
					className: "mj-in", style: w ? { width: w } : undefined, value: P[k] === undefined ? "" : P[k],
					placeholder: ph || "", onChange: (e) => setParam(k, e.target.value),
				});

				return h("div", { className: "mj-col", key: "c2" },
					h(Pane, { title: "参数", grow: true,
						right: pid ? h("span", { className: "mj-tag" }, pid) : null },
						h("div", { className: "mj-lab sec" }, "参数"),
						!pid
							? h("div", { className: "mj-mut" }, "打开项目后可配置参数。")
							: h("div", { className: "mj-params" }, [
								h(KV, { key: "style", label: "画风" }, txt("style", "额外画面要求，如：深夜雨戏，冷暖对比…")),
								// 预设是**整体画风方向**，互相冲突（水墨 vs 赛博朋克），所以是**单选**。
								// 之前做成开关式多选而且没说明，用户看到"一堆标签只有一个亮的"很正常。
								h("div", { className: "mj-lab sec" }, "整体画风（单选）"),
								presets.length
									? h("div", { className: "mj-chips", style: { marginTop: -2 } },
										presets.map((pv) => {
											const on = Array.isArray(P.styleHit) && P.styleHit.indexOf(pv.key) >= 0;
											return h("span", {
												key: pv.key,
												className: "mj-chip" + (on ? " running" : ""),
												style: { cursor: "pointer" },
												title: pv.name + " —— 选中后这一整句会加到每一镜提示词的最前面：\n" + pv.prompt,
												role: "button", tabIndex: 0,
												onClick: () => toggleStyle(pv.key),
												onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleStyle(pv.key); } },
											}, h("span", { className: "d" }), pv.name);
										}))
									: h("div", { className: "mj-mut", style: { fontSize: 12 } }, "（没读到风格预设，可直接在「画风」里手写）"),
								h("div", { className: "mj-mut", style: { fontSize: 12 } },
									"这些是整体画风方向，**只能选一个**（水墨和赛博朋克放在一起会互相打架）。"
									+ "点已选中的那个可以取消。额外要求写在上面「画风」里。"),
								// 把"生效的是什么、用在哪里"摆明 —— 以前只有一行 12px 的灰字，说了等于没说
								h("div", { className: "mj-stybox" },
									h("div", { className: "mj-styhead" },
										"每一镜提示词开头会加上：",
										h("span", { className: "mj-sp" }),
										h("span", {
											className: "mj-tag" + (stylePreview() ? " ok" : ""),
										}, stylePreview() ? "已生效" : "未设置")),
									h("div", { className: "mj-styval" }, stylePreview() || "（还没有选画风，也没写额外要求）"),
									h("div", { className: "mj-styfoot" },
										"作用范围：方案阶段生成的每一镜 h3_prompt 的最前面。"
										+ "已渲染的镜头不会自动变 —— 改了画风要重跑方案才会用上。")),
								h(KV, { key: "llm", label: "模型" },
									providers.length
										? h("select", {
											className: "mj-in", style: { flex: "0 0 96px" },
											value: (curProvider() || {}).id || "", title: "大模型服务商（方案阶段用）",
											onChange: (e) => setParam("provider", e.target.value),
										}, providers.map((pv) => h("option", { key: pv.id, value: pv.id }, pv.name || pv.id)))
										: txt("provider", "deepseek", 96),
									curModels().length
										? h("select", {
											className: "mj-in", value: P.llm || curModels()[0],
											onChange: (e) => setParam("llm", e.target.value),
										}, curModels().map((m) => h("option", { key: m, value: m }, m)))
										: txt("llm", "deepseek-chat")),
								h(KV, { key: "comfy", label: "ComfyUI" }, txt("comfyUrl", "http://127.0.0.1:8199")),
								h(KV, { key: "res", label: "画质" },
									num("width", 68, "画面宽（短边保持 768 对应的长边）"), h("span", { className: "mj-mut" }, "\u00d7"),
									num("height", 68, "画面高（短边 768 为 H3 原生分辨率）"),
									h("span", { className: "mj-mut", title: "帧率 fps" }, "@"), num("fps", 52, "帧率 fps")),

								h(KV, { key: "steps", label: "步数" },
									num("steps", 60, "采样步数（配 Acc-8Step LoRA 用 8）"),
									num("seed", 100, "随机种子 seed；固定它便于复现与对比"),
									h("button", {
										className: "mj-btn", title: "随机 seed",
										onClick: () => setParam("seed", Math.floor(Math.random() * 99999999)),
									}, "随机")),
								h(KV, { key: "crf", label: "质量" },
									num("crf", 60, "编码 CRF：数值越小越清晰、文件越大。crf 23 会明显发糊，实测 16 是清晰档"),
									h("span", { className: "mj-mut", style: { fontSize: 12 } }, "CRF（越小越清晰）")),
							])));

			}

			// ── 渲染：渲染配置（侧栏独立一页；与参数分开，两页各自都装得下）──
			function colRender() {
				const P = params || {};
				return h(Pane, { title: "渲染配置", grow: true,
					right: h("button", {
						className: "mj-btn", disabled: !pid, onClick: () => setShowCast(true),
					}, "角色管理") },
					h("div", { className: "mj-lab sec", key: "cfglab" }, "渲染范围"),
					h("div", { className: "mj-opthelp", style: { paddingLeft: 0, marginTop: -4 } },
						"只影响", h("b", null, "本次执行"), "要跑哪些镜头 —— 不会改动分镜本身。"
						+ "留空即全本；也可以按章/集筛，或直接写镜头号（如 ", h("span", { className: "mj-mono" }, "1,3-5"), "）。"),
					h("div", { className: "mj-row", key: "cfgren" },
						h("span", { className: "mj-lab", style: { flex: "0 0 42px" } }, "章节"),
							h("input", {
								className: "mj-in", style: { width: 62 }, value: range.chapter, placeholder: "如 1",
								onChange: (e) => setRange(Object.assign({}, range, { chapter: e.target.value })),
							}),
							h("span", { className: "mj-lab", style: { flex: "0 0 34px" } }, "集数"),
							h("input", {
								className: "mj-in", style: { width: 62 }, value: range.episode, placeholder: "如 1",
								onChange: (e) => setRange(Object.assign({}, range, { episode: e.target.value })),
							}),
							h("button", {
								className: "mj-btn",
								onClick: () => setRange({ chapter: "", episode: "", shots: "" }),
							}, "全本")),
						h("div", { className: "mj-row" },
							h("span", { className: "mj-lab", style: { flex: "0 0 42px" } }, "镜头"),
							h("input", {
								className: "mj-in", value: range.shots, placeholder: "可选，如 1,3-5 或镜头 id",
								onChange: (e) => setRange(Object.assign({}, range, { shots: e.target.value })),
							})),
						h("div", { className: "mj-row" },
							h("span", { className: "mj-lab", style: { flex: "0 0 42px" } }, "转场"),
							h("select", {
								className: "mj-in", style: { flex: "0 0 78px" }, value: P.transition || "cut",
								title: "硬切 / 闪黑叠化。像素溶解的颗粒噪点观感已被否决，选它会被降级为闪黑叠化。",
								onChange: (e) => setParam("transition", e.target.value),
							},
								h("option", { value: "cut" }, "硬切"),
								h("option", { value: "fade" }, "闪黑叠化")),
							h("span", { className: "mj-lab", style: { flex: "0 0 auto" } }, "响度"),
							h("input", {
								className: "mj-in", style: { width: 56 }, type: "number",
								title: "loudnorm 目标响度 LUFS；-16 适合网络平台，各镜音量不再忽大忽小",
								value: P.loudness === undefined ? "" : P.loudness,
								onChange: (e) => setParam("loudness", e.target.value === "" ? "" : Number(e.target.value)),
							}),
							h("span", { className: "mj-mut", style: { fontSize: 12 } }, "LUFS")),
					h("div", { className: "mj-opthelp", style: { paddingLeft: 0 } },
						"硬切最不容易出错；闪黑叠化更柔但会吃掉约 12 帧。响度 ", h("b", null, "-16 LUFS"),
						" 适合网络平台 —— 开了它各镜音量才一致，否则会出现忽大忽小。"),
						h("div", { className: "mj-row", style: { flexWrap: "nowrap" } },
							h("span", { className: "mj-lab", style: { flex: "0 0 42px" } }, "采样"),
							h("select", {
								className: "mj-in", style: { flex: "1 1 auto" }, value: P.sampler || "euler",
								title: "euler = H3 官方默认（50 点基准）。res_multistep 是二阶指数积分器，"
									+ "官方标定约 21 点即可达到 50 步 euler 的质量、去噪算量降到约 1/2.5 —— "
									+ "但那是按整套权重标定的，叠了 8 步蒸馏 LoRA 时步数本就很低，切换请自行对比验证。",
								onChange: (e) => setParam("sampler", e.target.value),
							},
								h("option", { value: "euler" }, "euler（官方默认）"),
								h("option", { value: "res_multistep" }, "res_multistep（二阶·省算量）")),
							h("select", {
								className: "mj-in", style: { flex: "0 0 84px" }, value: P.refImageSize || "match",
								title: "参考图尺寸。match = 缩到本次生成像素面积（默认）；"
									+ "max = 参考管线 2048 短边，身份保真最好，但参考 token 会参与每个采样步，可能慢数倍。",
								onChange: (e) => setParam("refImageSize", e.target.value),
							},
								h("option", { value: "match" }, "参考match"),
								h("option", { value: "max" }, "参考max"))),
						h("div", { className: "mj-row", style: { flexWrap: "nowrap" } },
							h("span", {
								className: "mj-lab", style: { flex: "0 0 42px" },
								title: "双 sigma 整流流调度：video shift 驱动采样器的 sigma 排程，"
									+ "audio shift 由 ModelSamplingAV 据此内部推导 —— 两者必须配套，单独改一个会破坏音画对齐。",
							}, "shift"),
							h("input", {
								className: "mj-in", style: { width: 58 }, type: "number", step: "0.1",
								title: "视频 flow shift（官方默认 12.0）。调高→大结构/运动更稳；调低→细节纹理更多。",
								value: P.shiftVideo === undefined ? "" : P.shiftVideo,
								onChange: (e) => setParam("shiftVideo", e.target.value === "" ? "" : Number(e.target.value)),
							}),
							h("span", { className: "mj-mut", style: { fontSize: 12 } }, "/"),
							h("input", {
								className: "mj-in", style: { width: 58 }, type: "number", step: "0.1",
								title: "音频 flow shift（官方默认 3.0）。从视频排程推导，必须与视频 shift 一起改。",
								value: P.shiftAudio === undefined ? "" : P.shiftAudio,
								onChange: (e) => setParam("shiftAudio", e.target.value === "" ? "" : Number(e.target.value)),
							}),
							h("span", { className: "mj-mut", style: { fontSize: 12 } }, "音画配套改")),
						h("div", { className: "mj-row", style: { flexWrap: "nowrap" } },
							h("span", { className: "mj-lab", style: { flex: "0 0 42px" } }, "字幕"),
							h("button", {
								className: "mj-btn" + (P.subtitles === false ? "" : " go"),
								title: "合成时把台词烧进画面。折行位置按画布宽度算（标点优先），最多三行，不会顶出画面。",
								onClick: () => setParam("subtitles", P.subtitles === false),
							}, P.subtitles === false ? "关" : "开"),
							h("span", { className: "mj-lab", style: { flex: "0 0 auto" } }, "字号"),
							h("input", {
								className: "mj-in", style: { width: 52 }, type: "number", step: "0.5",
								title: "字号 = 画布高度 × 此百分比。768p 下 5% ≈ 38px；一般 4–6 之间。",
								value: P.subtitleSize === undefined ? 5 : P.subtitleSize,
								onChange: (e) => setParam("subtitleSize", e.target.value === "" ? 5 : Number(e.target.value)),
							}),
							h("span", { className: "mj-mut", style: { fontSize: 12 } }, "% 画高")),
												h("div", { className: "mj-mono " + (scope && scope.picked === 0 ? "mj-err" : "mj-mut"),
							title: "章节 / 集数按镜头里的 chapter、episode 字段过滤；项目若没有这些字段，填了也等于全本。",
						},
							scope
								? ("将渲染 " + scope.picked + " / " + scope.total + " 镜 · " + scope.by
									+ (scope.picked === 0 && scope.filtered ? "（筛选后没有镜头，请检查条件）" : ""))
								: "—"));
			}

			// ── 渲染：内容（第一步 —— 建项目、放正文）──
			function colContent() {
				return h("div", { className: "mj-col", key: "ct" },
					h(Pane, { title: "项目",
						right: pid ? h("span", { className: "mj-tag" }, pid) : null },
						h("div", { className: "mj-row", style: { flexWrap: "nowrap" } },
							h("button", {
								className: "mj-btn" + (pid ? " pri" : ""),
								style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
								disabled: !pid, onClick: () => pid && openProject(pid),
							}, pid ? ("\u25cf " + ((proj && proj.meta && proj.meta.title) || pid)) : "未打开项目"),
							h("button", {
								className: "mj-btn pri", style: { flex: "0 0 auto" },
								onClick: () => setShowNew(true),
							}, "\uff0b 新建项目")),
						h("div", { className: "mj-mut", style: { fontSize: 12.5 } },
							"流程：这里建好项目并放进正文 → 「参数」「渲染」配置 → 「管线」生成资产并渲染分镜 → 合成成片。")),
					colSource());
			}


			function colSource() {
				const isScript = source === "script";
				const text = isScript ? scriptText : novel;
				const chars = text ? text.length : 0;
				const dirty = isScript ? scriptDirty : novelDirty;
				const head = text ? text.slice(0, 600) : "";

				return h(Pane, { title: "内容来源", grow: true,
					right: h("span", { className: "mj-tag" + (dirty ? " warn" : "") }, dirty ? "未保存" : "已同步") },
					h("div", { className: "mj-row", style: { gap: 14 } },
						h("span", {
							className: "mj-radio" + (!isScript ? " on" : ""),
							onClick: () => setSource("novel"),
						}, h("span", { className: "b" }), "小说解析"),
						h("span", {
							className: "mj-radio" + (isScript ? " on" : ""),
							onClick: () => setSource("script"),
						}, h("span", { className: "b" }), "视频脚本直出")),
					h("div", { className: "mj-mut", style: { fontSize: 12.5 } },
						"小说解析走 novel.md；脚本直出走 script/ 下的分镜剧本。两种输入二选一。"),

					h("div", { className: "mj-row" },
						h("span", { className: "mj-lab", style: { flex: "0 0 auto" } }, "输入方式"),
						h("button", {
							className: "mj-btn pri", disabled: !pid,
							onClick: isScript ? importScript : importNovel,
						}, isScript ? "更换脚本" : "导入小说"),
						h("button", {
							className: "mj-btn", disabled: !pid,
							onClick: isScript ? clearScript : () => setNovel(""),
						}, isScript ? "清除脚本(回小说)" : "清空正文")),

					isScript
						? h("input", {
							className: "mj-in", value: scriptSrc, placeholder: "脚本源文件绝对路径，如 D:\\Ai\\素材\\ep01.md",
							onChange: (e) => setScriptSrc(e.target.value),
						})
						: h("input", {
							className: "mj-in", value: novelSrc, placeholder: "小说源文件绝对路径（.txt / .md，自动按 UTF-8 读）",
							onChange: (e) => setNovelSrc(e.target.value),
						}),

					isScript && scriptList.length > 1
						? h("div", { className: "mj-row" },
							h("span", { className: "mj-lab", style: { flex: "0 0 auto" } }, "脚本文件"),
							scriptList.map((f) => h("button", {
								key: f.rel,
								className: "mj-btn" + (f.rel === scriptRel ? " pri" : ""),
								onClick: async () => {
									setScriptRel(f.rel);
									const r = await api("script.read", { id: pid, rel: f.rel });
									if (r && !r.error) { setScriptText(r.text || ""); setScriptDirty(false); }
								},
							}, f.name)))
						: null,

					h("div", { className: "mj-mono mj-mut", style: { fontSize: 12.5 } },
						(isScript ? "脚本直出源: " + scriptRel : "小说源: novel.md")
						+ "（" + chars + " 字）"),

					h("div", { className: "mj-pre mj-clamp", title: "完整正文请在「小说管理」查看" },
						head || "（空）"),
					h("div", { className: "mj-row" },
						h("button", {
							className: "mj-btn", disabled: !pid,
							onClick: isScript ? saveScript : saveNovel,
						}, isScript ? "保存脚本" : "保存正文"),
						h("button", {
							className: "mj-btn", disabled: !pid, onClick: () => setView("video"),
						}, "展开编辑")));
			}

			// ── 渲染：执行管线 ──
						// ── 渲染：引擎（加速 / VAE / 显存 / 抽卡 / 合规）──
			// 拆分理由：这些是"用什么引擎渲"，与"这一镜怎么渲"（范围/转场/响度/采样）
			// 不是一类；混在一页会让渲染面板滚动到藏起近一半内容。
			function colEngine() {
				const P = params || {};
				const acc = normAccel(P.accel, P.nfe);
				const takes = P.takes === undefined ? 1 : P.takes;
				return h("div", { className: "mj-col", key: "ce" },
					h(Pane, { title: "渲染引擎", grow: true,
						right: pid ? h("span", { className: "mj-tag" }, pid) : null },

						h("div", { className: "mj-lab sec" }, "速度与保真"),
						h(Opt, {
							label: "加速",
							help: h("span", null,
								h("b", null, "步数由机制决定，不能自由填"),
								" —— 各机制的安全步数不同（注入式 6–8 / 后训练蒸馏 3–4），"
								+ "填错会喂给模型没训过的评估点、直接出重噪声。"),
						},
							h("select", {
								className: "mj-in", style: { flex: "1 1 auto" }, value: acc,
								onChange: (e) => setParam("accel", e.target.value),
							},
								h("option", { value: "pdd8" }, "PDD 8 步 · 官方训练档（推荐）"),
								h("option", { value: "pdd6" }, "PDD 6 步 · 非均匀 8,8,4,4,4,4"),
								h("option", { value: "pdd4" }, "PDD 4 步 · 两块并一步（最快）"),
								h("option", { value: "turbo4" }, "Turbo 4 步 · 社区 LoRA"),
								h("option", { value: "none" }, "不加速 · 原模型（最慢最保真）"))),
						h(Opt, {
							label: "VAE",
							help: h("span", null,
								"int8 视频 VAE 解码实测约 ", h("b", null, "-35%"),
								"（137.74s → 88.99s）。换模型即生效，不改变任何采样行为；"
								+ "关掉回 fp16 只在怀疑画质差异时用来对照。"),
						},
							h("div", { className: "mj-segs" },
								h("button", {
									className: "mj-sg" + (P.vaeInt8 === false ? "" : " on"),
									onClick: () => setParam("vaeInt8", true),
								}, "int8"),
								h("button", {
									className: "mj-sg" + (P.vaeInt8 === false ? " on" : ""),
									onClick: () => setParam("vaeInt8", false),
								}, "fp16"))),

						h("div", { className: "mj-lab sec" }, "显存"),
						h(Opt, {
							label: "优化",
							help: h("span", null,
								"两个节点都声明「输出与未打补丁的模型一致」，属纯内存布局优化；"
								+ "显存够用就别开，少一层补丁。",
								h("br", null),
								h("span", { className: "warn" }, "刻意不提供 SageAttention"),
								" —— 本机底模是 int8，它承载不了 H3 的 QK-RMSNorm + rope："
								+ "Sage2 出纯噪声、Sage1 丢高频。"),
						},
							h("select", {
								className: "mj-in", style: { flex: "1 1 auto" }, value: P.vramMode || "off",
								onChange: (e) => setParam("vramMode", e.target.value),
							},
								h("option", { value: "off" }, "关闭（默认，最短路径）"),
								h("option", { value: "lowattn" }, "LowVRAM Attention · head 分组切片"),
								h("option", { value: "chunkff" }, "Chunk FeedForward · SwiGLU 分块"),
								h("option", { value: "both" }, "两个都开"))),

						h("div", { className: "mj-lab sec" }, "抽卡与合规"),
						h(Opt, {
							label: "抽卡",
							help: h("span", null,
								"一镜渲几个 seed 供挑选。第 1 张是", h("b", null, "定稿"),
								"（合成只用它），其余是备选，在「产物 → 镜头」里可对比并「选用」。"
								+ "成本线性增长，显存峰值不变。"),
						},
							h("select", {
								className: "mj-in", style: { flex: "1 1 auto" }, value: String(takes),
								onChange: (e) => setParam("takes", Number(e.target.value)),
							},
								h("option", { value: "1" }, "不抽卡 · 每镜 1 张"),
								h("option", { value: "2" }, "每镜 2 张 · 多花 100% 时间"),
								h("option", { value: "3" }, "每镜 3 张 · 多花 200% 时间"),
								h("option", { value: "4" }, "每镜 4 张 · 多花 300% 时间"),
								h("option", { value: "6" }, "每镜 6 张 · 多花 500% 时间"))),
						h(Opt, {
							label: "合规",
							help: h("span", null,
								"发布平台的强制标注。打开后：① 方案提示词加一条构图约束（这才是真正的「预留」）"
								+ " ② 合成时把标注烧进画面 ③ 字幕自动上移让开预留区。"),
						},
							h("select", {
								className: "mj-in", style: { flex: "1 1 auto" }, value: P.compliance || "",
								onChange: (e) => setParam("compliance", e.target.value),
							},
								h("option", { value: "" }, "不投平台 / 不加标注"),
								h("option", { value: "hongguo" }, "红果短剧 · AI 标注 + 右 5% / 底 8% 边距"))),

						h("div", { className: "mj-lab sec" }, "当前配方"),
						h("div", { className: "mj-recipe" },
							h("div", null, h("i", null, "加速"), accelLabel(acc)),
							h("div", null, h("i", null, "VAE"), P.vaeInt8 === false ? "fp16 视频 VAE" : "int8 视频 VAE"),
							h("div", null, h("i", null, "显存"), (P.vramMode && P.vramMode !== "off")
								? "LowVRAM 补丁：" + P.vramMode : "无（默认最短路径）"),
							h("div", null, h("i", null, "抽卡"), takes + " 张 / 镜"),
							h("div", null, h("i", null, "采样"), (P.sampler || "euler") + " · "
								+ "shift " + (P.shiftVideo === undefined ? 12 : P.shiftVideo))),
						h("div", { className: "mj-mut", style: { fontSize: 12, lineHeight: 1.55 } },
							"加速机制与采样器", h("b", null, "不可自由组合"), "：PDD 自带 sigmas，"
								+ "不能与 BasicScheduler 叠；Turbo 的 LoRA 必须同时喂给 Guider 与 Scheduler。"
								+ "这些由渲染器保证，界面只让你选机制。")));
			}
function colPipeline() {
				const stageMap = {};
				const stages = (job && job.stages) || STAGE_DEF.map((s) => ({ key: s[0], name: s[1], state: "pending", note: "" }));
				stages.forEach((s) => { stageMap[s.key] = s; });

				const shotCount = (proj && proj.shotsDoc && (proj.shotsDoc.shots || []).length) || 0;

				return h(Pane, { title: "执行管线", grow: true,
					right: h("div", { className: "mj-row" },
						h("button", {
							className: "mj-btn", title: "环境体检：ComfyUI 服务 / H3 模型 / 自定义节点",
							disabled: !pid || jobRunning, onClick: doPreflight,
						}, "\u25c6 体检"),
						job ? h("span", { className: "mj-tag" + (jobRunning ? " warn" : job.exitCode === 0 ? " ok" : " bad") },
							stateText(job)) : null) },
					h("div", { className: "mj-grid3" },
						STAGE_ORDER.map((k) => {
							const s = stageMap[k] || { name: k, state: "pending" };
							const cls = "mj-btn wide"
								+ (k === "render" ? " pri" : "")
								+ (s.state === "failed" ? " bad" : "");
							const tip = k === "plan"
								? ("由大模型直出分镜与 H3 提示词；已有 " + shotCount + " 镜，重写会覆盖（自动备份 .bak）")
								: (s.note || "");
							return h("button", {
								key: k, className: cls, disabled: !pid || jobRunning, title: tip,
								onClick: () => {
									if (k === "plan" && shotCount > 0
										&& !window.confirm("重新生成方案会覆盖现有 shots.json 的 "
											+ shotCount + " 个镜头。\n原文件会备份为 shots.json.bak。\n\n继续？")) return;
									startPipeline({ only: [k] });
								},
							}, s.name + (s.state === "done" ? " \u2713" : s.state === "failed" ? " \u2717" : ""));
						})),
					h("div", { className: "mj-row", style: { flexWrap: "nowrap" } },
						h("span", { className: "mj-lab", style: { flex: "0 0 auto", marginTop: 0 } }, "快速执行"),
						h("button", {
							className: "mj-btn go", style: { flex: "1 1 auto" },
							disabled: !pid || jobRunning,
							onClick: () => startPipeline({ only: ["render", "judge", "merge"] }),
						}, "\u25b6 开始"),
						h("button", {
							className: "mj-btn", style: { flex: "0 0 58px" },
							disabled: !jobRunning, onClick: stopPipeline,
						}, "停止")),
					h("button", {
						className: "mj-btn go wide", disabled: !pid || jobRunning,
						onClick: () => startPipeline({ mode: "all" }),
					}, "一条龙（环境\u2192方案\u2192渲染\u2192质检\u2192合成）"),
					h("button", {
						className: "mj-btn ai wide", disabled: !pid || jobRunning,
						onClick: () => startPipeline({ mode: "ai", retries: 2 }),
					}, "\u2728 AI 一条龙（质检不过自动返修重渲）"),
					job && lastNote(stages)
						? h("div", { className: "mj-mono mj-mut", style: { fontSize: 12.5 } }, lastNote(stages))
						: null);
			}

			function lastNote(stages) {
				for (let i = stages.length - 1; i >= 0; i--) {
					if (stages[i].note) return stages[i].name + "：" + stages[i].note;
				}
				return "";
			}

			// ── 渲染：分镜故事板（核心工作区）──
			//
			// 一个漫剧台的核心工作对象是「镜头」，不是参数。所以镜头占主视野：
			// 每镜一张卡，直接给出画面、景别、时长、质检状态与提示词摘要，
			// 单镜重渲就在卡上。参数与渲染配置退到右侧可折叠栏。
			function shotData() {
				const shots = (proj && ((proj.plan && proj.plan.shots) || (proj.shotsDoc && proj.shotsDoc.shots))) || [];
				const clipMap = {};
				const list = (prod.clips || []);
				for (let i = 0; i < list.length; i++) {
					if (!list[i].final) clipMap[String(list[i].name).replace(/\.mp4$/i, "")] = list[i];
				}
				const asset = {};
				const kinds = ["characters", "scenes", "props"];
				for (let k = 0; k < kinds.length; k++) {
					const arr = prod[kinds[k]] || [];
					for (let i = 0; i < arr.length; i++) asset[arr[i].id] = arr[i];
				}
				const cur = (job && job.progress && job.progress.label) || "";
				const byFile = (qcRep && qcRep.byFile) || {};
				const rows = [];
				for (let i = 0; i < shots.length; i++) {
					const s = shots[i] || {};
					const sid = String(s.id || ("s" + (i + 1)));
					const clip = clipMap[sid] || null;
					const q = clip ? byFile[sid + ".mp4"] : null;
					let st = "idle";
					if (clip) st = q ? (q.ok ? "ok" : "bad") : "done";
					else if (jobRunning && cur && cur === sid) st = "running";
					const refs = [];
					const chs = s.characters || [];
					for (let c = 0; c < chs.length; c++) if (asset[chs[c]]) refs.push(asset[chs[c]]);
					const sc = s.scene && asset[s.scene] ? asset[s.scene] : null;
					rows.push({
						shot: s, id: sid, clip: clip, qc: q, state: st,
						refs: refs, scene: sc,
						// 带上集号：故事板要**按集分组**，不然 24 张卡平铺在一起认不出哪张属于哪一集
						episode: String(s.episode || ""),
						prompt: String(s.prompt || s.h3_prompt || ""),
						secs: s.length ? Math.round((s.length / 24) * 10) / 10 : 0,
					});
				}
				return rows;
			}

			function shotBoard() {
				// 用 Studio 记忆化过的行数据；不在这里现算，见 shotRows 的注释
				const rows = shotRows;
				const counts = { all: rows.length, ok: 0, done: 0, bad: 0, idle: 0, running: 0 };
				for (let i = 0; i < rows.length; i++) {
					const st = rows[i].state;
					if (st === "ok") counts.ok += 1;
					else if (st === "bad") counts.bad += 1;
					else if (st === "done") counts.done += 1;
					else if (st === "running") counts.running += 1;
					else counts.idle += 1;
				}
				const FILTERS = [
					["all", "全部", counts.all],
					["ok", "已完成", counts.ok + counts.done],
					["bad", "不合格", counts.bad],
					["idle", "待渲染", counts.idle + counts.running],
				];
				const shown = rows.filter((r) => {
					if (shotFilter === "all") return true;
					if (shotFilter === "ok") return r.state === "ok" || r.state === "done";
					if (shotFilter === "bad") return r.state === "bad";
					return r.state === "idle" || r.state === "running";
				});

				// ── 排序 → 按集分组 ──
				// 多集项目里 24 张卡平铺会"看着很乱"（用户原话），所以先按选择的规则排序，
				// 再按镜头自己的 episode 切成若干段、每段一个表头（集号 + 集名 + 已渲/总数 + 镜号区间）。
				const dir = shotSort === "desc" ? -1 : 1;
				const sorted = shown.slice().sort((a, b) => {
					if (shotSort === "state") {
						const rank = { bad: 0, running: 1, idle: 2, done: 3, ok: 4 };
						const ra = rank[a.state] === undefined ? 9 : rank[a.state];
						const rb = rank[b.state] === undefined ? 9 : rank[b.state];
						if (ra !== rb) return ra - rb;
					}
					if (a.id < b.id) return -dir;
					if (a.id > b.id) return dir;
					return 0;
				});
				const groups = [];
				const gidx = {};
				for (let i = 0; i < sorted.length; i++) {
					const ep = String(sorted[i].episode || "");
					if (gidx[ep] === undefined) {
						gidx[ep] = groups.length;
						const t = (proj && proj.episodes && proj.episodes[ep]) || "";
						groups.push({ ep: ep, label: ep ? (t || ep) : "未分集", rows: [] });
					}
					groups[gidx[ep]].rows.push(sorted[i]);
				}

				const head = h("div", { className: "mj-boardbar" },
					h("span", { className: "mj-lab sec", style: { flex: "0 0 auto", marginTop: 0 } }, "分镜故事板"),
					FILTERS.map((f) => h("button", {
						key: f[0],
						className: "mj-btn" + (shotFilter === f[0] ? " pri" : ""),
						onClick: () => setShotFilter(f[0]),
					}, f[1] + " " + f[2])),
					h("span", { className: "mj-sp" }),
					// 排序：看故事板时最常用的三种顺序（镜号顺序 / 倒序 / 按状态把问题镜头顶到前面）
					h("span", { className: "mj-mut", style: { fontSize: 11.5 } }, "排序"),
					[["asc", "镜号 \u2191"], ["desc", "镜号 \u2193"], ["state", "状态"]].map((o) => h("button", {
						key: o[0],
						className: "mj-btn" + (shotSort === o[0] ? " pri" : ""),
						style: { padding: "2px 7px" },
						onClick: () => setShotSort(o[0]),
					}, o[1])),
					counts.bad ? h("span", { className: "mj-tag bad" }, "不合格 " + counts.bad) : null,
					qcRep && qcRep.checkedAt
						? h("span", { className: "mj-mut", style: { fontSize: 12.5 } },
							"质检 " + String(qcRep.checkedAt).slice(5, 16).replace("T", " "))
						: null,
					// 右上角：刷新 + 日志。刷新是"我不想等轮询"的出口，
					// 日志是"跑完了想翻旧账"的出口 —— 两件最常被需要、此前都没有的事。
					h("button", {
						className: "mj-refresh" + (refreshing ? " busy" : ""),
						disabled: refreshing || !!busy,
						title: "重新读取项目列表、分镜、产物、质检与 ComfyUI 状态（不会清空当前画面）",
						onClick: refreshAll,
					},
						h("span", { className: "mj-refi" }, "\u21bb"),
						refreshing ? "刷新中…" : "刷新"),
					h("button", {
						className: "mj-refresh", disabled: !pid,
						title: "查看已落盘的任务日志（output/logs，渲染与管线跑完会自动写）",
						onClick: openLogs,
					}, "\u2261 日志"));

				if (!pid) {
					return h(Pane, { title: "分镜故事板", grow: true },
						h("div", { className: "mj-empty" },
							h("span", null, "\u25a3"),
							"先在左侧打开一个项目"));
				}
				if (!rows.length) {
					return h(Pane, { title: "分镜故事板", grow: true,
						right: h("span", { className: "mj-tag" }, "0 镜") },
						h("div", { className: "mj-empty" },
							h("span", null, "\u25a3"),
							"还没有分镜",
							h("div", { className: "mj-mut", style: { maxWidth: 360 } },
								"由大模型把正文直出成分镜与 H3 提示词。空状态光说「没有」不够，这里直接给下一步。"),
							h("div", { className: "mj-row", style: { marginTop: 4 } },
								h("button", {
									className: "mj-btn pri", disabled: jobRunning,
									title: "只跑「方案」阶段，产出分镜与提示词",
									onClick: () => startPipeline({ only: ["plan"] }),
								}, "\u25b6 生成方案"),
								h("button", {
									className: "mj-btn",
									onClick: () => { setSideOpen(true); setSideTab("content"); },
								}, "\u2192 先放正文"))));
				}
				return h(Pane, { title: "分镜故事板", grow: true,
					right: h("div", { className: "mj-row" }, head) },
					shown.length
						? h("div", { className: "mj-boardscroll" },
							groups.map((g) => h("div", { className: "mj-epgroup", key: g.ep || "_none" },
							// 分集表头：一眼看出这段是哪一集、渲到哪了、镜号从哪到哪
							h("div", { className: "mj-ephead" },
								h("span", { className: "mj-eptag" }, g.label),
								h("span", { className: "mj-mut", style: { fontSize: 11.5 } },
									g.rows.filter((x) => x.clip).length + "/" + g.rows.length + " 镜已渲"),
								h("span", { className: "mj-sp" }),
								h("span", { className: "mj-mut", style: { fontSize: 11.5, fontVariantNumeric: "tabular-nums" } },
									g.rows[0].id + " \u2192 " + g.rows[g.rows.length - 1].id)),
							h("div", { className: "mj-boardgrid" }, g.rows.map((r) => h(ShotCard, {
								key: r.id, row: r, pid: pid, jobRunning: jobRunning,
								onOpen: openShotDetail,
								onRerender: rerenderShot,
								onZoom: zoomShot,
							}))))))
						: h("div", { className: "mj-empty" }, h("span", null, "\u25cc"), "该筛选下没有镜头"));
			}



			// ── 渲染：单镜详情（完整提示词 / 参考图编号 / 台词 / 质检）──
			function shotDetail() {
				const r = detailShot || {};
				// 详情里直接翻页：看完 s01 不用关掉再点 s02 —— 逐镜检查是最常见的动作
				const all = shotRows || [];
				let at = -1;
				for (let i = 0; i < all.length; i++) if (all[i].id === r.id) { at = i; break; }
				const prev = at > 0 ? all[at - 1] : null;
				const next = at >= 0 && at < all.length - 1 ? all[at + 1] : null;
				const s = r.shot || {};
				const prompt = String(s.prompt || s.h3_prompt || "");
				const refs = r.refs || [];
				const dialogue = s.dialogue || [];
				const STATE = { ok: "已完成", done: "已渲染", bad: "不合格", running: "渲染中", idle: "待渲染" };
				return h(Modal, {
					title: "镜头 " + (r.id || "") + " 详情"
						+ (at >= 0 ? "（" + (at + 1) + " / " + all.length + "）" : ""),
					onClose: () => setDetailShot(null),
					// 详情里能直接翻到上一镜 / 下一镜
					actions: h("div", { className: "mj-row", style: { gap: 5 } },
						h("button", {
							className: "mj-btn", disabled: !prev, title: "上一镜",
							onClick: () => prev && setDetailShot(prev),
						}, "\u2039 上一镜"),
						h("button", {
							className: "mj-btn", disabled: !next, title: "下一镜",
							onClick: () => next && setDetailShot(next),
						}, "下一镜 \u203a")),
				},
					h("div", { className: "mj-row" },
						h("span", { className: "mj-tag" + (r.state === "ok" ? " ok" : r.state === "bad" ? " bad" : r.state === "running" ? " warn" : "") },
							STATE[r.state] || "待渲染"),
						s.shot_size ? h("span", { className: "mj-tag" }, s.shot_size) : null,
						s.camera ? h("span", { className: "mj-tag" }, s.camera) : null,
						r.secs ? h("span", { className: "mj-tag" }, r.secs + "s") : null,
						h("span", { className: "mj-tag" }, s.mode === "r2v" ? "Ref2VA" : "T2VA"),
						s.seed === undefined ? null : h("span", { className: "mj-tag" }, "seed " + s.seed),
						r.clip ? h("span", { className: "mj-tag" }, fmtMB(r.clip.size)) : null),

					r.clip
						? h("video", {
							style: { width: "100%", maxHeight: 320, borderRadius: 10, background: "#000", display: "block" },
							controls: true, autoPlay: true, loop: true, src: mediaUrl(pid, r.clip.name),
						})
						: null,

					r.qc && !r.qc.ok
						? h("div", { style: { border: "1px solid color-mix(in srgb,var(--mj-bad) 45%,transparent)",
							background: "color-mix(in srgb,var(--mj-bad) 12%,transparent)", borderRadius: 10, padding: "8px 11px" } },
							h("div", { className: "mj-err" }, "质检不合格：" + r.qc.problems.join("；")))
						: null,
					r.qc && r.qc.ok && r.qc.warnings && r.qc.warnings.length
						? h("div", { className: "mj-mut", style: { fontSize: 13 } }, "质检警告：" + r.qc.warnings.join("；"))
						: null,

					(refs.length || r.scene)
						? h("div", null,
							h("div", { className: "mj-lab sec" }, "参考图 —— 顺序就是 <Picture i> 的编号"),
							h("div", { className: "mj-grid4" },
								refs.map((a, i) => h("div", { className: "mj-card", key: a.id || i, style: { cursor: "default" } },
									a.image
								? h("img", {
									className: "mj-thumb mj-zoomable", tabIndex: 0, role: "button", onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (e.currentTarget.click) e.currentTarget.click(); } },  src: mediaUrl(pid, a.image), alt: a.name || "",
									title: "点击放大",
									onClick: () => openViewer(assetItems(castForm.kind), indexOfAsset(castForm.kind, a.id)),
								})
								: h("div", { className: "mj-thumb" }),
									h("div", { style: { fontSize: 12.5, marginTop: 4 } },
										"<Picture " + (i + 1) + "> " + (a.name || "")))),
								r.scene ? h("div", { className: "mj-card", key: "__scene", style: { cursor: "default" } },
									r.scene.image ? h("img", {
											className: "mj-thumb mj-zoomable", tabIndex: 0, role: "button", onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (e.currentTarget.click) e.currentTarget.click(); } },  src: mediaUrl(pid, r.scene.image),
											alt: r.scene.name || "", title: "点击放大",
											onClick: () => openViewer(assetItems("scenes"), indexOfAsset("scenes", r.scene.id)),
										}) : h("div", { className: "mj-thumb" }),
									h("div", { style: { fontSize: 12.5, marginTop: 4 } },
										"<Picture " + (refs.length + 1) + "> " + (r.scene.name || "场景") + "（场景永远最后）")) : null))
						: h("div", { className: "mj-mut", style: { fontSize: 13 } },
							"这一镜没有参考图 —— 纯文生（T2VA）。要锁脸请在「角色管理」导入定妆照，并在方案里把角色挂到这一镜。"),

					dialogue.length
						? h("div", null,
							h("div", { className: "mj-lab sec" }, "台词（" + dialogue.length + " 句，语言锁已由代码补齐）"),
							dialogue.map((d, i) => h("div", { className: "mj-mono", key: i },
								(d.speaker || "?") + "：<d>[Chinese]" + (d.text || "") + "</d>")))
						: null,

					h("div", null,
						h("div", { className: "mj-lab sec" }, "H3 提示词 · " + prompt.length + " 字符"
							+ (prompt.length < 2500 ? "（官方要求 2500–6000，偏短）" : "")),
						h("pre", { className: "mj-pre", style: { maxHeight: 300 } }, prompt || "（空）")),

					h("div", { className: "mj-row" },
						h("button", {
							className: "mj-btn pri", disabled: jobRunning,
							onClick: () => { const id2 = r.id; setDetailShot(null); rerenderShot(id2); },
						}, "重渲此镜（换 seed）"),
						h("button", { className: "mj-btn", onClick: () => setDetailShot(null) }, "关闭")));
			}


			// 原先它占满一整列，把画布挤窄；现在压成横条，让故事板拿回宽度。
			function runBar() {
				const stages = (job && job.stages) || STAGE_DEF.map((s) => ({ key: s[0], name: s[1], state: "pending", note: "" }));
				const lines = (job && job.lines) || [];
				const p = (job && job.progress) || null;
				const total = (p && p.total) || 0;
				const idx = (p && p.index) || 0;
				const pct = total > 0 ? Math.round((idx / total) * 100) : 0;
				// **外部作业**（命令行 manju-headless.py 起的渲染）也显示在**这一个**日志窗口里。
				// 界面里点「管线」起的作业有自己的 job.lines；从命令行起的不走宿主，
				// 只有全局活动记录知道它在跑 —— 两者共用同一个窗口，不另造浮层。
				const ext = (!job && act && act.active && (act.running || act.stale)) ? act : null;
				const extLines = ext ? String(act.tail || "").split("\n").filter((x) => x !== "") : [];
				const shown = logOpen
					? (ext ? extLines.slice(Math.max(0, extLines.length - 500)) : lines.slice(Math.max(0, lines.length - 500)))
					: [];

				return h("div", { className: "mj-run" },
					h("div", { className: "mj-runbar" },
						h("span", { className: "mj-tag" + (jobRunning ? " warn" : job && job.exitCode === 0 ? " ok" : job ? " bad" : "") },
							stateText(job)),
						job ? h("span", { className: "mj-mut", style: { fontSize: 12.5, fontVariantNumeric: "tabular-nums" } },
							job.jobId + (job.mode ? " · " + job.mode : "")) : null,
						ext
							? h("span", { className: "mj-tag" + (act.running ? " warn" : " bad") },
								(act.running ? "外部管线运行中" : "外部管线已中断")
								+ " · " + act.active.project + " · " + act.active.cmd
								+ " · 已跑 " + fmtDur((Date.now() - (act.active.startedAt * 1000 || Date.now())) / 1000))
							: h("div", { className: "mj-chips" },
								stages.map((s) => h(Chip, { key: s.key, name: s.name, state: s.state, note: s.note }))),
						total
							? h("div", { style: { flex: "1 1 120px", minWidth: 100 } },
								h("div", { className: "mj-bar" }, h("i", { style: { width: pct + "%" } })))
							: null,
						total ? h("span", { className: "mj-mut", style: { fontSize: 12.5, fontVariantNumeric: "tabular-nums" } },
							idx + "/" + total + " · " + pct + "%") : null,
						h("span", { className: "mj-sp" }),
						h("button", {
							className: "mj-btn go", disabled: !pid || jobRunning,
							onClick: () => startPipeline({ only: ["render", "judge", "merge"] }),
						}, "\u25b6 开始"),
						h("button", {
							className: "mj-btn", disabled: !jobRunning, onClick: stopPipeline,
						}, "停止"),
						h("button", {
							className: "mj-btn go", disabled: !pid || jobRunning,
							title: "环境→方案→资产→渲染→质检→合成。质检不过只报告，不自动返修。",
							onClick: () => startPipeline({ mode: "all" }),
						}, "\u25b6 一条龙"),
						h("button", {
							className: "mj-btn ai", disabled: !pid || jobRunning,
							title: "同上，但质检不过会自动删掉坏镜头、换 seed 重渲（最多 2 轮）",
							onClick: () => startPipeline({ mode: "ai", retries: 2 }),
						}, "\u2728 AI 一条龙"),
						h("button", {
							className: "mj-btn", disabled: !job && !ext,
							title: "只清空本面板显示的日志，不影响正在跑的管线",
							onClick: () => setJob(null),
						}, "清空日志"),
						ext
							? h("button", {
								className: "mj-btn",
								title: "在日志查看器里翻这一轮的完整内容（可按阶段/镜头分段）",
								onClick: () => setLogView({
									pid: act.active.project,
									name: String(act.active.rel || "").replace(/^.*\//, ""),
									text: act.tail || "",
								}),
							}, "完整日志")
							: null,
						h("button", {
							className: "mj-btn" + (liveReverse ? " pri" : ""), disabled: !logOpen,
							title: "最新的一步显示在最上面（查「刚刚发生了什么」时用）",
							onClick: () => setLiveReverse(!liveReverse),
						}, liveReverse ? "\u2193 倒序" : "\u2191 正序"),
						h("button", { className: "mj-btn", onClick: () => setLogOpen(!logOpen) }, logOpen ? "收起日志" : "展开日志")),
					logOpen
						? h("div", { className: "mj-log", ref: logRef, style: { minHeight: 84, maxHeight: "12vh" } },
							shown.length
								? h("div", null, LogSections({ sections: splitLogSections(shown), reversed: liveReverse }))
								: h("div", { className: "mj-empty" }, h("span", null, "\u25cc"), "暂无日志，点「开始」或「AI 一条龙」"))
						: null);
			}


			// ── 渲染：产物 ──
			function colProducts() {
				// 成片排在最前：它是"要交付的东西"。
				// 折叠状态下这一行会显示每个页签的**计数**，所以「成片 2」一眼可见 ——
				// 用户问"成片的管理界面在哪"，根因就是它原来沉在镜头列表末尾、面板还收着。
				const TABS = [["films", "成片"], ["characters", "人物"], ["scenes", "场景"], ["props", "道具"], ["clips", "镜头"]];
				const list = prod[prodTab] || [];
				return h(Pane, { title: "产物", collapsed: !prodOpen,
					// 收起时把四类计数铺成等宽分段，把拉满的宽度用上（不只是两侧顶着）
					fill: prodOpen ? null : TABS.map((t) => h("button", {
						key: t[0],
						className: "mj-seg" + (prodTab === t[0] ? " on" : ""),
						title: "看「" + t[1] + "」（共 " + ((prod[t[0]] || []).length) + " 项）",
						onClick: () => { setProdTab(t[0]); setProdOpen(true) },
					},
						h("span", { className: "k" }, t[1]),
						h("b", null, String((prod[t[0]] || []).length)))),
					right: h("div", { className: "mj-row" },
						h("button", {
							className: "mj-btn", title: prodOpen ? "收起产物区" : "展开产物区",
							onClick: () => setProdOpen(!prodOpen),
						}, prodOpen ? "\u25be 收起" : "\u25b8 展开"),
						h("button", { className: "mj-btn", disabled: !pid, onClick: () => loadProd(pid) }, "刷新"),
						h("button", { className: "mj-btn", disabled: !pid, onClick: () => setShowCast(true) }, "角色管理"),
						h("button", { className: "mj-btn pri", disabled: !pid || jobRunning, onClick: doAssemble }, "拼接成片")) },
					h("div", { className: "mj-row" },
						TABS.map((t) => h("button", {
							key: t[0],
							className: "mj-btn" + (prodTab === t[0] ? " pri" : ""),
							onClick: () => setProdTab(t[0]),
						}, t[1] + " " + ((prod[t[0]] || []).length))),
						h("span", { className: "mj-sp" }),
						h("span", { className: "mj-mut", style: { fontSize: 12.5 } },
							prodTab === "clips" ? "点缩略图大屏看，卡片上还能重渲/清备选" : "点卡片大屏观看")),

					// ── 大屏播放区 ──
					// 原来成片/镜头只能弹出小窗看：面板 max-height:30vh 再叠视频卡 112px 上限。
					// 这里把选中项铺满宽度、最高 56vh，直接在这里看完再关。
					playerFor
						? h("div", { className: "mj-bigplay" },
							h("video", {
								key: playerFor, className: "mj-bigvid", controls: true, autoPlay: true,
								src: mediaUrl(pid, playerFor) + "#t=0.4",
							}),
							h("div", { className: "mj-bigbar" },
								h("span", { className: "mj-clipname", title: playerFor }, playerFor),
								h("span", { className: "mj-sp" }),
								h("button", { className: "mj-btn", onClick: () => setPlayerFor("") }, "收起大屏")))
						: null,

					prodTab === "films"
						? (list.length
							? h("div", { className: "mj-filmgrid" }, list.map((f) => h("div", {
								className: "mj-filmcard" + (playerFor === f.name ? " on" : ""), key: f.name,
								// 点卡片直接大屏播放，不再只能弹小窗
								onClick: () => setPlayerFor(playerFor === f.name ? "" : f.name),
							},
								h("video", {
									className: "mj-vid", controls: true, preload: "metadata",
									src: mediaUrl(pid, f.name) + "#t=0.4",
									poster: f.poster ? mediaUrl(pid, f.poster) : undefined,
									onClick: (e) => e.stopPropagation(),
								}),
								h("div", { className: "mj-clipinfo" },
									// 优先显示片头卡上的集名（第一集 · 末班车站），没有才退回集号
									h("span", { className: "mj-clipname", title: f.name }, f.title || f.label),
									h("span", { className: "mj-cliptag on" }, "成片")),
								h("div", { className: "mj-clipmeta" },
									h("span", null, fmtMB(f.size)),
									h("span", { className: "mj-sp" }),
									h("span", { className: "mj-mut" }, "已合成，可整片观看")))))
							: h("div", { className: "mj-empty" },
								h("span", null, "\u25b6"),
								"还没有成片 —— 先渲染分镜，再用右上角「拼接成片」"))
						: prodTab === "clips"
						? (list.length
							? h("div", { className: "mj-clipgrid" }, list.map((c) => h("div", {
								className: "mj-clipcard" + (c.take ? "" : " on"), key: c.name,
							},
								h("video", {
									className: "mj-vid", controls: true, preload: "metadata",
									src: mediaUrl(pid, c.name) + "#t=0.4",
									// poster 让加载期就有画面，不再是黑框
									poster: c.poster ? mediaUrl(pid, c.poster) : undefined,
									// 点缩略图 = 大屏看这一镜（原来只能在小卡里看/弹小窗）
									onClick: (e) => { e.preventDefault(); setPlayerFor(playerFor === c.name ? "" : c.name) },
									title: "点击大屏播放",
								}),
								h("div", { className: "mj-clipinfo" },
									h("span", { className: "mj-clipname", title: c.name }, c.shot),
									h("span", { className: "mj-cliptag" + (c.final || !c.take ? " on" : "") },
										c.final ? "成片" : c.take ? ("备选 " + c.take) : "定稿")),
								h("div", { className: "mj-clipmeta" },
									h("span", null, fmtMB(c.size)),
									h("span", { className: "mj-sp" }),
									// 成片本身不可重渲，也不该有备选操作 —— 那三个按钮对它没有意义
									c.final
										? h("span", { className: "mj-mut" }, "已合成")
										: h("span", { className: "mj-row", style: { gap: 5 } },
											// 备选可以「选用」升为定稿；定稿可以「重渲」
											c.take
												? h("button", {
													className: "mj-btn pri", style: { padding: "2px 8px" },
													disabled: jobRunning,
													title: "把这张升为该镜的定稿（原定稿会退回成备选，选错了还能换回来）",
													onClick: () => pickTake(c.name),
												}, "选用")
												: h("button", {
													className: "mj-btn", style: { padding: "2px 8px" },
													disabled: jobRunning, title: "删掉这一镜重新渲染",
													onClick: () => rerenderShot(c.shot),
												}, "重渲"),
											h("button", {
												className: "mj-btn", style: { padding: "2px 8px" },
												title: "删掉这一镜的全部抽卡备选（定稿保留）",
												disabled: !c.take && !(list.some((x) => x.take && x.shot === c.shot)),
												onClick: () => dropTakes(c.shot),
											}, "清备选"))))))
							: h("div", { className: "mj-empty" },
								h("span", null, "\u25b6"),
								"还没有镜头，先完成方案阶段再渲染"))
						: h("div", { className: "mj-grid4" },
							list.map((a) => h("div", {
								className: "mj-card", key: a.id,
								style: { cursor: "default" }, title: a.desc || "",
							},
								a.image
									? h("img", {
									className: "mj-thumb mj-zoomable", tabIndex: 0, role: "button", onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (e.currentTarget.click) e.currentTarget.click(); } },  src: mediaUrl(pid, a.image),
									alt: a.name || "", loading: "lazy", title: "点击放大",
									onClick: () => openViewer(assetItems(prodTab), indexOfAsset(prodTab, a.id)),
								})
									: h("div", { className: "mj-thumb" }),
								h("div", { className: "mj-row", style: { marginTop: 5, gap: 5, flexWrap: "nowrap" } },
									h("span", {
										style: {
											fontSize: 13, fontWeight: 600, minWidth: 0,
											overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
										},
									}, a.name || "(未命名)"),
									h("span", { className: "mj-sp" }),
									h("button", {
										className: "mj-btn", style: { padding: "2px 7px" }, title: "删除这张素材",
										onClick: delCast(prodTab, a.id),
									}, "删")))),
							list.length ? null : h("div", { className: "mj-empty" },
								h("span", null, "\u2725"),
								"暂无" + (prodTab === "characters" ? "人物定妆图" : "素材") + "，点「角色管理」导入")));
			}

			// ── 视图：视频管理 ──
			//
			// 版式：成品列表（窄）｜分镜故事板（主区，占满剩余宽度）｜参数侧栏（可折叠）
			//       底部：运行条（状态+阶段+快速执行+日志）与产物条
			// 这样镜头永远是视野中心，参数与日志退居配角。
			function viewVideo() {
				const SIDE_TABS = [
					["content", "内容", "第一步：建项目、放正文（小说或分镜脚本）"],
					["params", "参数", "第二步：风格 / 模型 / 画质 / 步数 / 质量"],
					["render", "渲染", "第三步：镜头范围 / 转场 / 响度 / 采样器 / 双 shift"],
					["engine", "引擎", "渲染引擎：加速机制 / VAE / 显存 / 抽卡 / 平台合规"],
					["pipe", "管线", "第四步：资产定妆 → 分镜渲染 → 质检 → 合成成片"],
				];
				return h("div", { className: "mj-stack" },
					h("div", { className: "mj-work" },
						colProjects(),
						h("div", { className: "mj-board", key: "board" }, shotBoard()),
						sideOpen
							? h("div", { className: "mj-side", key: "side" },
								h("div", { className: "mj-nav", style: { flex: "0 0 auto" } },
									SIDE_TABS.map((t) => h("button", {
										key: t[0],
										className: "mj-navb" + (sideTab === t[0] ? " on" : ""),
										title: t[2],
										onClick: () => setSideTab(t[0]),
									}, t[1])),
									h("span", { className: "mj-sp" }),
									h("button", {
										className: "mj-btn", title: "收起侧栏，把宽度让给故事板",
										onClick: () => setSideOpen(false),
									}, "\u25b8 收起")),
								h("div", { className: "mj-sidebody" },
									sideTab === "content" ? colContent()
										: sideTab === "params" ? colParams()
											: sideTab === "render" ? colRender()
										: sideTab === "engine" ? colEngine() : colPipeline()))
							: h("div", { className: "mj-side off", key: "side" },
								h("button", {
									className: "mj-rail", onClick: () => setSideOpen(true),
									title: "展开参数 / 内容来源 / 执行管线",
								}, "\u25c2 展开 参数 · 内容来源 · 执行管线"))),
					runBar(),
					detailShot ? shotDetail() : null,
					h("div", { className: "mj-products" }, colProducts()));
			}

			// ── 视图：ComfyUI（启动管理 + 可用模型 + 画质备忘）──
			function viewComfy() {
				const P = params || {};
				const st = comfy || {};
				const cbusy = busy.indexOf("ComfyUI") === 0;
				return h("div", { className: "mj-views" },
					colProjects(),
					h("div", { className: "mj-col mj-grow", key: "cf" },
						h(Pane, { title: "ComfyUI 启动管理",
							right: h("div", { className: "mj-row" },
								h("span", { className: "mj-led" + (st.up ? " on" : "") }),
								h("span", { className: "mj-tag" + (st.up ? " ok" : " bad") }, st.up ? "运行中" : "未运行")) },
							h(KV, { label: "地址" },
								h("input", {
									className: "mj-in", value: P.comfyUrl === undefined ? "" : P.comfyUrl,
									placeholder: "http://127.0.0.1:8199",
									onChange: (e) => setParam("comfyUrl", e.target.value),
								}),
								h("button", { className: "mj-btn", onClick: loadComfy }, "刷新")),
							h("div", { className: "mj-mono mj-mut", style: { fontSize: 12.5 } },
								(st.url || "—") + " · 端口 " + (st.port || "—")
								+ (st.pids && st.pids.length ? " · PID " + st.pids.join(",") : " · 无监听进程")
								+ (st.managed ? " · 本插件代管" : "")),
							st.vram
								? h("div", { className: "mj-mono mj-mut", style: { fontSize: 12.5 } },
									"显存 已用 " + st.vram.usedMB + "MB / " + st.vram.totalMB + "MB（余 " + st.vram.freeMB + "MB）")
								: null,
							h("div", { className: "mj-row" },
								h("button", {
									className: "mj-btn go", disabled: cbusy || st.up,
									onClick: () => comfyAction("start"),
								}, "\u25b6 启动"),
								h("button", {
									className: "mj-btn", disabled: cbusy || !st.up,
									onClick: () => comfyAction("stop"),
								}, "\u25a0 停止"),
								h("button", {
									className: "mj-btn", disabled: cbusy,
									onClick: () => comfyAction("restart"),
								}, "\u21bb 重启"),
								h("button", {
									className: "mj-btn", disabled: cbusy || !st.up,
									title: "立刻归还 ComfyUI 占着的显存与内存（实测 21.9GB → 0.99GB）；下次渲染会自动重新加载",
									onClick: () => comfyAction("free"),
								}, "\u21e3 释放显存"),
								h("button", {
									className: "mj-btn", disabled: !pid || cbusy, onClick: doEnv,
								}, "环境体检")),
							h("div", { className: "mj-row" },
								h("button", {
									className: "mj-btn" + (P.autoStart === false ? "" : " go"),
									title: "渲染前若 ComfyUI 不在线就自动拉起",
									onClick: () => setParam("autoStart", P.autoStart === false),
								}, "自动启动：" + (P.autoStart === false ? "关" : "开")),
								h("span", { className: "mj-lab", style: { flex: "0 0 auto" } }, "空闲退出"),
								h("input", {
									className: "mj-in", style: { width: 52 }, type: "number", min: 0,
									title: "空闲多少分钟后自动退出 ComfyUI；0 = 一直开着（默认 15 分钟，到点下次渲染会自动拉起）",
									value: P.idleExitMin === undefined ? 15 : P.idleExitMin,
									onChange: (e) => setParam("idleExitMin", e.target.value === "" ? 0 : Number(e.target.value)),
								}),
								h("span", { className: "mj-mut", style: { fontSize: 12 } }, "分钟（0=不退出，默认 15）")),
							h("div", { className: "mj-mut", style: { fontSize: 12.5 } },
								"启动参数：--cache-none（不缓存节点中间产物，否则磁盘会被堆满）、"
								+ "--disable-smart-memory（用不到就卸载）、--vram-headroom 1.5（连别的程序占的显存也算进余量）。"),
							st.lastLog && !st.up
								? h("pre", { className: "mj-pre", style: { maxHeight: 130 } }, st.lastLog)
								: null),

						h(Pane, { title: "可用图像模型（资产定妆用）", grow: true,
							right: h("button", {
								className: "mj-btn pri", disabled: cbusy,
								onClick: () => comfyAction("models"),
							}, "读取 ComfyUI 清单") },
							imgModels
								? h("div", null,
									[["unets", "扩散模型 unet"], ["clips", "文本编码器"], ["vaes", "VAE"]].map((pair) => h("div", { key: pair[0] },
										h("div", { className: "mj-lab sec" }, pair[1] + "（" + ((imgModels[pair[0]] || []).length) + "）"),
										h("div", { className: "mj-row", style: { gap: 4 } },
											(imgModels[pair[0]] || []).map((n) => h("span", {
												key: n,
												className: "mj-tag" + (
													String(P.imgVae || "").indexOf(n) >= 0
													|| String(P.imgUnet || "").indexOf(n) >= 0
													|| String(P.imgClip || "").indexOf(n) >= 0 ? " ok" : ""),
											}, n))))))
								: h("div", { className: "mj-empty" }, h("span", null, "\u25cc"),
									"点右侧按钮列出 ComfyUI 里实际可用的模型 —— 免得配方写错文件名"),
							h("div", { className: "mj-lab sec" }, "当前配方"),
							h("div", { className: "mj-mono mj-mut", style: { fontSize: 12.5 } },
								"unet " + (P.imgUnet || "—") + "\n"
								+ "clip " + (P.imgClip || "—") + "（类型 " + (P.imgClipType || "krea2") + "）\n"
								+ "vae  " + (P.imgVae || "—") + "\n"
								+ "steps " + (P.imgSteps === undefined ? 8 : P.imgSteps)
								+ " · cfg " + (P.imgCfg === undefined ? 1.0 : P.imgCfg)),
							h("div", { className: "mj-mut", style: { fontSize: 12.5 } },
								"实测要点：Krea 2 的 latent_format 是 Wan21 而**不是** Flux —— VAE 用错会出满屏规则网格；"
								+ "文本编码器是 Qwen3-VL-4B 的 12 层抽取，CLIPLoader 类型必须写 krea2；"
								+ "turbo 是蒸馏权重（CFG 1.0）配 8 步，加步数反而糊。")),

						h(Pane, { title: "画质备忘" },
							h("div", { className: "mj-mono mj-mut" },
								"短边 768 为原生分辨率（1344\u00d7768）。" + NL +
								"帧数取 17k+5 网格：124 \u2248 5.17s，训练区间约 124\u2013362，更长未验证。" + NL +
								"VisualVAE 做 32\u00d7 空间下采样，只有近景才清晰。" + NL +
								"H3 渲染不出可读文字，画面里的招牌/字幕一律当伪字形。" + NL +
								"风格词必须前置，否则结果会跑成写实照片感。"))));
			}

			// ── 外壳 ──
			const NAV = [["video", "视频管理"], ["comfy", "ComfyUI"]];

			return h("div", { className: "mj-root" },
				h("div", { className: "mj-top" },
					h("div", { className: "mj-brand" },
						h("span", { className: "mj-brandmark" }, h(PanelIcon, { size: 14, active: true }))),
					h("div", { className: "mj-nav" }, NAV.map((n) => h("button", {
						key: n[0],
						className: "mj-navb" + (view === n[0] ? " on" : ""),
						onClick: () => setView(n[0]),
					}, n[1]))),
					h("div", { className: "mj-sys" },
						sys ? h("span", { className: "mj-pill" },
							h("i", null, "CPU"), h("b", null, sys.cpu + "%"), h("i", null, sys.cores + "核")) : null,
						sys ? h("span", { className: "mj-pill" },
							h("i", null, "内存"), h("b", null, fmtGB(sys.memUsed) + "/" + fmtGB(sys.memTotal))) : null,
						sys && sys.gpu ? h("span", { className: "mj-pill" },
							h("i", null, "GPU"), h("b", null, sys.gpu.util + "%"),
							h("i", null, sys.gpu.temp + "\u00b0C"),
							h("i", null, fmtGB(sys.gpu.memUsed) + "/" + fmtGB(sys.gpu.memTotal))) : null,
						sys && sys.comfy ? h("span", { className: "mj-pill" },
							h("span", { className: "mj-led" + (sys.comfy.up ? " on" : "") }),
							h("b", null, "ComfyUI"), h("i", null, sys.comfy.up ? "运行中" : "不可达")) : null,
						h("span", { className: "mj-pill" },
							h("span", { className: "mj-led" + (boot.projects && boot.projects.length ? " on" : "") }),
							h("i", null, "作品"), h("b", null, (boot.projects || []).length)))),

				h("div", { className: "mj-head" },
					h("h1", { className: "mj-h1" },
						view === "comfy" ? "ComfyUI" : "视频管理"),
					h("span", { className: "mj-sub" },
						"漫剧工作台 · 一站式管线 · " + (view === "video" ? "成品列表" : "本地 H3 渲染")),
					h("span", { className: "mj-sp" }),
					pid ? h("span", { className: "mj-tag" }, "当前项目 " + pid) : null,
					busy ? h("span", { className: "mj-pill" }, h("span", { className: "mj-spin" }), busy) : null),

				err ? h("div", { className: "mj-errbar" },
					h("span", null, "\u26a0"),
					h("span", { className: "mj-err" }, err),
					h("span", { className: "mj-sp" }),
					// 报错要能一键复制 —— 出问题时用户的第一动作就是把错误发给别人
					h("button", {
						className: "mj-btn", title: "复制错误信息",
						onClick: () => {
							try {
								if (navigator.clipboard) navigator.clipboard.writeText(String(err));
								setNotice("错误信息已复制");
							} catch (x) { /* 剪贴板不可用就算了 */ }
						},
					}, "复制"),
					h("button", { className: "mj-btn", onClick: () => setErr("") }, "知道了")) : null,

				// 兜底分发：不是 comfy 就当视频管理。写成穷举三元的话，
				// view 取到任何非预期值（旧会话残留等）都会整片空白。
				view === "comfy" ? viewComfy() : viewVideo(),


				h("div", { className: "mj-foot" },
					(boot && boot.version)
						? h("span", {
							className: "mj-tag",
							title: "当前载入的插件版本（读自 package.json）。重启 DSH 后这里应变成新版本号。",
						}, "v" + boot.version)
						: null,
					(boot && boot.version)
						? h("span", { className: "mj-tag", title: "当前载入的插件版本；重启 DSH 后应变成新版本号" },
							"v" + boot.version)
						: null,
					h("span", { className: "mj-mut", style: { fontSize: 12.5 } }, "根目录 " + (boot.root || "—")),
					h("span", { className: "mj-sp" }),
					h("span", { className: "mj-mut", style: { fontSize: 12.5 } },
						"由本地 ComfyUI + MiniMax H3 驱动，不走云端视频 API")),

				showNew ? h(Modal, { title: "新建项目", onClose: () => setShowNew(false) },
					h("div", { className: "mj-mut", style: { fontSize: 13 } },
						"项目会落在根目录下，id 只能用字母 / 数字 / 下划线 / 连字符。"),
					["id:项目 id（英文）", "title:标题", "genre:题材", "style:全局风格句"].map((f) => {
						const k = f.split(":")[0];
						return h(KV, { key: k, label: f.split(":")[1].slice(0, 4) },
							h("input", {
								className: "mj-in", value: newP[k], placeholder: f.split(":")[1],
								onChange: (e) => setNewP(Object.assign({}, newP, (function () {
									const o = {}; o[k] = e.target.value; return o;
								})())),
							}));
					}),
					h("div", { className: "mj-mut", style: { fontSize: 12.5 } },
						"风格句会前置到每一镜 —— 实测必须前置才生效，例如 cinematic 3D CGI xianxia, volumetric light。"),
					h("div", { className: "mj-row" },
						h("button", { className: "mj-btn pri", disabled: !newP.id, onClick: createProject }, "创建并打开"),
						h("button", { className: "mj-btn", onClick: () => setShowNew(false) }, "取消"))) : null,

				showCast ? h(Modal, { title: "角色管理 / 定妆图", onClose: () => setShowCast(false) },					h("div", { className: "mj-mut", style: { fontSize: 13 } },
						"导入的图会复制进项目的 assets/img/。分镜里用 first_frame 引它做角色锁定。"),
					h("div", { className: "mj-row" },
						["characters:人物", "scenes:场景", "props:道具"].map((k) => h("button", {
							key: k,
							className: "mj-btn" + (castForm.kind === k.split(":")[0] ? " pri" : ""),
							onClick: () => setCastForm(Object.assign({}, castForm, { kind: k.split(":")[0] })),
						}, k.split(":")[1]))),
					h("input", {
						className: "mj-in", value: castForm.srcPath, placeholder: "源图片绝对路径，如 D:\\Ai\\素材\\林小满.png",
						onChange: (e) => setCastForm(Object.assign({}, castForm, { srcPath: e.target.value })),
					}),
					h("div", { className: "mj-row" },
						h("input", {
							className: "mj-in", style: { flex: "1 1 140px" }, value: castForm.name, placeholder: "名称",
							onChange: (e) => setCastForm(Object.assign({}, castForm, { name: e.target.value })),
						}),
						h("input", {
							className: "mj-in", style: { flex: "1 1 200px" }, value: castForm.desc, placeholder: "外观描述（会进提示词）",
							onChange: (e) => setCastForm(Object.assign({}, castForm, { desc: e.target.value })),
						}),
						h("button", { className: "mj-btn pri", disabled: !castForm.srcPath, onClick: addCast }, "导入")),
					h("div", { className: "mj-grid4" },
						(prod[castForm.kind] || []).map((a) => h("div", { className: "mj-card", key: a.id, style: { cursor: "default" } },
							a.image ? h("img", {
									className: "mj-thumb mj-zoomable", tabIndex: 0, role: "button", onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (e.currentTarget.click) e.currentTarget.click(); } },  src: mediaUrl(pid, a.image),
									alt: a.name || "", title: "点击放大",
									onClick: () => openViewer(assetItems(castForm.kind), indexOfAsset(castForm.kind, a.id)),
								}) : h("div", { className: "mj-thumb" }),
							h("div", { style: { fontSize: 13, marginTop: 4 } }, a.name || "(未命名)"),
							h("button", { className: "mj-btn wide", style: { marginTop: 4 }, onClick: delCast(castForm.kind, a.id) }, "删除"))),
						(prod[castForm.kind] || []).length ? null : h("div", { className: "mj-empty" },
							h("span", null, "\u2725"),
							"该类目还没有素材")),
					h("div", { className: "mj-row" },
						h("button", { className: "mj-btn", onClick: () => setShowCast(false) }, "关闭"))) : null,


				// 任务日志查看器：左列选文件、右侧按「阶段 → 镜头」分段看正文。
				// 默认**倒序**（最新在上），因为查日志的人问的几乎都是"刚刚发生了什么"。
				logView ? h(Modal, {
					title: "任务日志 · " + (logView.pid || ""), onClose: () => setLogView(null),
					actions: h("div", { className: "mj-row", style: { gap: 5 } },
						h("button", {
							className: "mj-btn" + (logReverse ? " pri" : ""),
							title: logReverse ? "当前：最新在上（段与行都倒序）" : "当前：从头往下（正序）",
							onClick: () => setLogReverse(!logReverse),
						}, logReverse ? "\u2193 倒序" : "\u2191 正序"),
						h("button", {
							className: "mj-btn", title: "重新读取清单",
							onClick: openLogs,
						}, "\u21bb 刷新清单")),
				},
					logView.list.length
						? h("div", { className: "mj-row", style: { alignItems: "stretch", gap: 12, minHeight: 0 } },
							h("div", { className: "mj-plist", style: { flex: "0 0 236px", maxHeight: "58vh" } },
								logView.list.map((L) => h("button", {
									key: L.name,
									className: "mj-navb" + (L.name === logView.name ? " on" : ""),
									style: { textAlign: "left", padding: "6px 9px", display: "block", width: "100%" },
									onClick: () => openLogFile(L.name),
								},
									h("div", { style: { fontSize: 12.5, fontWeight: 600 } }, L.name),
									h("div", { className: "mj-mut", style: { fontSize: 11.5 } },
										fmtMB(L.size) + " · " + new Date(L.mtime || 0).toLocaleString())))),
							h("div", { style: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 5 } },
								h("div", { className: "mj-mut", style: { fontSize: 11.5 } },
									logView.name + " · 共 " + logTailLines(logView.text, 1e9).length + " 行"
									+ (logTailLines(logView.text, 1e9).length > 1500 ? "（只渲染尾部 1500 行）" : "")),
								h("div", { className: "mj-log", style: { flex: "1 1 auto", maxHeight: "54vh" } },
									logView.text
										? h("div", null, LogSections({
											sections: splitLogSections(logTailLines(logView.text)),
											reversed: logReverse,
										}))
										: h("div", { className: "mj-mut" }, "（空）"))))
						: h("div", { className: "mj-empty" },
							h("span", null, "\u2261"),
							"还没有日志",
							h("div", { className: "mj-mut", style: { maxWidth: 380 } },
								"渲染或跑一次管线结束后会自动落盘到 output/logs，之后随时能回来翻。"))) : null,

				// 自绘确认框（删除项目等危险动作）。原生 confirm 在 Electron 里
				// 风格割裂，也无法把"移入回收站可恢复 / 直接删除不可恢复"讲清楚。
				//
				// 两个选项必须**并列摆出来**、并说清代价差异：
				//   * 移入回收站 = 软删除，能捞回来，但空间一分不省；
				//   * 直接删除   = 真删，含所有镜头与成片，不可恢复。
				// 「直接删除」做**两步确认**（第一次只是上膛），
				// 既不用再套一层弹窗，也不会手滑一次就删库。
				confirm ? (function () {
					const ps = ((boot && boot.projects) || []).filter((x) => x.id === confirm.id)[0] || {};
					const sh = Number(ps.shotCount) || 0;
					const cl = Number(ps.clipCount) || 0;
					return h(Modal, {
						title: "删除项目", onClose: () => { setConfirm(null); setPurgeArm(false) },
					},
						h("div", { className: "mj-mut", style: { fontSize: 13 } },
							"「" + confirm.title + "」共 " + sh + " 镜，其中已渲染 " + cl + " 镜。"),
						h("div", { className: "mj-mut", style: { fontSize: 12.5 } },
							h("b", null, "移入回收站"),
							"：整个目录移到 ", h("span", { className: "mj-mono" }, "_trash"),
							"，之后可以手工恢复；占用空间不变。"),
						h("div", { className: "mj-dangerbox" },
							h("div", { className: "mj-mut", style: { fontSize: 12.5 } },
								h("b", { style: { color: "var(--mj-bad)" } }, "直接删除"),
								"：物理删除整个项目目录（含 " + cl + " 个镜头与成片），",
								h("b", { style: { color: "var(--mj-bad)" } }, "不可恢复"),
								"，回收站里也不会留副本。")),
						h("div", { className: "mj-row", style: { gap: 6, marginTop: 2 } },
							h("button", {
								className: "mj-btn", style: { flex: "0 0 auto" },
								onClick: () => { setConfirm(null); setPurgeArm(false) },
							}, "取消"),
							h("button", {
								className: "mj-btn", style: { flex: "1 1 auto", marginLeft: "auto" },
								title: "移到 _trash，可以从那里恢复",
								onClick: () => doRemoveConfirmed(confirm.id),
							}, "移入回收站"),
							h("button", {
								className: "mj-btn danger" + (purgeArm ? " armed" : ""),
								style: { flex: "0 0 auto" },
								title: purgeArm ? "再点一次就永久删除（不可恢复）" : "点两次才会执行：第一次只是上膛",
								onClick: () => {
									if (!purgeArm) { setPurgeArm(true); return }
									doPurgeConfirmed(confirm.id);
								},
							}, purgeArm ? "确认永久删除" : "直接删除")));
				})() : null,
				// 媒体预览灯箱：挂在外壳层，任何页签/弹窗里点开的图都走它
				h(Lightbox, {
					viewer: viewer,
					onClose: () => setViewer(null),
					onStep: (d) => setViewer((v) => {
						if (!v) return v;
						const n = v.items.length;
						if (n < 2) return v;
						return Object.assign({}, v, { index: Math.max(0, Math.min(v.index + d, n - 1)) });
					}),
				}));
		}

		// ───────────────────────── 注册 ─────────────────────────

		/**
		 * 错误边界。
		 *
		 * React 里渲染期抛异常会**卸载整棵树** —— 用户看到的就是"一片空白"，
		 * 而空白对排查毫无价值（看不到错误、也没法重试）。这里把它变成一块
		 * 可读的报错面板：错误信息 + 前几行调用栈 + 重试/重载。
		 */
		class ErrBound extends React.Component {
			constructor(p) {
				super(p);
				this.state = { err: null };
			}
			static getDerivedStateFromError(e) { return { err: e }; }
			componentDidCatch(e, info) {
				try { console.error("[manju-studio] render crashed", e, info); } catch (x) { /* */ }
			}
			render() {
				const e = this.state.err;
				if (!e) return this.props.children;
				return h("div", { className: "mj-crash" },
					h("div", { className: "mj-crash-h" }, "这块面板渲染出错"),
					h("div", { className: "mj-crash-m" }, String((e && e.message) || e)),
					h("pre", { className: "mj-crash-s" },
						String((e && e.stack) || "").split("\n").slice(0, 12).join("\n")),
					h("div", { className: "mj-row" },
						h("button", {
							className: "mj-btn pri",
							onClick: () => this.setState({ err: null }),
						}, "重试"),
						h("button", {
							className: "mj-btn",
							onClick: () => { try { window.location.reload(); } catch (x) { /* */ } },
						}, "重载页面")));
			}
		}

		const Main = () => h(ErrBound, null, h(Studio));

		/**
		 * 异步异常（事件回调 / Promise）不进错误边界，React 不会因此白屏，
		 * 但同样会**静默消失**。这里用一块固定定位的 DOM 覆盖层把它们显出来 ——
		 * 用原生 DOM 而不是 React，这样即使 React 那棵树已经崩了它照样能显示。
		 */
		function showAsyncError(what, e) {
			try {
				const id = "mj-async-err";
				let box = document.getElementById(id);
				if (!box) {
					box = document.createElement("div");
					box.id = id;
					box.setAttribute("style", "position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;"
						+ "max-height:38vh;overflow:auto;padding:10px 12px;border-radius:10px;"
						+ "background:rgba(20,8,10,.96);border:1px solid rgba(224,82,82,.6);color:#ffd9d9;"
						+ "font:12px/1.55 ui-monospace,Consolas,monospace;white-space:pre-wrap");
					box.textContent = "漫剧工作台出错（" + what + "）：\n" + String((e && (e.stack || e.message)) || e);
					const close = document.createElement("button");
					close.textContent = "关闭";
					close.setAttribute("style", "position:absolute;right:8px;top:6px;cursor:pointer;"
						+ "background:transparent;border:1px solid rgba(224,82,82,.6);color:#ffd9d9;"
						+ "border-radius:4px;font:12px/1 inherit;padding:2px 6px");
					close.onclick = () => { try { box.remove(); } catch (x) { /* */ } };
					box.appendChild(close);
					document.body.appendChild(box);
				}
			} catch (x) { /* 显示错误本身不能再抛错 */ }
			try { console.error("[manju-studio] " + what, e); } catch (x) { /* */ }
		}

		/** Cordis 强制要求：访问 ctx.<service> 前必须在此声明。 */
		const inject = ["slots"];

		function applyInner(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.setAttribute("data-manju-studio", "1");
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => { tag.remove(); };
			});

			// 全局兜底：任何未捕获异常都显出来，而不是消失在控制台里
			ctx.effect(() => {
				if (!window.addEventListener) return () => {};
				const onErr = (ev) => showAsyncError("未捕获异常", (ev && (ev.error || ev.message)) || ev);
				const onRej = (ev) => showAsyncError("未处理的 Promise", ev && ev.reason);
				window.addEventListener("error", onErr);
				window.addEventListener("unhandledrejection", onRej);
				return () => {
					window.removeEventListener("error", onErr);
					window.removeEventListener("unhandledrejection", onRej);
				};
			});

			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: "manju-studio" }, Main));

			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{ name: "sidebar.panellist", id: "manju-studio", order: 20, label: "漫剧工作台" },
					PanelIcon));
		}

		/** 对外入口：任何异常都被吞掉，避免整个 GUI 弹「插件加载失败」。 */
		function apply(ctx) {
			try {
				applyInner(ctx);
			} catch (e) {
				console.error("[manju-studio] apply failed", e);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
