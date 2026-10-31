# 墨枢插件 · 重构契约 v3

目标：**推翻重写几处结构上不合理的逻辑**，不改变对外行为（接口形状、UI 文案、交互）。
原则：每一处重写都要能独立验证；宁可小步，也不要一次改崩。

## 一、为什么重写（审计证据）

| # | 现状 | 后果 |
|---|---|---|
| 1 | `annotations.json` / `memory.json` / `tasks.json` / `map` 直接用 `readJson`+`atomicWrite`，无备份、无容错、`replaceAll` 整表覆盖 | 坏一次整页 500 打不开；并发写丢更新；一次误调用清空全书批注 |
| 2 | 三类守卫（来源校验 / 作品身份 / 空书架）散在 `dispatch` 与 15 个 handler 里，新增端点靠记性 | 上一轮就是从 4 个"没加守卫"的门把示例书复活了 |
| 3 | `novelDir` 有三个来源（`settings` 默认值、`resolveNovelDir`、扫描回落） | 配置指向不存在的书时行为不可预测；设置页显示的作品名可能是假的 |
| 4 | 未保存正文存在 Editor 组件实例的 `dirtyRef` 里 | 卸载即丢；`bootstrap` 会把 textarea 冲回磁盘旧文本；保存失败后界面显示"已保存" |
| 5 | 冲突只有一格 `conflict` 状态 | 第二次 409 覆盖第一次；迟到的 409 会重弹已解决的面板 |
| 6 | `--moshu-*` token 在 5 个 CSS 文件里各声明一份，7 个值已漂移；16 处 `color:#fff` 压在会翻转的 brand 上 | 同一按钮在不同 tab 颜色不同；深色主题下主按钮"白字白底"看不见 |

## 二、Host 重写（负责人：host-refactor）

### 2.1 新增 `host/current-book.js` —— 作品解析的唯一出处
```js
/** @returns {{id:string, root:string} | null} */
export function currentBook()
```
解析顺序（**只此一处**）：`settings.novelDir` 存在且目录真实存在 → 否则扫描 `novels/` 取第一本（优先 `雾隐之城`）→ 否则 `null`。
- 删除 `store.resolveNovelDir` / `store.projectContext` / `store.novelDirExists` 的重复逻辑，全部改成薄封装调用 `currentBook()`。
- `store.loadSettings().novelDir` 保持原样（那是"配置值"，不是"解析结果"）。
- `defaultSettings().novelDir` 改成 `''`（不再假装有《雾隐之城》这本书）；`GET /settings` 的 `settings.novelDir` 在没有任何书时返回 `''`。

### 2.2 新增 `host/jsonstore.js` —— 派生 JSON 的唯一读写入口
```js
export async function readArray(root, relative, fallback = [])   // 缺文件→fallback；坏 JSON→隔离+fallback
export async function writeArray(root, relative, value)          // 写前备份旧文件
export async function readObject(root, relative, fallback = {})
export async function writeObject(root, relative, value)
export async function replaceArray(root, relative, value)        // 显式整表替换（仍先备份）
```
硬要求：
- **坏 JSON 不能让整页打不开**：解析失败时把文件改名为 `<name>.corrupt-<时间戳>`，返回 fallback，并通过 `ctx.logger` 记一条 warn（没有 ctx 就 console.warn）。
- **写前备份**：旧文件复制到 `.backups/_json/<相对路径>/<时间戳>.json`，最多保留 20 份（清理失败不影响写入）。
- **并发安全**：同一相对路径的读-改-写要串行（复用 `store` 里已有的 `withPathLock` 思路，导出一个工具或本地实现）。
- 迁移 `annotations` / `memory` / `tasks` / `map` / `context` 五个调用点。**接口返回形状一个字段都不许变。**
- `replaceAll` 语义保留，但空数组清空必须显式：`POST /annotations {replaceAll:true, annotations:[]}` → 400 `「拒绝用空数组清空全部批注；确实要清空请传 force:true」`，带 `force:true` 才执行。

### 2.3 新增 `host/routes.js` —— 路由表自带策略
把现在的 `ROUTES`（path → method → handler）改成**一条记录声明全部策略**：
```js
{ method:'POST', path:'/annotations', handler, needsBook:true, write:true, json:true }
```
`dispatch` 只做：匹配 → 按声明执行守卫（来源校验 → 作品身份 → 空书架 → JSON body 类型）→ 调 handler。
- 新增端点时必须声明策略，**默认拒绝**（没声明 `needsBook:false|true` 就不注册，构建期报错更好）。
- 现有 15 条路由的路由/方法/行为保持不变；`/health` `/status` `/books*` `/trash*` `/models` `/settings` `GET /ai/recipes` 声明 `needsBook:false`。

