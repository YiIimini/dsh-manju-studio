# dsh-manju-studio · 漫剧工作台

DSH（DeepSeek Harness）永久插件。在 GUI 里提供一条从**小说正文**到**成片**的完整流水线：
分镜方案 → 定妆资产 → 本地 ComfyUI + MiniMax H3 批量渲染 → 质检 → 拼接成片。

**全流程本地，不调云端视频 API。**

> 版本 0.x —— 尚未发布。

## 它解决什么

把「一段小说要变成漫剧」这件事里所有琐碎环节收进一个界面：分镜怎么拆、提示词怎么写、
渲染参数怎么配、哪一镜渲糊了要重渲、抽卡备选怎么挑、成片什么时候拼。
不用记命令行，也不用在五六个工具之间来回切。

## 三个视图

| 视图 | 管什么 |
|---|---|
| **视频管理** | 项目（= 一部剧）：成品列表 / 故事板 / 参数 / 渲染 / 引擎 / 管线，底部运行条与产物条 |
| **小说管理** | 小说工作区（默认 `D:\Ai\小说`）里的**作品**：立项书、分卷正文、设定集、全本、封面；出口是「⚡ 一键做视频」 |
| **ComfyUI** | 引擎启动 / 停止 / 重启 / 显存治理 / 模型清单 / 环境体检 |

### 小说管理 → 一键做视频（2026-09-23）

小说工作区里的一部作品是一个结构化目录（由 `manju-novel` 技能产出）：

```
D:\Ai\小说\我在戏台唱天雷\
  立项.json              书名 / 题材 / 风格 / 卷规划 / 美术方向 / 一句话卖点 …
  正文\卷一_论斤卖我那天\第001章_八斤一斤.md …    ← 逐章，章标题取自文件名
  设定集\创作指令卡-AI版本.md …
  全本\我在戏台唱天雷·全本.md
  封面\封面.png          ← 只认成品；封面_候选*.png / 封面_v*.png 是中间产物，不当封面
```

「一键做视频」一次做完这些事：

1. **选范围**：按章（可连续 N 章）/ 整卷 / 全本 —— 正文按 `PLAN_INPUT_MAX`（12000 字）截断，
   并且**把截断如实回报**（方案阶段只把前 12000 字交给模型；让用户选"全本"却悄悄只做前 8 章，
   是把系统的局限伪装成作品的局限）。
2. **建/复用项目**：**一部小说 = 一个项目**，集是项目内的概念。第二次做第二集自动落进同一个
   项目，集号自动往后排（`ep01` → `ep02`），映射记在 `_studio.json` 的 `workProjects` 里。
3. **写本集素材与溯源**：`novel-<集>.md`（**不覆盖** `novel.md`，否则重跑旧集就没有依据）、
   `novel-source-<集>.json`（这一集来自哪本书的哪些章、截断了多少）、`project.json.episodes[<集>]`。
4. **开跑 AI 一条龙**：方案 → 资产定妆 → 渲染 → 质检 → 合成（可关掉，只建项目）。

分集在**整条管线**里生效：方案阶段取本集素材并给镜头盖 `episode` 戳（id 带 `ep01-` 前缀，
并与项目里其它集的镜头合并）、渲染清单按集写 `_render-<集>.json`、
成片写 `成片-<集>.mp4`、字幕写 `output/final-<集>.ass`、质检与合成只取本集的镜头。

## 结构

```
package.json          插件清单（dsh.bundle.patch / dsh.client / exports）
cordis.patch.yml      Cordis 挂载声明
lib/index.js          宿主半（Node）：命令接口 + 媒体流服务（两个根：项目产物 / 小说工作区）
lib/client.js         浏览器半：工作台全部界面
tools/check.mjs       提交前自检（见下）
tools/check.cmd       Windows 包装
tools/manju_headless/ 无头驱动器（按能力拆成包，职责见 tools/README-driver.md）
tools/manju-headless.py  驱动器入口（薄壳，路径与名字都没变）
docs/CONVENTIONS.md   模块化 / 解耦 / 可测的落地标准
```

## 安装

```powershell
dsh plugin --profile desktop add "link:D:/Ai/DSH-plugins/dsh-manju-studio"
```

