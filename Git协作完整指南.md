# wczx-AI-Hub Git 协作完整指南

本指南说明当前单仓库、main 主干与 AI worktree 协作流程。协作规范以根目录 [AGENTS.md](AGENTS.md) 为唯一事实来源；任务卡的明确授权与文件边界优先。

<!-- MUST KEEP THE MAIN WORKFLOW IN SYNC: 旧多仓库/dev 流程已停用，继续使用会同步到错误的分支。 -->
<!-- 📐 CONTRACT: origin 是唯一仓库；工作分支验证后由指定集成人进入 main。 -->
<!-- 🔗 RELATED: AGENTS.md §1/§4/§6/§8；readme.md 工程维护说明。 -->
<!-- ⛔ DO NOT REVERT: 不恢复 private/dev、Gitee 或 github-release 的多远程发布指令；改流程须同步上述文档。 -->

## 一、仓库与分支

| 项目 | 当前约定 |
|---|---|
| 唯一仓库 | `https://github.com/spiritgs2002-tech/wczx-AI-Hub.git`（私有） |
| 远程名称 | `origin` |
| 集成与发布主干 | `main` |
| Codex 工作分支 | `codex/*` |
| Claude 工作分支 | `claude/*` |

不在 main 上直接开发，不再使用共享 dev 主干、私有开发远程或国内/国际双仓库同步流程。客户端升级检查读取 main 的 `public/latest.json`；仓库私有时，未授权客户端无法直接读取，自动升级不可用。

## 二、工作目录与文件分工

| 执行者 | 目录 | 说明 |
|---|---|---|
| Codex | `~/Desktop/wczx-AI-Hub` | 主工作目录，只使用 `codex/*` 工作分支 |
| Claude | `~/Desktop/wczx-AI-Hub-claude` | 同仓库 worktree，只使用 `claude/*` 工作分支 |

worktree 共享对象库、分支和提交，但文件工作区独立。不要在对方目录编辑、清理或切换分支，也不要让两个目录同时检出同一分支。

每次任务按文件清单分工，不修改另一方负责的文件。需要越界时先停下告诉用户；任务卡列出的明确例外按例外执行。Codex 的工程加固提交由 Claude 统一集成，Codex 不推送、不合并 main。

## 三、开工与日常提交

### 命令行（Codex 示例）

```bash
cd ~/Desktop/wczx-AI-Hub
git status
# 只有工作区干净时才切换；保留已有未提交工作
git switch main
git pull origin main
git switch -c codex/任务名
git log --oneline -5 -- <目标文件>
```

先完整阅读 AGENTS.md，再按文件归属修改。合作者刚修改同一文件时，先说明重叠风险并拆分区域。已有任务分支时继续该分支，不要反复创建。

Claude 在自己的 worktree 中从已同步的 `origin/main` 创建 `claude/任务名`，不要在 Codex 目录中切分支。首次建立 worktree 由项目负责人安排，已有目录不重复初始化。

完成一个独立事项后：

```bash
npx tsc --noEmit
npx prisma generate && npm run build
git diff --check
git diff -- <本次负责文件>
git add <本次负责文件>
git diff --cached --stat
git commit -m "fix: 说明做了什么以及为什么"
git status
```

只暂存本次负责文件。`.env`、数据库、node_modules、.next 和日志不得提交。代码与 §5 护栏注释同一提交，提交信息一件事一个。

### Trae / VS Code 图形界面

1. 打开自己的工作目录，源代码管理面板确认无未提交改动。
2. 切到 main，从 origin/main 拉取，再新建对应前缀的任务分支。
3. 修改后逐个检查差异，只暂存本次文件；在终端完成类型检查和构建。
4. 填写说明并本地提交；当前任务没有推送授权时不要点击“同步更改”或“推送”。

Trae 桌面版需在设置 → 规则 → 导入设置中启用“将 AGENTS.md 包含在上下文中”。其他工具的入口见 AGENTS.md §0。

## 四、同步、冲突与集成

集成人合并前先检查各分支提交与文件归属，获取最新 origin/main。任务分支需要更新基线时，在自己的分支合并 origin/main；冲突必须逐块理解两边意图，保留互不影响的功能。

- 拿不准的冲突交给用户确认，不通过删对方代码消除冲突。
- 禁止 `git reset --hard`、`git checkout -- .` 丢弃工作。
- 禁止 force push；仅用户明确批准的历史清理例外。
- 如果已获推送授权而推送被拒，先拉取对应远程分支，处理差异后重新验证，不能强推。
- 解冲突后再次执行 tsc（0 错误）和生产构建，再提交。