### 2.4 验收
- 写一个临时 harness（假 ctx + 真 http，`projectDir` 指向临时目录），覆盖：
  1. 现有全部端点的状态码与关键字段（回归）；
  2. 空书架时所有 `needsBook:true` 的端点 → 409 且不创建任何目录；
  3. `annotations.json` 写成坏 JSON → `GET /bootstrap` **200**（不再是 500），坏文件被改名为 `.corrupt-*`，并出现一条 warn；
  4. 并发 10 次 `POST /annotations` → 10 条都在（不再丢更新）；
  5. 连续写 25 次 → `.backups/_json/` 最多 20 份；
  6. `replaceAll` 空数组无 `force` → 400，有 `force` → 清空。
- 跑完删掉临时目录，`novels/` 里的真数据一个字节都不许改。

## 三、Client 状态重写（负责人：client-state）

### 3.1 未保存正文上提到 page
- page 增加 `draftsRef`（`path → {content, at}`）与 `draftsVersion` 状态。
- Editor 的 `onContentChange` 写入草稿，同时照旧更新 `project.documents`（保持受控）。
- Editor 挂载时**从 page 的草稿初始化自己的 `dirtyRef`**（`initialDrafts` prop），所以卸载重挂不再丢。
- `bootstrap` 拿到新 project 时：**对有草稿的 path，保留草稿内容**（不要用磁盘旧文本覆盖编辑器）。
- 保存成功 → page 清掉该 path 的草稿；保存失败 → 草稿保留。
- Editor 卸载时不再需要自己 flush（保留现有 flush 作为兜底，但不能是唯一路径）。

### 3.2 冲突队列
- `conflict` 单槽改成 `conflicts: []`（数组）＋ `solvedPaths`（Set，记最近解决的 path，用于丢弃迟到 409）。
- 面板永远显示队首；解决一个就 shift，全部解决后关闭。
- 迟到 409：如果 path 在 `solvedPaths` 里且解决时间在 5 秒内 → 直接丢弃（不弹面板）。

### 3.3 验收
- 迷你 hooks 运行时（Babel + 自写 CJS loader，`%TEMP%` 里）覆盖：
  1. 打字 → 卸载 Editor → 重新挂载 → 文字还在；
  2. 打字 → 触发 bootstrap（模拟切模型）→ 编辑器内容不被冲回；
  3. 两个不同 path 先后 409 → 队列里两条，逐个解决；
  4. 解决后 3 秒内同一 path 又来 409 → 不再弹。
- 不跑 `build.mjs`（Lead 统一构建）。

## 四、UI 债务（负责人：ui-tokens）

### 4.1 token 收成一份
- 新建 `src-client/tokens.css`：**唯一一份** `--moshu-*` 定义（全部由 `--dsw-alias-*` 派生）。
- 删掉 `styles.css` / `views.css` / `Editor.css` / `Annotations.css` / `ConflictDialog.css` / `bookmenu.css` 里重复的 token 声明，改成 `require('./tokens.css')` 并在最外层组件渲染一次。
- 结果：整个页面只有一处定义，值不再漂移。

### 4.2 深色主题可见性
- 全仓 `color:#fff` / `color:#ffffff` 改成 `var(--dsw-alias-label-primary-foreground)`（宿主会随主题翻转）。
- `Map.css` 里写死的深色画布 `#14292b` 换成 token 派生；浅色主题下文字必须可读。
- 顺手把 `Timeline.css` 里 22 处硬编码色值换掉。

### 4.3 验收
- `grep -rn "color:\s*#fff" src-client` 必须为 0；
- 每个 CSS 文件里 `--moshu-` 的定义只出现在 `tokens.css`（脚本统计）；
- 语法检查 + 一段离屏渲染冒烟（Page 能挂载，style 标签注入正常）。

## 五、边界

- 不许改 `host/prompts.js`（Lead 所有）。
- 不许改接口形状、文案、交互。
- 三个负责人文件范围互不重叠：host-refactor 只碰 `host/**`；client-state 只碰 `page.jsx` / `Editor.jsx` / `api.js`；ui-tokens 只碰 `*.css` + `tokens.css`。
- 每人都要留一份可重跑的自测脚本思路（脚本本身不要进仓库）。
- Lead 负责：构建、`client.js`、安装、最终验证与回归。
