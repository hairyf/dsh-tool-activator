# 源码验证记录

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