**改完代码必须重启 DSH Desktop** —— 新增/修改 bundle 不会被热加载。

## 自检（改完必跑）

```powershell
tools\check.cmd
```

一条命令跑完全部检查：**语法闸门**（两个半当模块 import）、**包结构**、
**14 个测试套件**（单元/组件、抽卡、合规、小说库、加速机制表、accel 迁移、媒体接口缓存/Range、
项目增删/日志、沙箱契约、驱动器行为锁、小说工作区/一键做视频、合成契约、UI 结构与契约、状态扫描）、
**渲染器 manju.py 的键完整性**。退出码非 0 即不要交付。

套件有两条硬规矩（2026-09-23 定，踩过坑）：

- **自带夹具**：不许硬编码真实项目名、也不许读某个真实作品的素材 —— 否则那个作品一被删，
  闸门就红得没有原因，或者更糟：表面上全绿，实际喂给界面的是错误载荷。
- **SKIP 不算失败**：前置条件不足（项目不存在 / 还没 sync / 还没成片）计 SKIP；
  零断言又没 SKIP 才算套件崩了，并把退出码与最后一行输出打出来。

「发布前自审」是**按需**套件（审的是单件产物达标与否，不是代码健康）：
`set MANJU_AUDIT_PROJECT=<项目id>` 后再跑 `gate.cmd`。

## 宿主半与浏览器半的硬约束

- **宿主半**：ESM，导出 `name` / `inject`（服务短名）/ `apply(ctx)`；路由用 `ctx.webServer.register`。
  `ctx.logger` 必须写 `ctx.get('logger')`。
- **浏览器半**：必须是 `window.__ModuleLoader__.load({id, factory})` 形式，用 `fetch`（永久插件没有 `host.call`）。
  **必须声明 `exports.inject = ['slots']`** —— Cordis 禁止访问未声明的 `ctx.<service>`，漏了会在启动时报错。
- package.json 需要 `dsh.bundle.patch`、`dsh.client: {platform:'web'}`，exports 暴露 `"."` 与 `"./client"`。
- **写盘必须带"按调用沙箱策略"**：`ctx.fs` 是 `@deepseek-ai/dsh-fs-sandbox`，
  `writeText(target, content, expected, signal, sandboxPolicy)` 的**第 5 个参数**决定围栏；
  不传就套用部署默认（workspace-write + 会话工作区根），而本插件的两个根
  （`D:\Ai\漫剧`、小说工作区）都在会话工作区之外 —— 界面里点一下就会报
  `file access denied under workspace-write mode`（Agent 在 danger-full-access 会话里跑不出来，
  只有真人在界面上点才会遇到）。宿主统一走 `writeText()` → `writeFileStamped()` 盖章，别绕过它。

## 踩过的坑（都会咬人）

1. **渲染面板的说明不要只写在 `title` 里** —— 不悬停就看不到，等于没有说明。用可见的说明行。
2. **故事板缩略图不要用 `<video preload="metadata">`** —— 它要等 seek 解码完才有画面，此前是黑的，
   任何重绘都会退回黑再重画，观感就是"一闪一闪"。改由宿主用 ffmpeg 抽一帧存 JPEG 缓存。
3. **React.memo 会被内联箭头函数废掉** —— 传给 memo 组件的每个回调都必须是 `useCallback`，
   否则每 3 秒的系统状态轮询都会重渲染全部镜头卡。
4. **hook 不能放进非组件函数** —— `shotBoard()` 是普通函数调用，把 `useMemo` 放进去会在切视图时破坏 hook 顺序。
5. **`.mj-p` 的 `max-height:30vh` 是面板纵向堆叠时代的遗留** —— 侧栏只有一个大页签面板，
   不加覆盖会让参数页 663px 的内容只有 196px 可视区。
6. **工作区要有高度下限** —— 否则会被下面的运行条与产物面板挤到几十像素，侧栏什么都显示不下。

## 相关

- 渲染驱动：[dsh-manju-render](https://github.com/YiIimini/dsh-manju-render)

## 工程约定

新建项目/新增模块请先读 [docs/CONVENTIONS.md](docs/CONVENTIONS.md)：模块化、解耦、可测、可回滚的落地标准（用户 2026-09-23 要求）。
