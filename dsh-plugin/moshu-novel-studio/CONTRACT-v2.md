# 墨枢插件 · 施工契约 v2

v1 的规则继续有效（CJS+JSX、只 require react 与相对路径、样式挂 `.moshu-root`、颜色只用 `--dsw-alias-*`）。
本文件只写**这一轮新增/变更**的部分。开工前先读 `CONTRACT.md` 和本文件。

## 本轮目标（用户原话翻译成可实现项）

1. 切书 / 新书 / 改名 / 删除（进回收站，不真删）。
2. 页面内自己切模型（不用去 DSH 设置里改）。
3. AI 不再只有"预设能力"：一个 **AI 工作台**，能选对象、写自己的指令、挑上下文、拿到结果并落回具体对象。
4. 提示词统一收口在 `host/prompts.js`（已由 Lead 写好，**别人不许改**），核心是**禁止续写/代写正文**。
5. 设置页：作者能自己调模型、审阅强度、上下文预算、自动保存、字号字体、导出格式、语言。
6. 修掉上一轮遗留的硬伤：章节不能新建/改名/删除/排序，有 `.backups` 但没有恢复界面。

## 文件归属（严格，别越界）

| 负责人 | 文件 |
|---|---|
| host-api-2 | `host/**`（**除 `host/prompts.js`，那个归 Lead，只准 import**）、`index.js` 只在必要时改 |
| ui-shell-2 | `src-client/page.jsx`、`api.js`、`strings.js`、`styles.css`、`src-client/shell/BookMenu.jsx`、`src-client/shell/ModelMenu.jsx` |
| ui-studio | `src-client/shell/AiStudio.jsx`、`src-client/shell/SettingsView.jsx`、`src-client/shell/studio.css` |
| ui-editor | `src-client/components/Editor.jsx`、`src-client/components/Editor.css`、`src-client/components/BackupsPanel.jsx`（新建） |

Lead 负责：`host/prompts.js`、`build.mjs`、`package.json`、契约、集成、验收。

## 新增 HTTP 端点（全部在 `/api/moshu` 下）

失败一律 4xx/5xx + `{ error: '中文原因' }`。

### 书籍
| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/books` | – | `{ projectDir, current: BookRef, books: BookRef[] }` |
| POST | `/books` | `{ name }` | `{ ok:true, book: BookRef, books: BookRef[] }` ← 建目录+骨架，并**切过去** |
| POST | `/books/select` | `{ id }` | `{ ok:true, book: BookRef }` |
| POST | `/books/rename` | `{ id, name }` | `{ ok:true, book, books }` |
| POST | `/books/trash` | `{ id }` | `{ ok:true, books }` ← 移到 `novels/.trash/<id>-<时间戳>/`，**永不物理删除** |

`BookRef = { id, name, title, path, chapters, words, updatedAt }`
- `id` = 目录名；`name` = 目录名；`title` = `project.md` 的一级标题（取不到就用 name）。
- `chapters` = 章节数，`words` = 章节正文字数（去空白）。
- 新建书的 `name` 必须校验：1–40 字，不能含 `\/:*?"<>|`、不能是 `.`/`..`、不能已存在。
- 切换书籍 = 写 `.moshu/settings.json` 的 `novelDir`。

### 模型
| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/models` | – | `{ current:{provider,model}, providers:[{id,name,models:[{id,name}]}], message? }` |
| POST | `/models` | `{ provider, model }` | `{ ok:true, current }` ← 写 settings |

- `providers` 用 `ctx.llm.listProviders()` + `ctx.llm.listModels(id)`；**某个 provider 的 listModels 失败就跳过它**，不要整个请求 500。
- 没有 `ctx.llm` 时返回 `{ current, providers: [], message: '宿主没有提供 llm 服务' }`，HTTP 200。

### 设置
| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/settings` | – | `{ settings, defaults, ranges, editable:[键名] }` |
| POST | `/settings` | `{ patch }` | `{ ok:true, settings }` |

`s settings` 完整字段与默认值（**未知键一律 400**，值超范围一律 400）：

