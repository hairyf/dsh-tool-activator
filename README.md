# dsh-tool-activator

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

为 DeepSeek Harness (DSH) 减少初始工具上下文：默认仅展示基础工具，其余工具通过 `activate_tools` 按需加载。

* **系统要求**：DSH $\ge$ `0.2.0-rc.2`；Node.js $\ge$ `22.19.0`。
* **交付状态**：当前为源码交付，未发布 npm 包。
* **定位声明**：本插件**不是权限系统**，仅影响模型可见的 schema 和提示词，不替代核心审批与沙箱机制。

---

## 核心行为

默认基础工具为 `read`、`glob`、`grep`、`write`、`edit`、`skill`、`ask_user_question`、`todo_write`。

模型每次都看到：基础工具、已激活工具、`activate_tools`，以及其余工具的 `<available_tools>` 简述目录。这套行为没有开关——插件装上就生效；唯一会隐藏的例外是该 agent 作用域看不到 `activate_tools`（被 `tools.restrict` 挡掉等），此时插件不拦截任何工具。

### 默认启用的工具

`read`、`glob`、`grep`、`write`、`edit`、`skill`、`ask_user_question`、`todo_write`

### 可通过 `activate_tools` 加载的工具

其余已安装且在当前 agent 作用域可见的工具默认隐藏，由模型按标识激活。常见内置工具：

| 分类 | 工具标识 |
| --- | --- |
| 文件写入 | `write`、`edit` |
| 命令执行 | `bash`、`pwsh` |
| 联网 | `web_search`、`web_fetch` |
| 后台任务 | `job_output`、`job_list`、`job_kill` |
| 终端 | `terminal_open`、`terminal_send`、`terminal_read`、`terminal_signal`、`terminal_close`、`terminal_list` |
| 目标 | `get_goal`、`create_goal`、`update_goal` |
| 会话检索 | `session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_event_read` |
| 代码智能 | `lsp` |
| 编排 | `subagent`、`subagent_fork`、`workflow`、`ralph`、`structured_output` |

此外，任意已安装插件的工具都可作为标识请求；开启 `autoGroupMcp` 时，`mcp__server__tool` 还会按 server 聚合为 `mcp.server`。

实际可用集合以当次 `<available_tools>` 目录为准：未知、已移除或作用域不可见的标识不会因此被注册或授权。该目录随提示词注入给模型，只有标识、名称和一句简述：

```xml
<available_tools description="These tools are installed but not yet enabled. Use activate_tools to enable them when needed.">
  <tool identifier="web_search" name="web_search">Search the public web for current information.</tool>
  <tool identifier="mcp.mail" name="mail">send: Send a message through the mailbox.</tool>
</available_tools>
```

模型可按需请求加载工具或组：

```json
{
  "identifiers": ["web_search", "web_fetch"],
  "reason": "需要检索并核对用户要求的公开资料"
}
```

---

## 配置

进入官方插件管理页，打开 `dsh-tool-activator` 卡片，配置表单直接显示在该插件的页面上（公开 **`plugins.bundle.config`** 槽，key 为包名 `dsh-tool-activator`），不需要再点进某一行的"配置"。

<img height="800" alt="image" src="https://github.com/user-attachments/assets/55d7b574-5a05-4892-9567-fd9d3310c566" />


表单只有一份工具列表：

| 分区 | 含义 |
| --- | --- |
| **默认激活工具（N 个）** | 每次请求都带完整 schema 的工具；插件自带的八个基础工具固定在此区并排在最前，标题右侧带"基础工具"标记，开关为禁用，不允许关闭 |
| **按需激活（M 个）** | 其余工具，模型用 `activate_tools` 按需获取 |

打开某一项的开关即把它写进 `basicTools`（默认加载），关闭则移回按需区；工具清单与描述由宿主 Remote `toolActivator/catalog` 提供，覆盖当前所有 live agent 作用域。

**常规**区两个开关：`requireApproval`（非完全权限时激活前请求确认，缺少审批服务时直接拒绝；完全权限 `danger-full-access` 时无需确认，即使审批策略为 `never`）与 `autoGroupMcp`（按 `mcp__server__tool` 前缀聚合同一 MCP 服务），都带 hover 说明。

**工具分组**区是结构化编辑器：每个分组有标识符、名称、说明、工具勾选（只能从当前目录里的真实工具中选）和说明节绑定，支持增删；留空则每个工具各自成为条目。`sectionTools` 仍留在 schema 里（进阶用法：说明节到工具名的依赖映射），但不再出现在表单中。

---

## 状态、审批与生命周期

* **执行路由**：通过 DSH 原有 dispatcher 执行，不改变底层沙箱或运行路由。
* **持久化与恢复**：已完成的激活状态随标准会话日志和 seed 恢复，不依赖中途内存状态。
* **生命周期**：Cordis 负责注册、监听及 HMR 清理，卸载时自动清理样式与实例。

---

## 源码验证与交付边界

根目录下可执行以下命令进行验证：

```powershell
$env:CI = 'true'
node node_modules/eslint/bin/eslint.js . --fix
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
```

* **测试情况**：2026-10-11 完全权限修复后，12 个文件、304 个用例全部通过；lint、类型检查与 Build 同样通过。
* **未验证项**：真实 GUI E2E、打包发布及真实 profile 验证。

---

## 许可证

MIT

第三方声明见 [THIRD_PARTY_NOTICES.md](<THIRD_PARTY_NOTICES.md>)。

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/dsh-tool-activator?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/dsh-tool-activator
[npm-downloads-src]: https://img.shields.io/npm/dm/dsh-tool-activator?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/dsh-tool-activator
[bundle-src]: https://img.shields.io/bundlephobia/minzip/dsh-tool-activator?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=dsh-tool-activator
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/dsh-tool-activator
[license-src]: https://img.shields.io/github/license/hairyf/dsh-tool-activator.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/hairyf/dsh-tool-activator/blob/main/LICENSE.md
