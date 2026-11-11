# Changelog

## 0.7.0

在 dsh `0.2.2` 上真正恢复「激活不重写请求头」。

### 修复

- **请求头在激活时保持不变。** `0.2.2` 起工具声明由宿主派生自当步 `tools.resolve()` 的 admission 视图，插件无法再从装配瀑布写回声明。之前（含 0.6.0）的做法是把未激活工具从 admission 里**删掉**，声明集合随之变化，宿主每次激活都写一条 `reason: "change"` 的 `request/header`，提供方缓存前缀在该步整段失效。
  现在改成**不删、只标**：所有工具都留在 admission 里。除「始终可见」的那几个（`activate_tools` / `run_code` 与基础工具）之外，其余一律带 `deferLoading`，**激活后也不摘掉该标记**——标记取决于配置而非会话状态，声明集合与逐字节内容因此恒定，`headerEquals` 恒为真，宿主不再写 `request/header`。激活改由下一步 `step/start` 之后追加的一条 `tool_addition` 承载，提供方据此加载该工具，缓存前缀保持有效。
- 该路径只在路由声明支持对话中途变更工具（模型目录 `toolUpdate`）时启用；不支持的路由退回按激活状态过滤声明表，行为与之前一致。
- 新增执行期 guard：延迟展示的工具在激活提交前仍不可调用，避免「声明可见但未授权」。

### 移除

- （0.6.0 遗留）`group_tools`、`deactivate_tools`、被动释放、目录重发保持移除状态。

## 0.6.0

回退 #8 与 #10，只保留 dsh 0.2.2 的 admission 适配。

### 移除

- `group_tools` 工具与分组编辑器改版（#8）。
- `deactivate_tools` 主动释放、被动释放（空闲回收 / 激活上限）与「会话工具释放」配置（#10）。
- 目录重发机制：不再输出 `<removed_tools>` / `<released_tools>` 段（#10）。

### 保留

- dsh `0.2.2` 的 admission 适配：`tools.resolve()` 窄化、无声明装配的降级、warn-once 诊断。

## 0.5.0

- dsh 0.2.2 admission 适配、闸门链修复、工具分组与配置页优化（admission 适配部分保留至 0.6.0）。

## 0.4.3

- 早期版本变更以 git 历史为准。
