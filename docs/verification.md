# 源码验证记录

## 2026-11-12（二）：在 dsh 0.2.2 上恢复保头稳定

问题：上一轮把「激活会换头」当成 0.2.2 的必然结果并据此回退，这个结论是错的。换头不是宿主契约的必然，而是**隐藏方式**选错了。

- 机制更正：宿主用 `toolSet.view()` 派生声明，而 `projectToolSchema` 会把定义上的 `deferLoading` 原样带进声明（`{ name, description, parameters, ...deferLoading === true ? { deferLoading } : {} }`）。也就是说插件不必把工具从 admission 里**删掉**才能让模型看不见——**保留定义、打上 `deferLoading`** 同样让模型拿不到它的 schema，而声明集合保持不变。
- 修复：`src/admission-gating.ts` 增加 `AdmissionMode`。路由支持对话中途变更工具（`toolUpdate`）时用 `defer` 模式：未激活工具留在 admission 里、只加 `deferLoading`，声明集合恒定，`headerEquals` 恒为真，宿主不再写 `request/header`。不支持的路由继续用 `filter` 模式。
- 激活如何生效：保留声明后，模型需要的是「该工具可用」这一步。公告改在 `step/start` 之后写：此时步已开启、请求尚未构建，消息落进同一步的 `deriveMessages()`，且排在上一轮的 tool result 之后（放在激活提交处会把 developer 消息排到自己的 tool result 之前，破坏 adapter 的 system-update 刷新顺序）。原实现把公告放在装配钩子里，而真实宿主在 `preStep` 装配时上一轮 `step/end` 已写入，`stepOpen` 恒为 false —— 这是它在 0.2.2 上一直没生效的原因。
- 时序：能力探测（`llm.resolveModelInfo`）在 admission 的 resolver 里 `await`，因此第一步就已是 `defer` 模式；若晚一步决定，第一步 filter、第二步 defer，头仍会变一次。
- 授权边界：工具虽留在 admission 里，`ctx.tools.guard()` 在激活提交前拒绝执行，保持「可见性 ≠ 权限」。
- 用例：新增 3 条 gate 用例（保留全集并只改 defer 标记、激活前后集合恒等、延迟定义仍保留执行回调）；全量 13 个文件 327 用例通过，lint、typecheck 均退出 `0`。
- 未验证：真实端点 A/B 与真实 profile 的 `cacheRead` 对照；本轮只验证到声明集合恒等这一层。

## 2026-11-12（一）：回退 #8 / #10

- `git revert -m 1` 依次回退合并提交 `d70e689`（#10）与 `442ce2c`（#8），工作树与 `v0.4.3` 逐字节一致（仅 `package.json` 版本号不同）。
- 删除：`group_tools`、`deactivate_tools`、被动释放（空闲回收 / 激活上限）、分组编辑器改版与写队列、目录重发（`<removed_tools>` / `<released_tools>`）、`src/injection.ts`、`src/release.ts`、`src/cap.ts`、`src/idle.ts`、`src/groups.ts`、`src/group-writer.ts` 及客户端对应文件。
- 保留的 0.2.2 适配：`src/admission-gating.ts` 与测试、`AssembledPrompt` 类型（`tools` 可选）、`filterPromptAssembly` 在无声明时不写回 `tools`、`ownsDeclarations` 探测与 `gateResolver` 接线。
- 当时的错误结论「0.2.2 上无法保头稳定」已被本条上一节修正。

## 2026-10-19：激活不再破坏前缀缓存

问题：旧实现按激活状态过滤 `assembly.tools`，每次激活都重写请求头里的工具声明列表，提供方缓存前缀随之失效。

