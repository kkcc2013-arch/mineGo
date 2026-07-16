# REQ-00564: 微服务契约测试Mock服务自动生成系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00564 |
| 标题 | 微服务契约测试Mock服务自动生成系统 |
| 类别 | 测试覆盖 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | backend/shared, test-suite, api-gateway |
| 创建时间 | 2026-07-16 09:00 |

## 需求描述

在微服务架构中，由于服务依赖复杂，进行集成测试或端到端测试时，环境搭建与维护成本高昂。本需求旨在构建一个自动根据 OpenAPI 定义生成 Mock 服务的系统，通过模拟依赖服务的行为，实现微服务在开发和测试阶段的解耦，提高测试的可靠性和执行效率。

## 技术方案

### 1. Mock 引擎集成
- 基于现有 OpenAPI 标准文档 (Swagger/OpenAPI)，集成 Prism 或类似的 Mock 服务器引擎。
- 支持根据 schema 定义自动生成符合规范的响应体，并支持动态响应模板。

### 2. Mock 自动化注入
- 在 CI/CD 流水线中引入 Mock 自动部署环节，针对变更的服务，自动启动其依赖的 Mock 实例。
- 支持基于标签或版本号动态切换 Mock 环境，确保测试环境与生产环境接口语义一致。

### 3. 数据校验与报告
- Mock 服务器自动记录未匹配的 API 请求并进行日志审计，帮助开发者发现契约失效。
- 与测试报告系统打通，自动标识哪些测试链路使用了 Mock，哪些使用了真实服务。

## 验收标准

- [ ] 能够基于 OpenAPI 文件自动生成可运行的 Mock 服务实例。
- [ ] CI/CD 流程中可按需自动部署/销毁 Mock 实例。
- [ ] Mock 服务能根据 Schema 验证传入请求的合法性，并返回符合规格的 Mock 数据。
- [ ] 提供 Mock 调用审计日志，便于定位测试失败原因。

## 影响范围

- `backend/shared` (新增 mock-service 工具)
- `test-suite` (集成 mock 部署逻辑)
- `api-gateway` (配置服务路由调整)

## 参考

- [OpenAPI Specification](https://spec.openapis.org/)
- [Prism Mocking Tool](https://stoplight.io/open-source/prism/)
