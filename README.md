# 墨枢 · DSH 小说工作台

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5%2B-blue.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh-harness)

**一个给「人写小说」用的 AI 辅助工具。**

墨枢不是"AI 帮你续写小说"的生成器。它假设**作者本人有想法、要自己写**，而 AI 负责那些真正耗人的杂活：
把散落在正文里的设定整理成档案、检查前后矛盾、维护时间线与世界地图、提醒你哪一章还没写章纲。

> 一句话：**笔在你手里，AI 负责记性和校对。**
> 它不会替你产出下一段、下一章、后续情节——这是设计上的硬边界，不是能力不足。

## 定位：辅助创作，而不是代笔

| 不做 | 做 |
|---|---|
| ❌ 续写、代写正文、生成下一章 | ✅ 读完你写的正文，整理人物 / 地点 / 势力 / 世界观档案 |
| ❌ 替你决定情节走向 | ✅ 检查前后矛盾、术语不一致、时间线错位，指出问题在哪一章哪一句 |
| ❌ 把整本书变成一堆模板文字 | ✅ 维护横向泳道时间线（明线/暗线/剧情网）、六层世界地图、章纲结构 |
| ❌ 静默改动你的稿子 | ✅ 任何正文改动**必须你点同意**；资料区写删免审批，但只写书里真实存在的事实 |
| ❌ 让你在十几个工具之间倒腾资料 | ✅ 一个页面里管正文、大纲、资料、地图、时间线、记忆、任务 |

设计上的三条底线：

1. **正文归作者**。AI 只能通过 `novel_edit_chapter` 改正文，每次都要审批；一次改多章走批量接口，**也只问一次**。
2. **不编设定**。正文没写的，资料里写「正文未提及」，不许脑补。
3. **不写过程说明**。文档里只留书里的事实，不写「本次整理新增」这类变更日志。

## 形态

一个跑在 DSH（DeepSeekRuntime）Web 里的**整页插件**：在对话里点「墨枢」标签进入工作台（全屏浮层），
左边写正文，右边让 AI 管资料。**没有独立服务**——后端跑在 DSH 进程里（`/api/moshu/*`），
模型直接走 DSH 的 `ctx.llm`，不另开 Express/Vite，也不需要粘贴 token。

## 安装

**要求**：DSH（DeepSeekRuntime）`0.2.1-rc.4` 或更高；能打开 DSH Web GUI。

1. `git clone https://github.com/MIOReverie/dsh-novel-studio.git`（或下载 Releases 里的 zip）。
2. 把 `dsh-plugin/moshu-novel-studio` 整个目录放到你的 DSH profile 的 `node_modules/` 下，
   路径保持 `node_modules/@local/moshu-novel-studio`（或改成你自己的作用域名，
   同时改该目录 `package.json` 的 `name` 与 `cordis.patch.yml` 里的 `name`，两处必须一致）。
3. 在该 profile 的 `cordis.patch.yml` 里加入插件行——内容就是本仓库
   `dsh-plugin/moshu-novel-studio/cordis.patch.yml` 里的 `insert` 段（插件自身 + 创作模式 preset）。
4. **重启 DSH**，左侧栏出现「墨枢」图标即可。

客户端产物 `client.js` 已随仓库提交，**不需要先构建**。想自己改源码再构建：

```bash
npm install          # 只装 @babel/core 与 preset-react
npm run build:plugin # 重新生成 dsh-plugin/moshu-novel-studio/client.js
```

> 发布到 npm 时把占位名 `@local/moshu-novel-studio` 改成 `dsh-novel-studio`
> （`package.json` 与 `cordis.patch.yml` 两处），再 `npm publish`。

## 目录

```
dsh-plugin/
  build.mjs                 把 src-client 打成 client.js（Babel + 迷你模块运行时）
  moshu-novel-studio/
    package.json            bundle 清单（dsh.bundle.patch + dsh.client）
    cordis.patch.yml        插入插件行
    index.js                Host 半入口（apply + webServer 路由）
    host/                   路由、存储、书籍、备份、设置、AI 编排、提示词
    src-client/             Client 半源码（CJS + JSX）
    client.js               ★ 构建产物，不要手改
    locale/ icon.svg
novels/<书名>/              作品数据（Markdown 是权威源）
.moshu/settings.json        本机配置：当前作品、模型通道
legacy-web/                 旧的独立 Web 应用（Vite + Express），已停用，可随时删除
```

## 常用命令

```bash
npm run build:plugin     # 改完 src-client 后重建 client.js
npm run check:plugin     # 产物语法检查
```