- 真实端点实测（`api.deepseek.com/anthropic/v1/messages`、`deepseek-flash`、8.9K token 固定前缀）：相同请求第二次命中 8960；仅追加一个工具声明后掉到 128；声明不变、改为在会话尾部追加 `tool_addition` 时仍命中 8960，且模型能正常调用被声明的延迟工具。延迟声明本身不占 token（1 个普通工具 9207，再加 10 个延迟工具 9201），但接口要求至少保留一个非延迟工具。
- 实现：路由支持 `toolUpdate` 时，把全部工具留在声明里，非基础工具标 `deferLoading`；激活只在 assemble 阶段追加一条带 `tool_addition` 的 developer 消息，引用当前 `request/header`。
- 已追加的工具集合从当前 surface（`deriveMessages()`）读取而非日志，避免历史折叠丢掉公告后工具静默失效。
- 真实 headless profile 验证（临时 `DSH_HOME` + `dsh --profile e2e` + 本地 `link:` 构建）：单次激活后连续两步 `cacheReadTokens` 9344 → 12544，新增计费仅 3118 / 174；会话日志只有一个 `request/header`，另有 1 条 `developer/message`。同一任务下旧版本产生 `initial` + `change` 两个 header。
- 用例：新增 3 个宿主集成用例（声明表保持、公告只发一次、无能力路由退回过滤）与 2 个提示词用例；全量 12 文件 309 用例通过，lint、typecheck、build 均退出 `0`。
- 未验证：真实 GUI 端到端与发布产物；`deepseek-v4-pro` 等未声明 `toolUpdate` 的路由仍走过滤路径，未实测其缓存代价。

## 2026-10-11：完全权限激活修复

- 通过公开 `sandboxPolicy.resolve({ session })` 读取当前会话权限；`danger-full-access` 免去插件的激活确认，执行中校验、最终提交与 receipt 使用相同判断。未挂载 sandbox policy 时仍按插件配置要求审批。
- 新增 8 个真实宿主集成用例，覆盖 native/PTC + `never`、无审批服务、部署默认与会话覆盖、历史恢复、提交前撤销完全权限、核心 guard 保留；修改前 5 个用例失败，包含原报错 `Tool activation was not approved (rejected)`，修改后全部通过。
- `pnpm run lint --fix`、`pnpm run typecheck`、`pnpm run test -- --run`、`pnpm run build` 均退出 `0`；全量为 **12 个文件、304 个用例**。
- Build 输出宿主与客户端产物；仍有既有的 `external` 弃用及客户端 CJS/ESM publint 警告。未安装到真实 profile，未验证 GUI E2E，未打包发布。

## 2026-10-10：历史源码验证

验证日期：2026-10-10，Asia/Shanghai。以下记录范围为源码实现，不包含当时的 Build、发布产物、真实 profile 或 GUI E2E。

## 基线

- Node.js `25.5.0`，pnpm `11.15.1`，TypeScript `6.0.3`，Vitest `4.1.10`。
- DSH 开发依赖固定 `0.2.0-rc.2`，Cordis `4.0.4`；最低 peer 范围为 `>=0.2.0-rc.2`。依赖及运行方式见[包声明](<../package.json>)、[workspace catalog](<../pnpm-workspace.yaml>)。
- starter 模板 commit `ff0c32c923172c3505044763de9d6420611146bd`；全部实现只使用 DSH 公开接口，未引入平台私有能力。

## 已通过的 gate

- 全仓 ESLint：退出码 `0`；最终使用非修复模式复核。
- `tsc --noEmit`：退出码 `0`。
- `git diff --check`：退出码 `0`；Windows LF/CRLF 提示不是测试失败。
- `pnpm install --ignore-scripts --frozen-lockfile`：退出码 `0`，确认 lockfile 可复用，未执行任何 lifecycle script。
- 完整测试共 **12 个文件、313 个用例**，连续五次独立进程全部通过：标准顺序一次，以及 shuffle seeds `20261010`、`20261011`、`20261012`、`20261013` 各一次。该批测试早于配置界面重做；重做后删除旧表单用例，当前为 **11 个文件、288 个用例**，lint 与类型检查同样通过。
- 完成下述 mutation 并恢复源码后，再次完整运行通过 **12 个文件、313 个用例**，并重新通过 lint 和类型检查。

[Vitest 配置](<../vitest.config.ts>)分别运行 node 宿主和 jsdom 客户端项目，没有 watch 模式或 Build 前置步骤。

