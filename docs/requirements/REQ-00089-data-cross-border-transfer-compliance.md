# REQ-00089：数据跨境传输合规与本地化存储策略

- **编号**：REQ-00089
- **类别**：合规/隐私
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service、gateway、database、backend/shared、infrastructure/k8s
- **创建时间**：2026-06-10 13:00
- **依赖需求**：REQ-00016（GDPR 合规）

## 1. 背景与问题

mineGo 作为全球运营的 AR 手游，用户数据分布在不同国家/地区。当前系统存在以下合规风险：

1. **数据跨境传输未管控**：欧洲用户数据可能被传输到美国服务器，违反 GDPR 第 44-49 条数据传输限制
2. **缺乏数据本地化策略**：中国《个人信息保护法》、俄罗斯数据本地化法等要求数据存储在境内
3. **无数据传输审计**：无法追踪哪些数据被跨境传输、传输目的、法律依据
4. **标准合同条款缺失**：未建立与第三国数据处理者的 SCC（Standard Contractual Clauses）协议

## 2. 目标

建立完整的数据跨境传输合规体系：
- 支持按用户地区自动选择数据存储区域
- 跨境传输需记录法律依据（同意、合同履行、公共利益等）
- 自动生成数据传输影响评估报告
- 符合 GDPR、中国 PIPL、俄罗斯数据本地化法等要求

## 3. 范围

- **包含**：
  - 用户地区识别与数据存储区域映射
  - 跨境传输审批工作流
  - 数据传输日志与审计
  - 标准合同条款管理
  - 数据传输影响评估报告生成
  - 数据本地化存储策略配置

- **不包含**：
  - 实际跨区域数据迁移（需单独规划）
  - 第三方数据处理者管理（REQ-00090 范围）

## 4. 详细需求

### 4.1 用户地区识别

```javascript
// 数据存储区域配置
const DataRegions = {
  'EU': { countries: ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', ...], storage: 'eu-west-1', laws: ['GDPR'] },
  'CN': { countries: ['CN', 'HK', 'MO', 'TW'], storage: 'cn-east-1', laws: ['PIPL', 'DSL'] },
  'US': { countries: ['US', 'CA'], storage: 'us-east-1', laws: ['CCPA'] },
  'RU': { countries: ['RU'], storage: 'ru-central-1', laws: ['RU_DATA_LOCALIZATION'] },
  'JP': { countries: ['JP'], storage: 'ap-northeast-1', laws: ['APPI'] },
  'ROW': { countries: ['*'], storage: 'us-east-1', laws: [] }
};
```

### 4.2 跨境传输审批

```sql
CREATE TABLE data_transfer_requests (
  id SERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL,
  source_region VARCHAR(20) NOT NULL,
  target_region VARCHAR(20) NOT NULL,
  data_types TEXT[] NOT NULL, -- ['personal', 'location', 'payment']
  legal_basis VARCHAR(50) NOT NULL, -- 'consent', 'contract', 'legitimate_interest', 'public_interest'
  purpose TEXT NOT NULL,
  recipient_info JSONB,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'executed'
  approved_by INTEGER,
  approved_at TIMESTAMP,
  scc_reference VARCHAR(100), -- 标准合同条款引用
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 4.3 数据传输日志

```sql
CREATE TABLE data_transfer_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  source_region VARCHAR(20),
  target_region VARCHAR(20),
  data_type VARCHAR(50),
  legal_basis VARCHAR(50),
  purpose VARCHAR(200),
  transferred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ip_address INET,
  user_agent TEXT
);
```

### 4.4 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/users/data-region` | GET | 获取用户数据存储区域 |
| `/api/compliance/transfer-request` | POST | 创建跨境传输请求 |
| `/api/compliance/transfer-requests` | GET | 列出传输请求（管理员） |
| `/api/compliance/transfer-requests/:id/approve` | POST | 审批传输请求 |
| `/api/compliance/transfer-logs` | GET | 查询传输日志 |
| `/api/compliance/impact-assessment` | GET | 生成数据传输影响评估报告 |
| `/api/compliance/scc` | GET/POST | 标准合同条款管理 |

### 4.5 数据传输影响评估

自动生成包含以下内容的报告：
- 传输数据类型与数量
- 源地区与目标地区法律环境对比
- 数据保护措施评估
- 风险等级评定
- 建议的保护措施

## 5. 验收标准（可测试）

- [ ] 用户注册时自动分配数据存储区域（基于 IP 或选择的国家）
- [ ] 跨境传输请求创建后状态为 pending，需管理员审批
- [ ] 传输日志记录所有跨境数据访问
- [ ] 影响评估报告包含所有必需章节
- [ ] 单元测试覆盖核心逻辑 80%+
- [ ] API 文档包含所有合规端点

## 6. 工作量估算

**L** - 需要设计数据区域映射、审批工作流、审计日志、报告生成等多个模块，涉及数据库迁移、服务端实现、前端管理界面。

## 7. 优先级理由

P1 级别：数据跨境传输合规是全球运营的法律底线，违规可能导致：
- GDPR 最高罚款 2000 万欧元或全球营业额 4%
- 中国 PIPL 最高罚款 5000 万元人民币
- 业务被迫停止运营风险
