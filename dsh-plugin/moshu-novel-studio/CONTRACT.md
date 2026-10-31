# 墨枢插件 · 施工契约（v1）

所有并行工作都以本文件为准。**不要修改本文件之外别人负责的文件。**

## 目标

把 `F:\代码\AI辅助小说平台` 这个独立 React+Express 应用，改造成一个 DSH 插件：
在 DSH Web 左侧栏出现「墨枢」图标，点开占满中央主区，成为一个**独立整页**，
与任何会话/工作区无关。插件自带上半后端，**不再需要单独跑 Express/Vite，也不需要粘贴 token**。

## 目录与归属

```
dsh-plugin/
  build.mjs                              ← Lead（把 src-client 打成 client.js）
  moshu-novel-studio/
    package.json  cordis.patch.yml       ← Lead
    locale/*.json  icon.svg             ← Lead
    index.js  host/*.js                 ← 负责人：host-api
    src-client/
      index.jsx  page.jsx  api.js        ← 负责人：ui-shell
      strings.js  icons.jsx  styles.css  ← 负责人：ui-shell
      components/*.jsx  components/*.css ← 负责人：ui-views
    client.js                            ← 构建产物（Lead 生成，不要手写）
```

## 页面身份（固定值，别改）

- 面板 id / main 键：`moshu-novel-studio`
- 侧栏注册：`sidebar.panellist`，`id: 'moshu-novel-studio'`，`order: 25`，`label: () => '墨枢 · 小说工作台'`
- 主区注册：`main`，`key: 'moshu-novel-studio'`
- 这两条注册由 `build.mjs` 生成的 `client.js` 完成，**源码里不要再注册插槽**。

## Client 源码约定（关键）

- `src-client/**` 是 **CommonJS + JSX**，不是 ESM：写 `const React = require('react')`、`module.exports = {...}`。
- 只能 `require('react')` 和相对路径。**没有 react-dom、没有 lucide-react、没有 tailwind、没有第三方包**。
- JSX 用 `React.createElement` 编译（classic runtime），所以每个文件都要自己 `require('react')`，`<>...</>` 可用。
- 相对路径 require 支持省略扩展名：`require('./components/Editor')`、`require('../api')`。
- `.css` 可以被 `require`：`const css = require('./styles.css')` 得到字符串。
- 样式：`page.jsx` 里渲染一个 `<style dangerouslySetInnerHTML={{__html: css}} />`（组件内渲染，随卸载消失）。

## icons.jsx 必须导出的图标（33 个）

签名统一：`({ size = 16, className, ...rest }) => <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.65} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">…</svg>`

```
Activity Bell BookOpen BrainCircuit Check CheckCircle2 ChevronDown ChevronRight CircleHelp
Command Download FileText Hash LibraryBig LoaderCircle Map MessageSquareText Moon Network
PanelLeftClose PanelRightClose PanelRightOpen PenLine Plus Route Save ScanSearch Search
Settings2 Sparkles Sun X Zap
```

自绘路径，不要拷贝 lucide 的文件；风格对齐 24px 线性图标即可。

## api.js（ui-shell）

`src/api.ts` 的直译，**只改前缀**：`const BASE = '/api/moshu'`。导出：
`request, getProject, saveDocument, aiReview, saveAnnotations, runTask, setProjectContext`。

请求失败抛 `Error(message)`，`message` 取响应体 `error`（字符串或 `{message}`）。

## HTTP 契约（/api/moshu）