## 关键覆盖

- [真实宿主集成](<../src/host.test.ts>)：31 个用例，使用真实 rc.2 Cordis、ToolRuntime、SystemPrompt、SessionStore、SessionProjectionRegistry、AgentRegistry、审批与技能服务；PTC 外部执行器使用显式测试驱动，不替换插件本身。
- native 和 PTC 的基础工具、目录、批量激活、当前 scope、完整 schema/说明同步、TypeScript/Python SDK、complete prompt、context suppression、动态配置及卸载。
- 审批缺失/拒绝/取消、post-policy 拒绝或取消、配置变化、PTC 父调用失败、spill 后 receipt 保留，以及最终接受的技能内容快照。
- [历史 fold](<../src/history.test.ts>)与[receipt 校验](<../src/activation.test.ts>)：157 个用例，覆盖 callId/请求参数/审批 audit 绑定、嵌套 PTC 暂存与最终成功、无额外快照授权、checkpoint 和 JSON 序列化 seed 恢复。不写自定义 required session event。
- [激活运行时](<../src/runtime.test.ts>)及目录、提示、配置用例覆盖 already-active/not-found/skill fallback、顺序、确定性、XML 转义和原型名称键。
- 客户端四个测试文件共 38 个用例，覆盖官方 keyed slot 注册、八项配置原子保存与 revision、只读/不可用/异常/过期请求、ARIA 和实例样式所有权清理。
- [源码分发契约](<../test/api-snapshot.test.ts>)验证入口导出、最低 peer 范围、官方配置 owner、bundle row 和本地安全 SVG；不依赖生成产物。

## Mutation 验证

以下仅为临时源码变更；已逐项恢复，没有遗留 mutant。

| 临时回归 | 检测结果 |
| --- | --- |
| 删除手动模式的历史激活隔离判断 | 对应测试失败，错误输出包含不应出现的 `pwsh` 与 `write` |
| 删除 receipt 的 `approvalRequired` audit 检查 | `rejected`、`cancelled`、`unavailable` 三个用例全部失败 |
| 删除 PTC 父结果 `isError` 拦截 | 父调用失败/取消两个用例均失败，检测到不应提交的 `files` |

红色结果是本项验证的预期；恢复后的完整测试再次全部通过。

## 可复核命令

在仓库根目录运行，仅执行源码 gate：

```powershell
$env:CI = 'true'
node node_modules/eslint/bin/eslint.js .
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run --reporter=dot
```

需要重现随机顺序时：

```powershell
$env:CI = 'true'
foreach ($seed in @(20261010, 20261011, 20261012, 20261013)) {
  node node_modules/vitest/vitest.mjs run --reporter=dot --sequence.shuffle --sequence.seed=$seed
  if ($LASTEXITCODE -ne 0) { throw "Test run failed for seed $seed" }
}
```

## 未验证与限制

- **未执行 Build、prepack、打包、发布、真实 GUI E2E、profile 安装或插件 link。** 客户端 jsdom 和静态资源契约不能代替实际官方页面验收；源码目录不是已验证可安装的发布包。
- session 恢复验证使用标准事件的 JSON 序列化和公开 seed，不访问真实数据目录，也未实测真实存储的跨进程 cold reload。
- `0.2.1-alpha.2` 用于公开声明与兼容加载器静态交叉核对，不等于该发行版的完整运行测试；未来破坏性 API 仍需重新验证。
- 普通官方 profile 的 external 解析和 React 平台模块表已静态核对。workspace `plugin link` 可能优先使用本地 rc.2 devDependencies，不能据此声称任意 runtime 自动复用；实际产物解析仍待 Build 授权。
- 工具激活仅改变模型展示，不授予权限；插件不提供第三方平台的托管服务、凭据库或云端执行环境，也不改写已提交的历史消息。
- 本项目按 MIT 发布；模板、图标与依赖保留各自原始许可，发行物完整第三方清单仍待准备发行时单独核查，见[第三方声明](<../THIRD_PARTY_NOTICES.md>)。