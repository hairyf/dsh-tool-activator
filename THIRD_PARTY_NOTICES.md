# 第三方来源与许可声明

本文件记录本项目使用的模板、图标与已核对依赖的原始版权和许可，不构成法律确权或完整依赖 SBOM。本项目自身代码按[根许可](<LICENSE.md>)（MIT）提供。

## starter-plugin 模板

- 来源：[DSH starter-plugin 固定 commit](<https://github.com/dsh-tauri/starter-plugin/tree/ff0c32c923172c3505044763de9d6420611146bd>)，SHA `ff0c32c923172c3505044763de9d6420611146bd`。
- 原始版权：**Copyright (c) 2025-PRESENT dsh-tauri-desk.**
- [完整 MIT 原文](<licenses/template-MIT.txt>)来自本仓库初始未改动的许可文件；原 notice 和授权条款完整保留。
- 保留模板的包与 host/client 构建骨架，并修改为本插件入口、官方 client module-loader 导出、兼容性声明及测试布局。模板 MIT 仅适用于其相应部分。

## Gravity UI Icons

- 来源：`@gravity-ui/icons` **2.22.0**；所用图标为 `Wrench`。本包[SVG 图标](<icon.svg>)复制自该版本原始 Wrench SVG；[客户端图标模块](<src/client/icons.ts>)使用同一公开组件。
- 原始版权：**Copyright (c) 2022 YANDEX LLC.**
- [完整 MIT 原文](<licenses/Gravity-Icons-MIT.txt>)已保留；本次未改写 SVG 路径数据。公开 manifest/icon 资源接线不代表图标作者或官方插件页对本项目背书。

## 已核对依赖

| 组件 | 核对版本/来源 | 许可副本与说明 |
| --- | --- | --- |
| DeepSeek Harness 公开工具接口 | `@deepseek-ai/dsh-tools` 0.2.0-rc.2 | Copyright (c) 2026 DeepSeek；[MIT 原文](<licenses/DeepSeek-MIT.txt>)。这里只使用公开接口与 standalone SDK renderer，不复制或改动核心 routing/approval/sandbox 实现 |
| `@deepseek-ai/schemastery` | 3.18.4 | Copyright (c) 2021-present Shigma；[MIT 原文](<licenses/Schemastery-MIT.txt>) |
| `@deepseek-ai/cosmokit` | 1.8.5 | Copyright (c) 2021-present Shigma；与 schemastery 相同的 MIT 条款，见[MIT 原文](<licenses/Schemastery-MIT.txt>)。仅用于 schemastery 公开类型中 `Dict` / `Volatile` 的可移植引用 |
| `zod` | 4.4.3 | Copyright (c) 2025 Colin McDonnell；[MIT 原文](<licenses/Zod-MIT.txt>) |
| `css-render` | 0.15.14 | 已安装 package manifest 声明 MIT，但该包未包含独立许可全文；不能据此臆造 copyright notice。实际发布前需取得对应上游许可与所有被捆绑部分的 notice |

其它开发/运行依赖以[包声明](<package.json>)和[依赖锁](<pnpm-lock.yaml>)为准；仅使用接口不等于其独立许可已被本项目替换。没有执行 Build，尚不能断言最终 bundle 具体包含哪些第三方代码。对最终产物、直接与传递依赖的完整版权/许可 inventory，仍需在准备发行时单独核查。

## 发行前要求

1. 本项目自身代码按 [MIT](<LICENSE.md>) 提供；模板、图标与依赖仍保留各自原始许可，不能被本项目的 MIT 声明替换。
2. 分发时保留上述原始 Copyright、授权全文和适用 attribution，并同步更新实际 bundle 涉及的第三方清单。
3. 未执行 Build、打包、发布或商业授权申请；包元数据的 `SEE LICENSE IN LICENSE.md` 只是查阅入口，不是额外授权。
