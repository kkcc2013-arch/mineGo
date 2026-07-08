# REQ-00515: 游戏服务端多语言智能复数与语法规则引擎

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00515 |
| 标题 | 游戏服务端多语言智能复数与语法规则引擎 |
| 类别 | 国际化/本地化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | backend/shared/i18n, gateway/middleware |
| 创建时间 | 2026-07-09 01:00 |

## 需求描述

在复杂的本地化场景中，简单的翻译映射无法处理不同语言的复数规则（如 Slavic 语言复杂的复数形态）和语法变化。当前 mineGo 项目缺乏服务端统一的复数处理引擎，导致服务端返回的系统消息（如"你获得了 X 个精灵"）在翻译时不够地道。

本需求旨在构建一个基于 CLDR (Common Locale Data Repository) 标准的服务端复数引擎，自动根据当前用户的语言偏好和数值应用正确的语法规则。

## 技术方案

### 1. 核心引擎 (backend/shared/i18n/PluralEngine.js)
- 基于 CLDR 复数规则（Unicode ICU PluralRules）进行实现。
- 提供 `format(key, count, locale)` 方法。
- 集成到现有的国际化中间件中。

### 2. 规则集管理
- 将复数规则文件（JSON 格式）作为资源包管理。
- 支持不同语言的规则扩展。

### 3. API 集成
- 在 API 响应拦截器中，自动识别 `i18n` 类型的消息对象。
- 自动转换复数形式。

## 验收标准

- [ ] 实现符合 CLDR 标准的复数规则引擎。
- [ ] 后端服务支持通过 key 和数值获取正确的本地化字符串。
- [ ] 国际化中间件能够自动处理 API 响应中的复数键值。
- [ ] 提供单元测试，覆盖至少 10 种不同复数语法的语言场景。

## 影响范围

- `backend/shared/i18n`
- `gateway`
- 所有调用国际化服务的后端服务

## 参考

- [ICU User Guide: Plural Rules](https://unicode-org.github.io/icu/userguide/format_parse/messages/)
- [Unicode CLDR Project](https://cldr.unicode.org/)
