# AGENTS.md — 本项目的 AI 协作准则

> 📐 CONTRACT · **本文件是本仓库唯一的「协作规范事实来源」（Single Source of Truth）。**
> 不论你用的是 CodeBuddy / Trae / Cursor / GitHub Copilot / Codex / Windsurf / Zed / Cline / Gemini CLI / 其它任何 AI 编程助手，
> **开工前请完整读完本文件**。各工具的专属规则目录（`.trae/rules/`、`.codebuddy/rules/` 等）
> 只放**指向本文件的薄指针**，不放正文 —— 见 §0 与 §7。

---

## 0. 先让本文件在你的工具里生效（Bootstrap，一分钟）

本文件采用行业通用的 `AGENTS.md` 约定（20+ 工具原生支持），但**少数工具的桌面版默认不读**，需要开一次开关。请按下表自查：

| 你的工具 | 是否需要操作 | 怎么做 |
|---|---|---|
| **Trae（桌面版）** | ⚠️ 需要，**开一次开关即可** | 设置 → 规则 → 导入设置 → 打开「**将 AGENTS.md 包含在上下文中**」 |
| **Trae（CLI）** | ✅ 不需要 | 默认读取当前/上级目录的 `AGENTS.md` |
| Cursor / GitHub Copilot / Codex / Windsurf / Zed / RooCode / Cline / Augment / Jules / Gemini CLI / Amp / goose / opencode / Kilo Code / Warp 等 | ✅ 不需要 | 原生自动读取项目根的 `AGENTS.md` |
| **Claude Code** | ⚠️ 需要 | 它只读 `CLAUDE.md`（不读 AGENTS.md）；请在项目根建一个 2 行的 `CLAUDE.md`，内容写成 `@AGENTS.md` 即可（会自动展开引入本文件） |
| Aider | ⚠️ 需要 | 在 `.aider.conf.yml` 加 `read: AGENTS.md` |
| CodeBuddy | ✅ 不需要 | 读 `.codebuddy/rules/*.mdc`（本项目已备薄指针） |

> 🧪 MEASURED：以上“是否需要操作”依据官方文档（agents.md 兼容矩阵；Trae 官方 docs.trae.cn `ide_rules` / `cli_memories`）。
> 若你的工具不在表内：**请自行判断能否读到 `AGENTS.md`**，读不到就在该工具的规则目录（或配置文件）里建一个薄指针，
> 内容一行即可：**「本项目规范以仓库根 `AGENTS.md` 为准，开工前必须先完整阅读」**。
> ⛔ **不要把本文件正文复制过去**——那样一旦规范更新就会出现两个版本互相打架（原因见 §7）。

---

## 1. 项目速览

文昌智融平台（WenChang SmartFusion，仓库名 wczx-AI-Hub）—— 面向教师/学生的 AI 课堂平台。Web 应用，前后端同仓（Next.js App Router）。

| 项 | 值 |
|---|---|
| 技术栈 | Next.js 14（App Router）+ TypeScript + Prisma + SQLite + TDesign |
| 仓库 | GitHub `spiritgs2002-tech/wczx-AI-Hub`（私有，日常开发与发布都在这里；客户端自动升级读取其 `main` 分支的 `public/latest.json`，仓库为私有时自动升级不可用） |
| 主干分支 | `main`（唯一集成与发布主干；开工先同步，再建个人分支，见 §4） |
| 工作分支 | Codex 用 `codex/*`，Claude 用 `claude/*`；测试通过后由指定集成人合并到 `main`，见 §8 |
| 权威协作文档 | `Git协作完整指南.md`（给人看的完整版；本文件是给 AI 看的可执行版） |

---

## 2. 最常用的命令（照抄即可，别自己发明）

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 生产构建（⚠️ 必须先 generate，构建脚本本身不含它）
npx prisma generate && npm run build

# 启动生产服务（本项目固定用 3000 端口，对外监听 0.0.0.0）
npx next start -H 0.0.0.0 -p 3000

# 重启生产服务（先杀干净再起，否则旧进程占端口）
pkill -9 -f next-server

