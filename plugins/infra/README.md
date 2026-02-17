# Infra plugins

目标：提供“系统基础设施能力”（队列、观测、网关等）。

包清单：
- BullMQ：`pluxel-plugin-bullmq`
- OTLP：`pluxel-plugin-otlp`
- OTLP Viewer：`pluxel-plugin-otlp-viewer`

提示：Infra 插件通常与运行环境绑定更强（端口/代理/collector），建议先按各包 README 跑通最小链路，再集成到产品 host。