Host 半注册一个 `prefix` 路由 `/api/moshu`，自己解析 URL 与方法，返回 JSON。
**响应体结构沿用现有 `server/index.ts` 的同名路由，不要改字段名。**

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/api/moshu/health` | – | `{ ok: true, projectDir }` |
| GET | `/api/moshu/status` | – | `{ available, status: 'available'\|'unavailable', provider, model, message? }` |
| GET | `/api/moshu/bootstrap` | – | `Project`（同 server） |
| PUT | `/api/moshu/document` | `{ path, content }` | `{ ok: true }` |
| POST | `/api/moshu/document` | `{ path, content }` | `{ ok: true }` |
| POST | `/api/moshu/annotations` | `{ annotations, replaceAll? }` 或 `{ documentPath, annotations }` | `{ ok: true, annotations? }` |
| POST | `/api/moshu/memory` | memory 对象 | `{ memories }` |
| POST | `/api/moshu/map` | map 对象 | `{ ok: true }` |
| POST | `/api/moshu/context` | `{ ids }` | `{ ok: true }` |
| POST | `/api/moshu/ai/review` | `{ path?, documentPath, content, instruction?, sources?, context? }` | `{ annotations: Annotation[], mode: string }` |
| POST | `/api/moshu/tasks` | task | `{ ok: true, task }` |
| POST | `/api/moshu/snapshot` | – | `{ ok: true, … }` |
| GET | `/api/moshu/export` | – | `text/markdown` 附件 |

**已废弃：`/api/moshu/dsh/connect`、`/api/moshu/dsh/session/reset`。** 插件内直接用 `ctx.llm`，
页面里那个"粘贴 token"弹窗要删掉，改成只显示模型状态（`/api/moshu/status` 或 `bootstrap.dsh`）。

失败时：4xx/5xx + `{ error: '中文原因' }`。

## 数据与配置（host-api）

- 作品根目录：`.moshu/settings.json` 的 `projectDir` → 环境变量 `MOSHU_PROJECT_DIR` → 默认 `F:\代码\AI辅助小说平台`。
- 作品数据仍然落在 `<projectDir>/novels/...`，Markdown 是权威源；其余 JSON 布局照抄现有 `server/store.ts`。
- 模型：`ctx.llm.stream({ provider, model, messages, system })`，provider/model 默认 `wb-proxy` / `deepseek-v4.1-flash`，
  取 `.moshu/settings.json` 的覆盖值。**不要**再读写 `.dsh-connection.json`、不要 cookie、不要 token。

## 页面形态（ui-shell）

- 整页根节点：`<div className="moshu-root">`，`height:100%`，自己滚动，不依赖 body。
- **不要**保留墨枢原来的左侧竖排导航栏；改成页面顶部的一行视图切换 tab：
  `创作空间 / 故事大纲 / 世界资料 / 世界地图 / 时间线 / AI 记忆 / 任务中心`。
- 保留：顶部面包屑 + 搜索(⌘K) + 保存状态 + 导出；页面标题区；底部状态栏。
- 所有可见文案走 `strings.js` 的 `t()`（zh 为原文，en 为对照；缺省回退中文）。

## 样式（ui-shell / ui-views）

- 所有选择器必须挂在 `.moshu-root` 下（`.moshu-root .editor-panel{...}`），禁止裸 `body`/`:root`/`*` 泄漏到宿主。
- 颜色用宿主主题变量，**不要**硬编码浅色纸感底色：
  `--dsw-alias-bg-base`（页面底）、`--dsw-alias-bg-layer-1/2`（卡片）、
  `--dsw-alias-border-l1/l2`、`--dsw-alias-label-primary/secondary/tertiary`（文字）、
  `--dsw-alias-brand-primary`（主色）、`--dsw-alias-state-success/warn/error-primary`。
  允许保留原设计里的字号/行高/圆角/间距，让排版还是"稿纸感"。
- 组件 CSS 由 ui-views 自己 `require` 并在组件内渲染 `<style>`。

## 验收（Lead 负责）

1. `node dsh-plugin/build.mjs` 成功，`client.js` 生成。
2. `plugin_manager install_bundle` → `application: applied`。
3. 浏览器里左侧栏出现墨枢图标 → 点开是整页 → 能读作品、能存正文、能跑一次 AI 审阅。