- **只改前端**：`npm run build:plugin` → 刷新 DSH 页面。
- **改了 Host 半（`index.js` / `host/**`）**：**必须重启 DSH**（插件后端不热重载）。
- **安装/更新插件**：`plugin_manager` → `install_bundle`，目标 `F:\代码\AI辅助小说平台\dsh-plugin\moshu-novel-studio`。

## 功能

- **作品**：新建 / 切换 / 改名 / 移到回收站 / 彻底删除；回收站可恢复、可清空。
- **写作**：Markdown 正文、行号、阅读预览、自动保存（可调延迟）、版本历史与恢复。
- **Markdown 渲染**：标题 / 粗斜体 / 删除线 / 行内代码 / 链接 / 图片 / 有序无序（含嵌套与任务列表）/ 引用 / 分隔线 / **表格（含对齐）** / **围栏代码块** 全部渲染；连续的普通行合成同一个段落（不再一行一段），资料页与编辑器预览共用同一套解析。
- **章节**：新建 / 改名 / 上移下移 / 删除。
- **世界地图**：全数据驱动（陆地多边形 / 山脉森林图章 / 河流路线折线 / 地点图钉），可自由绘制与编辑；AI 有 8 个地图工具（读、整份重画、加/改陆地、钉地点、盖山脉森林、画河流路线、删对象），地图页有「让 AI 画」入口。
- **对话里的工作台**：主区 tab 栏（对话/轨迹/上下文/网页预览）里多一个「墨枢」，看稿与对话同窗口切换。
- **创作模式（AI）**：DSH 的 agent preset，与内置「标准模式」并列，挂 9 个小说工具。资料区 AI 直接管理；改 `chapters/` 正文必须经你审批；工具调用在 Harness 对话里用专用卡片显示（改稿卡会标「需要你同意」）。
- **AI 边界**：只做批注与整理，**不续写、不改写正文**。
- **时间线**：横向泳道视图，多条剧情线并排、明线/暗线区分、事件之间连成剧情网（因果/影响/伏笔）；AI 能从正文里**提取**事件，而不是按章节编号编造。
- **地图**：六层（陆地/地貌面/图章/折线/地点/装饰）全部可由 AI 绘制；地貌是**上色的面**，面内自动铺满对应符号，颜色自动裁到陆地轮廓内；AI 还能自己画 24×24 的 SVG 素材贴到地图上，前端 3 秒内自动出现。
- **批量改稿**：一次改多章只弹**一次**审批（`novel_chapter_batch`），先全量校验再请求授权，拒绝则一个字节都不写。
- **设置**：模型、审阅重点、批注上限、上下文预算、自动保存、字号字体行号、备份份数、语言。

## 数据与安全

- **仓库里没有任何作品数据**：`.moshu/`（会话书库与本机配置）和 `novels/` 都在 `.gitignore` 里。
- 插件本身不联网：模型调用走 DSH 的 `ctx.llm`，不读取也不外发你的书稿。

- 作品数据在 `<工作区>/.moshu/novels/<书名>/`，删除先进同名目录下的 `.trash/`，彻底删除才会真正移除。
- 数据目录可在「设置 → 数据」里改（默认 `~/.dsh-moshu`，与 DSH 的工作区无关时用它兜底）。
- 每次保存前备份到 `.backups/<相对路径>/`，可在编辑器「历史」里恢复。
- 保存带乐观锁：磁盘被别人改过会弹冲突面板，不会静默覆盖。
- 所有写请求带作品身份（`X-Moshu-Host: bookId`），切书瞬间的旧请求不会写进新书。
- `/api/moshu/*` 只接受本机回环来源，拒绝跨站。

## 验证

插件里有三份可复用的验收脚本思路：Host 用「假 ctx + 真 http server」，Client 用「Babel + 自写 CJS loader + 迷你 hooks 运行时」离屏渲染。历史审计报告见 `dsh-plugin/审计报告-2026-10-30.md`。

## 数据隔离

- **一个工作区一本小说**：作品统一存在 `<工作区>/.moshu/novels/<书名>/`，
  同一个工作区的不同对话看到的是同一批书（换对话不用重新找书）。
  「当前作品」这类界面状态仍是每个对话一份（`.moshu/scopes/<sessionId>/settings.json`）。
  升级前散在 `novels/` 与 `.moshu/scopes/*/novels/` 的书，第一次访问时会自动**复制**到新位置（同名加来源后缀，原件保留）。
- **共享库**：侧边栏面板用的是 `<project>/novels/`（升级前的书都在这里）。
  会话书架为空时会列出共享库的书，可一键**复制**进来（原件保留）。
- **新建作品默认是空的**：只有 `project.md` + 空地图 + 空的批注/任务/记忆。
  想看示例要显式传 `sample: true`。