| 键 | 类型 | 默认 | 范围/说明 |
|---|---|---|---|
| `provider` | string | 宿主默认 | 模型通道 |
| `model` | string | 宿主默认 | 模型 id |
| `novelDir` | string | `雾隐之城` | 当前作品目录名 |
| `reviewFocus` | string | `检查剧情因果、人物动机、前后逻辑、设定冲突和语言表达。` | ≤300 字 |
| `maxAnnotations` | number | 8 | 1–20 |
| `allowRewriteSuggestion` | boolean | false | 开启后批注 suggestion 可含 ≤40 字示范片段 |
| `autosaveDelayMs` | number | 1600 | 600–6000 |
| `backupKeep` | number | 30 | 0–200，每文档保留份数，0=不清理 |
| `editorFontSize` | number | 15 | 13–22 |
| `editorSerif` | boolean | true | 正文衬线 |
| `lineNumbers` | boolean | true | 默认显示行号 |
| `contextRelatedDocs` | number | 4 | 0–8，AI 附带的相关资料条数 |
| `contextMemories` | number | 10 | 0–30，AI 附带的记忆条数 |
| `language` | string | `zh` | `zh` \| `en` |
| `exportFormat` | string | `md` | `md` \| `txt` |

### AI
| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/ai/recipes` | – | `{ recipes: RECIPES }`（直接返回 `prompts.js` 的 `RECIPES`） |
| POST | `/ai/run` | 见下 | 见下 |

`POST /ai/run` 请求体：
```json
{
  "recipeId": "chapter-audit",
  "targetPath": "chapters/chapter-001.md",   // 可空（"整本视角"任务）
  "instruction": "多看看时间线",              // 可空
  "contextIds": ["characters/lin.md"],       // 额外勾选的资料，可空
  "maxAnnotations": 8                         // 仅 review 模式有意义
}
```

响应：
```json
{
  "ok": true,
  "taskId": "...",
  "recipeId": "chapter-audit",
  "mode": "review",
  "output": "annotations",          // annotations | markdown | memory
  "annotations": [...],             // output=annotations 时，已锚定（quote 能在正文里找到）
  "text": "…",                      // output=markdown 时
  "memories": [...],                // output=memory 时：[{title,content,category}]
  "elapsedMs": 51234,
  "dropped": 2                      // 锚定失败被丢弃的条数（review 模式）
}
```

**`/ai/run` 只计算、不落盘。** 结果由前端确认后，分别调用既有端点写回：
批注 → `POST /annotations`；记忆 → `POST /memory`；文档 → `POST|PUT /document`。
（Host 只在 `tasks.json` 追加一条执行记录，这是唯一的副作用。）

实现要点：
- 必须 `import { RECIPES, buildRequest, guardInstruction, findRecipe, AI_TIMEOUT_MS } from './prompts.js'`，**所有提示词都从那里取**。
- 先 `guardInstruction(instruction)`，越界直接 400（不调模型）。
- `target: 'novel'` 的卡片（线索台账/时间线）：`targetPath` 为空时，正文上下文取前 3 章拼接（每章截断 1800 字）。
- 上下文组装：目标文档 + `contextIds` 指定文档 + `settings.contextRelatedDocs` 条自动相关资料 + `settings.contextMemories` 条记忆（优先 locked）。
- review 模式复用 `review.js` 的 `parseReviewAnnotations` / `locateQuote`，`dropped` 要如实返回。
- 模型不可用 → 503 + 真实原因（沿用现有 `/status` 的口径）。

### 备份与文档管理
| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/backups?path=chapters/chapter-001.md` | – | `{ path, entries:[{ id, at, bytes }] }` |
| POST | `/backups/restore` | `{ path, id }` | `{ ok:true, content }` ← 恢复前先把当前内容另存一份备份 |
| POST | `/document/rename` | `{ from, to }`（to 是完整相对路径） | `{ ok:true, path }` |
| POST | `/document/delete` | `{ path }` | `{ ok:true }` ← 移到 `<作品>/.trash/`，不物理删除 |
| POST | `/document/move` | `{ path, direction:'up'\|'down' }` | `{ ok:true, paths:[...] }` ← 交换相邻章节的序号前缀 |

