# 任务列表

## 依赖文档

本任务列表基于以下文档生成：

- **设计文档**: `docs/blossom/2026-04-12-ctrl-p-worktree-session/design.md`
- **需求文档**: `docs/blossom/2026-04-12-ctrl-p-worktree-session/requirements.md`

## 任务概述

- 主线：新增 `ctrl+p` worktree-session 入口，串起“用户输入工作树名称/目录名 → 创建 repo 同级 worktree → 创建或 fork session → 发送 prompt → 打开新窗口”。
- 约束：worktree 名称由用户输入；默认目录名基于“仓库名 + 工作树名称”；目录固定落 git 根目录父目录；repo 无 Storybook、`__test__/smoke`、`__test__/critical`、测试脚本约定。
- 顺序：先落路径/命名与编排底座，再接 TUI 入口与文档，之后执行 `code-review` → `plan-drift-review` → 反馈修复 → `reviewdeck` → 用户验收。

## 冻结的仓库归属

- **实施仓库**：当前仓库 `opencode-worktree`
- **仅复用仓库**：`@opencode-ai/sdk`
- **说明**：沿用 design 已冻结结论；本次实现只改当前仓库代码与文档，SDK 仅消费 `session.create / session.fork / session.prompt`。

## 结构关键假设确认

- 当前仓库无 Storybook、`__test__/smoke`、`__test__/critical`、`test:smoke`、`test:critical`、`storybook` 脚本；本轮任务不采用 story/test-first 顺序，自动化验证以现有最小自检为辅，人工验收后置收口。
- `prompt` 本轮仍为必填输入；本次拆解不纳入“空消息启动”范围。
- branch 名来自 `worktreeName` 的规范化结果；`customDirectoryName` 只影响目录名，不影响 branch 来源。

> 注：实现类子任务保留“文件清单”；纯评审 / 反馈确认 / 收口类子任务可省略文件清单，直接写评审范围与闭环条件。

### [ ] Step: 1.落路径与命名解析底座

> **blockedBy**: 无（基础层）

#### 1.1 新增 worktree 目标解析能力

- **agent 技能**：无
- **文件清单**:
  - `src/plugin/worktree/launch-session.ts`
    - 动作: 新增
    - 目标: 定义 launch 输入/输出类型，并实现 `worktreeName -> branch / directoryName / worktreePath` 解析能力。
  - `src/plugin/worktree/state.ts`
    - 动作: 修改
    - 目标: 让状态层使用 repo 同级目录语义，而不是固定 `~/.local/share/opencode/worktree/...` 路径策略。
- **实现细节**:
  - 在解析器内基于 `repoRoot` 取 `basename(repoRoot)` 与 `dirname(repoRoot)`，生成默认目录名与最终 sibling `worktreePath`。
  - 目录名与 branch 名分别做文件系统安全化 / git branch 校验；目录冲突与非法名称在真正 `git worktree add` 前拦截。
  - 保持 state 持久化仍以最终 `path` 为准，避免 delete/cleanup 还引用旧 home 目录路径。
- _参考: `src/plugin/worktree/state.ts`_
- _需求: 用户故事 1（场景 1.1-1.4）、用户故事 2（场景 2.3）_
- _设计: 设计结论 2-4；组件 2：命名与路径解析器；模型 2-3_
- _验收: 默认目录名正确；自定义目录名覆盖默认值；目录位于 git 根目录父目录下。_

#### 1.2 对齐现有 worktree 创建链路到新路径策略

- **agent 技能**：无
- **文件清单**:
  - `src/plugin/worktree.ts`
    - 动作: 修改
    - 目标: 让现有 `createWorktree` / `worktree-create` 命令消费新的目标路径解析结果，并保持 copy/symlink/hook/state 写入一致。
  - `src/plugin/worktree/state.ts`
    - 动作: 修改
    - 目标: 确保 session 绑定、删除与后续 cleanup 都基于新 path 规则工作。
- **实现细节**:
  - 统一 `createWorktree` 的输入，避免业务层各自拼路径。
  - 保持现有 branch 校验、postCreate hook、session state 写入逻辑不变，只替换路径来源。
  - 明确禁止保留“home 目录路径”和“repo 同级路径”双轨并存。
- _参考: `src/plugin/worktree.ts`_
- _需求: 用户故事 1（场景 1.3-1.4）、用户故事 3（场景 3.1）_
- _设计: 设计结论 2-4；组件 3：统一编排服务；代码复用分析-高风险复用点（路径策略迁移）_
- _验收: 现有 `/worktree-create` 与新入口共享同一目录策略；删除/清理不再指向旧目录。_

### [ ] Step: 2.补 session 来源编排与结果汇总

> **blockedBy**: Step 1（需要先冻结 branch 与 worktreePath 规则）

#### 2.1 抽出可复用 fork helper 与 direct-create 分支