集成由用户或任务指定的人执行。Codex 交付分支名、各提交说明、检查结果和剩余风险；本次由 Claude 在自己的目录统一合并。发布到 main 是独立授权动作，不因本地提交而自动执行。

## 五、数据库与构建

<!-- MUST BACK UP THE RESOLVED DATABASE: DATABASE_URL 相对 schema 目录解析，错误路径可能创建空库。 -->
<!-- 📐 CONTRACT: 默认 prisma/dev.db；只用 db push 更新，不启用 WAL。 -->
<!-- 🔗 RELATED: .env.example、prisma/schema.prisma、src/lib/prisma.ts、AGENTS.md §3。 -->
<!-- ⛔ DO NOT REVERT: 禁止 start.sh 初始化、migrate reset 或仅靠 build 更新 schema；先核对并备份实际文件。 -->

`.env.example` 使用 `DATABASE_URL="file:./dev.db"`，相对 `prisma/schema.prisma`，默认实际文件为 `prisma/dev.db`。核对本机 `.env` 后再操作；历史环境可能指向嵌套路径，不自动搬移或覆盖已有数据。

```bash
# 仅在已确认默认路径、并获准操作目标库时执行；先备份
cp prisma/dev.db prisma/dev.db.backup-$(date +%Y%m%d-%H%M%S)
npx prisma db push
npx prisma generate
```

不提交备份。迁移目录与 `db:migrate` / `db:reset` 脚本已停用；不运行 `prisma migrate reset`。测试显式设置独立的 DATABASE_URL，并备份测试库后运行 db push，禁止对用户真库做验证写入。

SQLite 初始化设置 `busy_timeout = 5000`。禁止开启 WAL，因为当前升级/备份仅复制 dev.db。不要运行 `bash start.sh`；生产启动使用 `npx next start -H 0.0.0.0 -p 3000`。

`next.config.mjs` 的 `typescript.ignoreBuildErrors` 必须为 false；交付必须单独运行 `npx tsc --noEmit`，要求 0 错误，并通过 `npx prisma generate && npm run build`。长构建后台运行后检查退出码和日志，不能把任务已启动当作通过。

## 六、交付核对

- 分支与文件归属正确，main 未被直接修改或推送。
- 每个提交职责单一，护栏注释与实现同步。
- tsc 0 错误、Prisma generate 和 build 成功；schema 修改已在备份后的独立测试库验证。
- 官方源审计 `npm audit --omit=dev --registry=https://registry.npmjs.org`，报告实际剩余漏洞，不用 force 自动升级大版本。
- 工作区干净，暂存区与提交中没有凭据、数据库或构建产物。
- 推送、合并与发布均依照本次任务授权；当前工程加固任务只本地提交。

---

## 附录：AI 协作规范写在哪（多工具通用）

AI 编程助手会「自动读」的规则文件，各工具互不相同。若为每种工具都维护一份规范全文，必然出现**多版本漂移**——改了一份、忘另一份，最后没人知道哪份算数。

本仓库采用 **「内容唯一、入口轻薄」**：

```
AGENTS.md                            ← 规范正文（唯一事实来源），跨工具通用
├── .trae/rules/pr-sync-guard.md         ← 薄指针：只写「去读 AGENTS.md」
├── .codebuddy/rules/pr-sync-guard.mdc   ← 薄指针
└──（未来新增工具）                       ← 再加一个 3 行的指针，不抄正文
```

**为什么选 `AGENTS.md`**：它是当前跨工具的事实标准，20+ 工具原生读取（Cursor、GitHub Copilot、Codex、Windsurf、Zed、RooCode、Cline、Gemini CLI、Jules、Amp、goose、opencode…）。**Trae 也支持**——但桌面版需在「设置 → 规则 → 导入设置」打开一次「将 AGENTS.md 包含在上下文中」；TRAE CLI 则默认读取，无需开关。

**怎么用**：不论你用什么工具，**先读根目录 `AGENTS.md`**。其 §0 有「怎么让本文件在你的工具里生效」的对照表；不在表内的工具，照 §0 说明在各自规则目录加一个**指向 `AGENTS.md` 的薄指针**即可。

> ⛔ 维护者注意：`AGENTS.md` 是唯一正文。工具专属文件里出现规范正文 = 违规，请改回指针。
