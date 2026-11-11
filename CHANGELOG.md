# Changelog

## 0.6.0

回退 #8 与 #10，只保留 dsh 0.2.2 的 admission 适配。

### 移除

- `group_tools` 工具与分组编辑器改版（#8）。
- `deactivate_tools` 主动释放、被动释放（空闲回收 / 激活上限）与「会话工具释放」配置（#10）。
- 目录重发机制：不再输出 `<removed_tools>` / `<released_tools>` 段（#10）。

### 修复

- 不再对外承诺「激活不重写请求头」。dsh `0.2.2` 起工具声明由宿主接管并派生自当步 admission，插件隐藏未激活工具必须窄化 admission，因此**每次激活都会产生一条 `reason: "change"` 的 `request/header`**，提供方缓存前缀在该步失效。README 与 `docs/verification.md` 已按实际契约改写。

### 保留

- dsh `0.2.2` 的 admission 适配：`tools.resolve()` 窄化、无声明装配的降级、两条 warn-once 诊断。

## 0.5.0

- dsh 0.2.2 admission 适配、闸门链修复、工具分组与配置页优化（admission 适配部分保留至 0.6.0）。

## 0.4.3

- 早期版本变更以 git 历史为准。
