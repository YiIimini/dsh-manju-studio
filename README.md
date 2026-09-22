# dsh-manju-studio · 漫剧工作台

DSH（DeepSeek Harness）永久插件。在 GUI 里提供一条从**小说正文**到**成片**的完整流水线：
分镜方案 → 定妆资产 → 本地 ComfyUI + MiniMax H3 批量渲染 → 质检 → 拼接成片。

**全流程本地，不调云端视频 API。**

> 版本 0.x —— 尚未发布。

## 它解决什么

把「一段小说要变成漫剧」这件事里所有琐碎环节收进一个界面：分镜怎么拆、提示词怎么写、
渲染参数怎么配、哪一镜渲糊了要重渲、抽卡备选怎么挑、成片什么时候拼。
不用记命令行，也不用在五六个工具之间来回切。

## 结构

```
package.json          插件清单（dsh.bundle.patch / dsh.client / exports）
cordis.patch.yml      Cordis 挂载声明
lib/index.js          宿主半（Node）：命令接口 + 媒体流服务
lib/client.js         浏览器半：工作台全部界面
tools/check.mjs       提交前自检（见下）
tools/check.cmd       Windows 包装
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

一条命令跑完四关：**语法闸门**（两个半当模块 import）、**包结构**、
**7 个测试套件**（单元/组件、抽卡、合规、小说库、加速机制表、accel 迁移、状态扫描）、
**渲染器 manju.py 的键完整性**。退出码非 0 即不要交付。

## 宿主半与浏览器半的硬约束

- **宿主半**：ESM，导出 `name` / `inject`（服务短名）/ `apply(ctx)`；路由用 `ctx.webServer.register`。
  `ctx.logger` 必须写 `ctx.get('logger')`。
- **浏览器半**：必须是 `window.__ModuleLoader__.load({id, factory})` 形式，用 `fetch`（永久插件没有 `host.call`）。
  **必须声明 `exports.inject = ['slots']`** —— Cordis 禁止访问未声明的 `ctx.<service>`，漏了会在启动时报错。
- package.json 需要 `dsh.bundle.patch`、`dsh.client: {platform:'web'}`，exports 暴露 `"."` 与 `"./client"`。

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