# 类型检查（⚠️ 必做，原因见 §3-③）
npx tsc --noEmit
```

> ⚠️ **长命令/构建请用后台方式跑**（`setsid nohup ... &` 之类），跑完再回来看结果，不要阻塞在一条命令上。

> ⛔ DO NOT RUN `npm run build` IN A DIRECTORY WHERE `npm run dev` IS RUNNING.
> 构建会覆盖同目录的 `.next/`，正在运行的开发服务器随即找不到页面文件（`Cannot find module './xxxx.js'`、静态资源 404），
> 表现为**整站白屏 / 无法登录**（2026-11-12 实际发生：Codex 在用户开发目录 `~/Desktop/wczx-AI-Hub` 验证构建）。
> 需要验证构建时：在另一个检出目录（如 Claude 的 worktree）里跑；或先停掉开发服务器，构建完执行 `rm -rf .next` 再 `npm run dev`。

---

## 3. 硬约束（🛑 必须遵守）

### ① 数据库：默认真库是 `prisma/dev.db`

- `.env.example` 的 `DATABASE_URL="file:./dev.db"` 相对 `prisma/schema.prisma` 所在目录解析，实际为 `prisma/dev.db`。操作前核对本机 `.env`；历史配置可能指向嵌套目录，不能据默认路径覆盖或搬移用户数据。
- **schema 有变更时必须显式执行** `npx prisma db push`（`npm run build` 不会替你做）。本项目已停用 `prisma/migrations/`、`db:migrate` 和 `db:reset`，不得使用 `prisma migrate reset`。
- SQLite 连接由 `src/lib/prisma.ts` 设置 `PRAGMA busy_timeout = 5000`。**不要开启 WAL**：备份/升级仅复制 `dev.db`，无法保留未合并的 WAL 数据。测试时显式覆盖 `DATABASE_URL` 指向独立测试库，并先备份测试库。
- 改动、迁移、清理数据库前**先备份原文件**（`cp prisma/dev.db <备份名>`，路径以已核实的 `DATABASE_URL` 为准）。

> ⛔ DO NOT USE `bash start.sh` —— 它在某些情况下会**初始化出一个空库**，属于本项目的历史地雷。
> 需要启动就用 §2 的 `next start` 命令。

### ② 别把本地环境产物提交进仓库

`.env`、`*.db`、`node_modules/`、`.next/`、构建日志 —— **一律不提交**。凭据只存在于各自本机。

### ③ 🛑 “构建成功” ≠ “没有 bug”

`next.config.mjs` 必须保持 `typescript.ignoreBuildErrors: false`，构建遇到类型错误应失败；ESLint 维持现有配置。
交付前必须单独执行 `npx tsc --noEmit`，要求 **0 错误**，并通过 `npx prisma generate && npm run build`。

<!-- MUST KEEP TYPE CHECKS ENABLED: 以前忽略错误会让“构建成功”掩盖类型缺陷；0 错误是交付契约。 -->
<!-- 🔗 RELATED: next.config.mjs typescript；package.json build。⛔ DO NOT REVERT: 修复错误，禁止重新开启 ignoreBuildErrors。 -->

### ④ 列表接口瘦身契约（🛑 别把字段加回去）

`GET /api/tasks`（课堂列表）**故意不下发提示词正文**（`systemPrompt` / `analysisPrompt` / `classAnalysisPrompt` / `designPrompt` / `aiCompanionPrompt`）与探究 HTML 正文，
打开编辑弹窗时再由前端按需拉详情补齐。

> ⛔ DO NOT ADD THESE FIELDS BACK TO THE LIST API.
> 历史教训：早年为减小列表体积曾剥掉这些字段，但没有配套“编辑时按需拉取”，
> 后来有人为了修「编辑时看不到已填提示词」**直接把字段加回了列表**，性能优化静默消失，几个月后表现为“页面刷新很慢”。
> 正确做法是**补详情接口 + 前端按需拉取**，不是把大字段加回列表。

相关实现（改动时这几处是一套，**改一处要一起看**）：

- `src/app/api/tasks/route.ts` —— 列表 GET / POST 的 `select`（瘦身点）
- `src/app/api/tasks/[taskId]/route.ts` —— `?lite=1`（不带探究 HTML）；**不带 lite 时必须保持原行为**
- `src/app/api/preset-conversations/[presetConversationId]/route.ts` —— 单个对话活动的 GET
- `src/app/teacher/tasks/page.tsx` —— 各编辑入口“**先拉详情、再进编辑态**”，拉取失败**不要**带着空值进编辑器

### ⑤ 接口鉴权口径

前端请求用户态数据时带 **`Authorization: Bearer <token>`**（本仓库主口径）。
`x-auth-token` 只是历史兼容回退，**新增代码不要再引入新的鉴权头写法**，保持一种。

---

## 4. 开工前先同步 main（🛑 AI 必须执行）

<!-- MUST SYNC MAIN FIRST: 单仓库以 main 集成，过期基线会造成冲突；每个任务在独立分支修改。 -->
<!-- 🔗 RELATED: §1、§6、§8 与 Git协作完整指南.md。⛔ DO NOT REVERT: 不恢复共享 dev 或多远程发布流程。 -->

### ① 开工第一步永远是拉最新

先确认当前目录、分支与工作区；有未提交内容时保留原样，不要为切分支丢弃工作。
Codex 在 `~/Desktop/wczx-AI-Hub`，Claude 在 `~/Desktop/wczx-AI-Hub-claude`（worktree）。

```bash
git status
# 在干净的 main 上同步，再建立本次工作分支（Codex 示例）
git switch main
git pull origin main
git switch -c codex/任务名
```

Claude worktree 从已同步的 `origin/main` 建立 `claude/任务名`，不得与主目录检出同一分支。
任务卡已指定分支时按任务卡执行；禁止在 `main` 上直接开发。

### ② 动手前先看目标文件最近谁在改

```bash
git log --oneline -5 -- <要改的文件>
```

- 若合作者最近 1~2 天内提交且改动可能重叠，先向用户说明，沟通或拆分文件归属。
- 按 §8 与任务卡文件清单分工；需要修改边界外文件时先停下并告诉用户。

### ③ 同步与冲突处理

集成前先更新 `origin/main`，在自己的工作分支合并最新主干并处理冲突。推送仅在任务已授权时执行；被拒先拉取对应远程分支并理解差异，禁止强推。

| 原则 | 说明 |
|---|---|
| 合并两边 | 功能互不影响的改动都保留 |
| 取正确版 | 理解两边意图，保留语义正确的一版或融合实现 |
| 拿不准就停 | 把冲突块交给用户确认，不静默丢失改动 |

> ⛔ DO NOT FORCE PUSH —— 禁止强推；仅用户明确批准的历史清理例外。
> ⛔ DO NOT DISCARD —— 禁止用 `git checkout -- .` / `git reset --hard` 清工作区或掩盖冲突。
> 禁止直接删掉对方的改动行来“解决”冲突，必须逐块读懂。

### ④ 解完冲突必须重新验证

```bash
npx tsc --noEmit
npx prisma generate && npm run build
git add <解决的文件>
git commit
```

测试通过后把提交交给指定集成人；是否推送、合并、发布以当前任务授权为准。

---

## 5. 代码注释规范：凡改过的代码都要留「护栏注释」

> 普通注释写给旁边的人看；**护栏注释写给“下一个打算改这里的人（或 AI）”看**。
> 判断标准只有一条：**明天一个完全不认识这段代码的 AI 来改它，光看注释会不会做出正确的决定？**

只要是你**检查过或修改过**的代码，就要按四段式补注释：

| 段 | 内容 |
|---|---|
| **为什么** | 这段代码为什么长这样（最好带实测数字） |
| **现状/约束** | 现在的行为边界（哪些必须保持不变） |
| **🔗 关联** | 改这里要**同步改哪几处**（列文件路径 + 位置） |
| **⛔ 别回退 + 维护** | 为什么不能改回旧写法、历史教训、以后该怎么做 |

**标记词表**（统一使用，便于 grep 巡检）：

| 标记 | 含义 |
|---|---|
| `⛔ DO NOT REVERT` | 禁止改回旧写法 / 禁止加回被剥离的东西 |
| `📐 CONTRACT` | 接口 / 数据形状契约（谁依赖它、破约后果） |
| `⚠️ GOTCHA` | 反直觉的坑（写法必须如此） |
| `🧪 MEASURED` | 实测数字及其来源 |
| `🔗 RELATED` | 关联点清单 |
| `📌 TODO(yyyy-mm-dd)` | 未完成的决定（触发条件 + 负责人）；**禁止裸 `TODO`** |

**四条硬要求**：

1. **英文祈使句在前**：`DO NOT REVERT` / `DO NOT ADD ... BACK` / `MUST STAY IN SYNC` —— 对能力较弱的模型约束力更强，中文解释负责说服人。
2. **必须写在注释行内**（写在字符串、提示词模板、`echo` 文案里的标记不算）。
3. **自包含**：别只写“见 PR #xx”，后人不一定去翻。
4. **注释与代码同一次提交**（过期注释比没注释更危险）。

---

## 6. 提交与分支约定

- **单仓库**：唯一远程为 GitHub `spiritgs2002-tech/wczx-AI-Hub`（`origin`），`main` 是唯一集成与发布主干。
- **独立工作分支**：Codex 用 `codex/*`，Claude 用 `claude/*`；完成检查后由任务指定的集成人统一合并到 `main`。
- **不直接推 main**：禁止在主干直接开发；没有明确授权时只做本地提交，不推送、不合并。
- `public/latest.json` 的 `version` 与发布配套更新；客户端读取 `main`，但私有仓库无法供未授权客户端自动升级，不能只改版本号就声称升级可用。
- 一个提交一件事；提交信息写清“**做了什么 + 为什么**”。
- 提交前检查差异与暂存区；交付时 `git status` 干净，禁止混入 `.env` / `*.db` / 构建产物。
- 提交信息规范见 `.trae/rules/git-commit-message.md`。
- 禁止 force push，用户明确批准的历史清理除外。

---

## 7. 关于“规范写在哪”（给后来维护者）

本仓库的规范载体设计原则是 **内容唯一、入口轻薄**：

```
AGENTS.md                      ← 唯一事实来源（跨 20+ 工具，本文件）
├── .trae/rules/*.md           ← 薄指针（Trae 项目规则目录）
├── .codebuddy/rules/*.mdc     ← 薄指针（CodeBuddy，平铺 .mdc）
└── CLAUDE.md（如需要）         ← 薄指针（Claude Code）
```

> ⛔ DO NOT COPY THE BODY INTO TOOL-SPECIFIC RULE FILES.
> 各工具的入口文件里**只写“去读 AGENTS.md”**，不写正文。
> 原因：正文一旦复制成多份，规范更新时必然漂移，出现“哪个版本才算数”的混乱。
> 新增一种工具的入口 = 加一个 3 行的指针文件，**而不是再抄一遍规范**。


---

## 8. AI 协作分工

<!-- MUST RESPECT FILE OWNERSHIP: 两个工作目录共享同一 Git 仓库，worktree 只隔离工作区；跨文件重叠仍会冲突。 -->
<!-- 📐 CONTRACT: 以当前任务卡的文件清单为本次分工，改边界外文件前先停下告诉用户。 -->
<!-- 🔗 RELATED: §4、§6 与 Git协作完整指南.md；路径和分支约定必须同步维护。 -->
<!-- ⛔ DO NOT FORCE PUSH: 不修改对方负责的文件、不覆盖提交；只有用户明确批准的历史清理可以例外。 -->

| AI | 工作目录 | 分支 |
|---|---|---|
| Codex | `~/Desktop/wczx-AI-Hub` | `codex/*` |
| Claude | `~/Desktop/wczx-AI-Hub-claude`（worktree） | `claude/*` |

- 按文件归属分工，不改对方负责的文件；任务卡的明确例外优先。
- 不在对方工作目录运行编辑、切分支或清理操作；两个目录不能同时检出同一分支。
- 各自完成本地提交与验证，统一集成由用户或任务指定的人负责；本任务由 Claude 统一合并。
- 禁止 force push（经用户明确批准的历史清理除外），禁止丢弃对方改动。
