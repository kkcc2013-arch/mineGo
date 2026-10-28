# Backend Tests

在 `backend` 目录运行以下命令。依赖由 `package-lock.json` 锁定，可用
`npm ci` 安装。存储与进程测试需要隔离、可清理的测试服务；不要指向生产环境。

## 主单元检查

```sh
npm run test:unit
```

2026-10-25 本地检查通过765项，包括27个 Jest 套件/473项检查以及
Node/历史纯逻辑检查。数量是检查范围，不能作为全部658项需求的验收完成率。
主命令现已包含延迟队列套件；Kafka 传输在单元测试中受控，指标使用实际注册器。

支付协议单元检查直接导入生产模块，覆盖输入、请求绑定、固定商品价格、数量、
字节签名、状态图、JSON/XML/表单解析、密钥拒绝和输出白名单：

```sh
node --test --test-concurrency=1 tests/unit/payment.test.js
```

该文件不再复制一套支付帮助函数。六项纯协议检查的覆盖与真实 SQL/HTTP 的集成覆盖
分别记录；它们不证明整个 payment-service 的单元覆盖率已经达到90%。

## 支付的实际存储、HTTP 和进程

支付测试会先在隔离数据库的 public schema 安装真实 UUID/PostGIS/pgcrypto 扩展，
再创建可清理的业务 schema，避免首次场景把公用函数装进即将删除的临时 schema。
该流程已在三项扩展均不存在的全新 template0 数据库中验证；不修改历史 V1 SQL。

设置 `TEST_DATABASE_URL`、`TEST_REDIS_URL`，原生进程检查还需
`TEST_KAFKA_BROKERS`。测试创建随机所有权命名空间并清理自己的数据：

```sh
node --test --test-concurrency=1 tests/regression/payment-migration.test.js
npm run test:payment:storage
npm run test:payment:coverage
node --test --test-concurrency=1 tests/regression/payment-native.test.js
```

- 迁移检查验证旧 UUID 订单、金额、状态、微秒时间、视图和外键保留；拒绝自定义身份，
  有数据时拒绝反向删除。空表反向迁移保留 PostgreSQL 枚举标签，不重建历史类型。
- 存储检查使用生产路由/模块、PostgreSQL、Redis、真实签名和加密审计。共22项
  Node报告检查，包含6项纯协议检查、15项存储/HTTP子场景及1个父场景。验证并发幂等、
  24小时期限、用户隔离、缓存损坏/丢失、重复回调只入账一次、渠道交易去重、消费限制、
  审计失败回滚、旧 XML/表单及敏感字段过滤。
- 原生检查启动真实 payment-service 和 gateway 入口，执行全部87项迁移，核验签名
  原始字节、货币路由、Kafka 超时消费和正常退出；也验证缺少密钥和生产 KMS 时拒绝启动。
  其他网关服务地址指向测试支付服务，不代表所有服务均已完成。

存储命令对三个生产支付模块执行91%行/函数及80%分支门槛；覆盖率报告命令另外执行
91%语句门槛，生成 `coverage/payment/index.html`、HTML源码视图和
`coverage/payment/lcov.info`。原始需求的“大于90%”及 CI 最低80%门槛没有降低。
真实集成覆盖不能替代原始的整个支付服务单元覆盖率要求。

## CI 和未完成范围

主 CI 执行单元、语法、日志、需求审计和健康检查。专用
`payment-regression.yml` 配置实际存储、保留历史、覆盖率报告、真实进程与 Kafka 检查，
并上传 HTML/LCOV 报告。具体提交的执行结果以 GitHub Actions 为准。

历史 `tests/integration/payment.integration.test.js` 使用另写的模拟路由，不能作为
当前生产支付服务的验收依据；整个旧集成/E2E/契约/安全/性能检查仍需修复。
真实预支付/供应商适配、完整付款闭环、全部合法发货/退款业务流、整个服务的单元覆盖、
旧请求显式接管、全部敏感 MFA/风控边界与生产演练仍未验收。

实现、协议及限制见 [PAYMENT-INTEGRITY.md](../../docs/PAYMENT-INTEGRITY.md)。
所有658项需求仍按 [完成计划](../../docs/requirements/COMPLETION-PLAN.md) 推进。

### 2026-10-28 队列及缓存回归补充

支付原生测试还会先向独立 Kafka topic 写入任务再启动真实消费者，核验积压任务、
运行中新任务及任务类型隔离。ready/DLQ topic 都使用本次测试的独立前缀。
队列单测使用真实指标注册表，覆盖无显式 buckets、失败后下一条任务和死信日志路径。
缓存准备阶段在原有有界期限内取得真实有效的填充令牌，再执行原来的读/失效竞争断言；
不改变生产缓存实现或原始50/100ms门槛。完整队列、支付及安全验收仍未完成。