- **agent 技能**：无
- **文件清单**:
  - `src/plugin/worktree/fork-session.ts`
    - 动作: 修改
    - 目标: 暴露不带终端副作用的 fork-with-context 能力，并保留 messageId 透传。
  - `src/plugin/worktree/launch-session.ts`
    - 动作: 修改
    - 目标: 基于 mode 分流 `session.fork` 与 `session.create`，产出统一 `sessionId`。
- **实现细节**:
  - `fork-from-message` 路径必须把选中的 `messageId` 传到 fork 请求，不能退化成只按当前 session fork。
  - `new-session` 路径必须先 `session.create`，拿到稳定 `sessionId` 后再进入后续步骤。
  - 保留 root session 计划/delegations 复制逻辑边界；direct-create 不复制 fork 专属上下文。
- _参考: `src/plugin/worktree/fork-session.ts`_
- _需求: 用户故事 1（场景 1.1）、用户故事 2（场景 2.1-2.2）_
- _设计: 设计结论 5；组件 3-4；代码复用分析-高风险复用点（fork 双实现）_
- _验收: 两种模式都能得到稳定 `sessionId`；fork 模式 messageId 不丢失。_

#### 2.2 串联 prompt、terminal 与部分成功结果对象

- **agent 技能**：无
- **文件清单**:
  - `src/plugin/worktree/launch-session.ts`
    - 动作: 修改
    - 目标: 完成“建 worktree → 建/取 session → 发 prompt → open terminal → 汇总结果”统一编排。
  - `src/plugin/worktree/terminal.ts`
    - 动作: 修改
    - 目标: 如有必要补齐编排层需要的返回信息或窗口命名支持，但保持 cwd=worktreePath 语义不变。
  - `src/plugin/worktree.ts`
    - 动作: 修改
    - 目标: 复用统一编排结果对象或最小抽平现有本地命令结果汇总逻辑，避免重复拼接错误提示。
- **实现细节**:
  - `prompt` 发送失败、terminal 打开失败、fork/create 失败要区分状态，并把 `sessionId` / `worktreePath` / 手动恢复命令带回结果对象。
  - 成功路径必须把 `openSessionTerminal` 的 cwd 固定为最终 `worktreePath`。
  - 结果对象需同时覆盖 toast 文案与后续 state 写入需要的信息，避免上层二次推断。
- _参考: `src/plugin/worktree/terminal.ts`, `src/plugin/worktree.ts`_
- _需求: 用户故事 1（场景 1.2）、用户故事 3（场景 3.1-3.2）_
- _设计: 设计结论 5-7；组件 3-5；错误处理 4-6；模型 4_
- _验收: `session.create/fork`、`prompt`、`terminal` 各失败分支都能返回可恢复结果。_

### [ ] Step: 3.接入 ctrl+p 新入口与用户输入流

> **blockedBy**: Step 2（需要已有统一编排入口可供 TUI 调用）

#### 3.1 在命令面板内新增 worktree-session 入口

- **agent 技能**：无
- **文件清单**:
  - `src/tui.tsx`
    - 动作: 修改
    - 目标: 新增 `ctrl+p` 命令，按顺序收集 mode、message、worktreeName、customDirectoryName、prompt，并调用统一编排层。
  - `src/plugin/worktree/launch-session.ts`
    - 动作: 修改
    - 目标: 暴露 TUI 可直接调用的 launch 函数与标准化错误结果。
- **实现细节**:
  - `fork-from-message` 模式仅在当前 route 为 session 且存在可 fork 用户消息时可选；否则禁用或拦截。
  - `customDirectoryName` 作为可选输入；用户留空时走默认目录名。
  - 成功 toast 需明确显示 branch、目录名或 worktreePath；失败 toast 需指出失败步骤。
- _参考: `src/tui.tsx`_
- _需求: 用户故事 1、用户故事 2、用户故事 3（场景 3.1）_
- _设计: 设计结论 1-7；组件 1-5；错误处理 1-6_
- _验收: `ctrl+p` 单入口完整跑通两种模式；交互层不直接拼 worktree 路径。_

### [ ] Step: 4.同步用户文档与命令说明

> **blockedBy**: Step 3（需要代码路径与交互名称先稳定）

#### 4.1 更新 README 与 slash command 文档

- **agent 技能**：无
- **文件清单**:
  - `README.md`
    - 动作: 修改
    - 目标: 把 worktree 存放位置、用户输入命名规则、`ctrl+p` 新入口写入文档，并移除旧 home 目录描述。
  - `.opencode/command/worktree-create.md`
    - 动作: 修改
    - 目标: 让已有 `worktree-create` 命令文档与 repo 同级目录策略保持一致。
- **实现细节**:
  - README 中默认目录命名规则要与实现保持一致，避免仍写 `~/.local/share/opencode/worktree/...`。
  - 若 `worktree-create` 命令继续存在，文档需说明它与 `ctrl+p` 新入口共享同一路径策略。