- `backupKeep > 0` 时，每次写入后按份数清理旧备份（新的在前）。
- `/document/move` 只对 `chapters/` 下的 `chapter-NNN.md` 生效，其余 400；两步重命名都要走原子写。

## Client 侧契约

### `src-client/api.js` 新增（ui-shell-2）
```js
getBooks, createBook, selectBook, renameBook, trashBook,
getModels, setModel,
getSettings, saveSettings,
getRecipes, runAi,
getBackups, restoreBackup,
renameDocument, deleteDocument, moveDocument
```
（都返回解析后的 JSON；失败抛 `Error(message)`，与现有 `request` 一致。）

### 组件与 props（**名字和形状不能改**）

```js
// src-client/shell/BookMenu.jsx
module.exports = { BookMenu }
// <BookMenu books={BookRef[]} current={BookRef|null} busy={bool}
//           onSelect(id) onCreate(name) onRename(id,name) onTrash(id) onClose() />
// 自带弹层与新建/改名/删除确认；空书名、重名由它自己在前端先挡一次

// src-client/shell/ModelMenu.jsx
module.exports = { ModelMenu }
// <ModelMenu current={{provider,model}} providers={[{id,name,models:[{id,name}]}]}
//            message={string|undefined} busy={bool}
//            onSelect(provider, model) onRefresh() onClose() />

// src-client/shell/AiStudio.jsx
module.exports = { AiStudio }
// <AiStudio project={Project} settings={Settings} onRefresh={()=>void} notify={(msg)=>void} />
// 自带：任务卡列表 / 目标对象选择 / 指令输入 / 上下文勾选 / 运行 / 结果展示 / 应用回写

// src-client/shell/SettingsView.jsx
module.exports = { SettingsView }
// <SettingsView settings={Settings} meta={{defaults,ranges,editable}} models={{current,providers}}
//               onSave(patch)=>Promise<void> onModelSelect(provider,model)=>Promise<void> notify={(msg)=>void} />

// src-client/components/BackupsPanel.jsx
module.exports = { BackupsPanel }
// <BackupsPanel path={string} onRestore(content)=>void onClose() />
// 自己调 api.getBackups / api.restoreBackup
```

```js
// src-client/components/Editor.jsx（在原有 props 上新增两个）
// 新增：settings={Settings}  onDocumentsChanged={()=>void}
// 新增行为：新建章节 / 重命名 / 删除 / 上移下移 / 备份历史按钮
// settings 影响：autosaveDelayMs、editorFontSize、editorSerif、lineNumbers 初始值、
//               reviewFocus 作为审阅输入框初始值、maxAnnotations 传给 aiReview
```

### page.jsx 的新职责（ui-shell-2）
- 状态新增：`books`、`bookMenuOpen`、`modelMenuOpen`、`models`、`settings`。
- 视图新增两个 tab：`ai`（AI 工作台）、`settings`（设置），放在最后。
- 顶栏加"当前书籍"按钮（书名 + 章节数），点击开 `BookMenu`；模型状态那个胶囊改成可点，点开 `ModelMenu`。
- 启动时 `getBooks()` + `getSettings()` + `getModels()`；切书后重新 `bootstrap` 并重置 `chapterId`。
- `settings.language` → `strings.setLocale(...)`；`notify` 沿用现有 toast。
- 统计区/状态栏改为反映当前书籍。

## 验收口径（Lead 执行）

1. `node dsh-plugin/build.mjs` 通过。
2. Host：假 ctx + 真 http server 跑通全部新端点（含越界指令 400、未知设置键 400、备份恢复）。
3. 浏览器：新书 → 切书 → 改设置 → 用一张任务卡跑真实模型 → 结果能应用回批注/记忆/文档。
4. 明令：**任何路径都不产出正文**。`guardInstruction` 命中续写类要求必须 400。