- _参考: `README.md`, `.opencode/command/worktree-create.md`_
- _需求: 用户故事 1（场景 1.3-1.4）、用户故事 3（场景 3.1）_
- _设计: 设计结论 2-4；代码复用分析-明确不复用项（旧 home 路径）_
- _验收: 文档不再出现旧 worktree 路径；新入口与默认目录规则可被用户直接理解。_

### [ ] Step: 5.执行代码评审

> **blockedBy**: Step 1, Step 2, Step 3, Step 4（需要全部编码与文档改动完成后统一评审）

#### 5.1 对本轮未提交改动执行 `code-review`

- **agent 技能**：code-review
- **实现细节**:
  - 评审范围覆盖路径迁移、session 编排、TUI 新入口、README / command 文档同步。
  - 必须真正执行 `code-review`，记录阻塞性问题、重要问题、可选优化项。
  - 完成条件：产出可追踪评审结果，而不是只做人工自检。
- _设计: 设计结论 1-7；错误处理；测试策略_
- _验收: 已获得可追踪 `code-review` 结果，问题列表可用于下一步修复。_

### [ ] Step: 6.执行计划偏航评审

> **blockedBy**: Step 1, Step 2, Step 3, Step 4（需要全部编码与文档改动完成后检查是否偏离方案）

#### 6.1 对本轮未提交改动执行 `plan-drift-review`

- **agent 技能**：plan-drift-review
- **实现细节**:
  - 评审范围覆盖 requirements、design、实际改动三者是否一致。
  - 重点检查是否出现计划外扩 scope、是否误保留旧 home 路径、是否把 branch 来源从 worktreeName 又改回 prompt。
  - 完成条件：真正执行 `plan-drift-review` 并给出可追踪结果。
- _设计: 设计结论 2-7；仓库归属与实施边界_
- _验收: 已获得可追踪 `plan-drift-review` 结果，能判断本轮是否偏离规划。_

### [ ] Step: 7.按反馈修复并重新对齐文档

> **blockedBy**: Step 5, Step 6（需要先拿到两类评审反馈）

#### 7.1 处理评审问题并完成收口验证

- **agent 技能**：无
- **实现细节**:
  - 优先修复 `code-review` 与 `plan-drift-review` 的阻塞性 / 重要问题。
  - 对明确不采纳的意见，记录理由与验证依据。
  - 若修复导致范围、约束或验收口径变化，同步更新 `docs/blossom/2026-04-12-ctrl-p-worktree-session/requirements.md`、`docs/blossom/2026-04-12-ctrl-p-worktree-session/design.md`、`docs/blossom/2026-04-12-ctrl-p-worktree-session/task.md` 中受影响条目。
  - 完成条件：两类评审都已处理完毕；不存在未决阻塞问题；文档与最终实现重新对齐。
- _设计: 设计结论；错误处理；测试策略_
- _验收: 评审问题已闭环；不采纳项有留痕；规划文档与改动状态一致。_

### [ ] Step: 8.生成 reviewdeck 审阅产物

> **blockedBy**: Step 7（需要先完成反馈修复后再产最终审阅包）

#### 8.1 基于未提交改动生成 `reviewdeck` 输出

- **agent 技能**：reviewdeck
- **实现细节**:
  - 先基于当前未提交改动准备 `pr.diff`；如存在新文件，先让其进入 diff 视图。
  - 真正执行 `reviewdeck`，生成最终 `output/` 文件夹。
  - 在结果中写明查看命令：优先 `reviewdeck render output/`，本地无命令则退回 `npx reviewdeck@^0.2.0 render output/`。
  - 完成条件：`output/` 已生成，查看命令已明确给出。
- _验收: 存在可供人工审阅的 `output/` 产物与查看命令。_

### [ ] Step: 9.用户验收与手工验收

> **blockedBy**: Step 8（最终人工验收必须后置）

#### 9.1 按真实交互链路完成手工验收

- **agent 技能**：无
- **实现细节**:
  - 验证 `new-session` 模式：输入 `worktreeName + prompt`，确认目录与当前仓库同级、branch 来自 `worktreeName`、cwd 为新 worktree。
  - 验证 `fork-from-message` 模式：选消息后输入 `worktreeName + prompt`，确认上下文继承正确、cwd 正确。
  - 验证 `customDirectoryName`：目录名覆盖默认值，但 branch 仍来自 `worktreeName`。
  - 验证失败提示：目录冲突、fork/create 失败、prompt 失败、terminal 失败都能看到明确恢复信息。
  - 验收通过标准：需求文档中的场景 1.1-1.4、2.1-2.3、3.1-3.2 均能被人工验证覆盖。
- _需求: 用户故事 1、用户故事 2、用户故事 3_
- _设计: 测试策略-端到端测试；错误处理 1-6_
- _验收: 人工确认两种模式、默认/自定义目录、失败恢复路径均符合需求。_
