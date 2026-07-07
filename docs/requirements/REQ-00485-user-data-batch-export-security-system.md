# REQ-00485: 用户数据批量导出安全管控与审计系统

- **编号**：REQ-00485
- **类别**：反作弊/安全加固
- **优先级**：P1
- **状态**：done
- **涉及服务**：user-service/gdpr-service/admin-dashboard
- **创建时间**：2026-07-07 13:00 UTC
- **依赖需求**：REQ-00016（GDPR合规系统）

## 1. 背景与问题

mineGo 项目已实现 GDPR 用户数据导出功能（REQ-00016），但当前实现存在严重安全隐患和滥用风险：

**当前痛点：**
1. **缺乏频率限制**：攻击者可以高频请求导出功能，消耗服务器资源，影响正常用户
2. **无批量导出防护**：管理员可无限制导出大量用户数据，存在数据泄露风险
3. **缺少审计追踪**：数据导出操作缺乏详细的审计日志，无法追溯滥用行为
4. **敏感数据未脱敏**：导出数据包含完整的支付信息、精确GPS轨迹等敏感内容
5. **无异常行为检测**：无法识别批量数据窃取、竞争对手爬取等恶意行为

**真实代码现状：**
- `gdprService.js` 实现了基础数据导出，但无任何安全防护措施
- `exportUserData()` 直接返回完整数据，包括敏感字段
- 无导出次数限制、无审批流程、无异常检测

**安全风险：**
- 内部人员滥用权限批量导出用户数据
- 外部攻击者通过账号盗用获取大量用户隐私
- 违反GDPR最小化原则，过度收集数据
- 数据泄露无法溯源和追责

## 2. 目标

构建完整的用户数据导出安全管控体系，在保障用户数据权利的同时防止滥用：

- **多层限流机制**：用户级、管理员级、系统级多维度限流
- **审批工作流**：管理员批量导出需经过审批和授权
- **数据脱敏引擎**：根据数据类型自动脱敏敏感字段
- **全链路审计**：记录所有导出操作的详细日志
- **异常检测系统**：识别批量数据窃取、异常导出模式

**可量化目标：**
- 用户导出频率限制：每月最多 2 次
- 管理员批量导出上限：单次最多 1000 用户
- 敏感数据脱敏率：100%
- 审计日志完整率：100%
- 异常导出检测准确率：> 90%

## 3. 范围

**包含：**
- 用户导出频率限制中间件
- 管理员批量导出审批工作流
- 敏感数据脱敏规则引擎
- 导出操作审计日志系统
- 异常导出行为检测算法
- 导出数据加密存储与传输
- 导出任务队列与异步处理
- 导出文件自动过期清理

**不包含：**
- 用户数据删除功能（REQ-00016 已实现）
- 数据导出格式定制（仅支持JSON/CSV）
- 第三方数据源导出（仅限mineGo系统内数据）

## 4. 详细需求

### 4.1 用户导出频率限制

创建 `backend/services/user-service/src/middleware/exportRateLimiter.js`：

```javascript
/**
 * 用户数据导出频率限制中间件
 */
class ExportRateLimiter {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
    
    // 限制配置
    this.limits = {
      user: {
        maxRequests: 2,           // 每月最多2次
        windowSeconds: 30 * 24 * 3600  // 30天窗口
      },
      admin: {
        maxRequestsPerDay: 10,    // 每天最多10次批量导出
        maxUsersPerRequest: 1000  // 单次最多1000用户
      }
    };
  }

  /**
   * 检查用户导出限制
   */
  async checkUserExportLimit(userId) {
    const key = `export:user:${userId}`;
    const now = Date.now();
    const windowStart = now - this.limits.user.windowSeconds * 1000;
    
    // 获取窗口内的导出记录
    const exports = await this.redis.zrangebyscore(
      key,
      windowStart,
      '+inf',
      'WITHSCORES'
    );
    
    const count = exports.length / 2;
    
    if (count >= this.limits.user.maxRequests) {
      // 获取最早的导出时间，计算冷却时间
      const oldestExport = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      const cooldownSeconds = Math.ceil(
        (this.limits.user.windowSeconds * 1000 - (now - oldestExport[1])) / 1000
      );
      
      return {
        allowed: false,
        reason: 'RATE_LIMIT_EXCEEDED',
        message: `本月导出次数已达上限，请${this._formatCooldown(cooldownSeconds)}后再试`,
        nextAvailableAt: new Date(now + cooldownSeconds * 1000).toISOString(),
        currentCount: count,
        maxCount: this.limits.user.maxRequests
      };
    }
    
    return {
      allowed: true,
      currentCount: count,
      maxCount: this.limits.user.maxRequests,
      remaining: this.limits.user.maxRequests - count
    };
  }

  /**
   * 记录导出操作
   */
  async recordUserExport(userId, requestId) {
    const key = `export:user:${userId}`;
    const now = Date.now();
    
    // 添加导出记录
    await this.redis.zadd(key, now, requestId);
    
    // 设置过期时间
    await this.redis.expire(key, this.limits.user.windowSeconds);
    
    // 写入数据库审计日志
    await this.db.query(`
      INSERT INTO export_audit_log 
        (request_id, user_id, export_type, status, created_at)
      VALUES ($1, $2, 'user', 'initiated', NOW())
    `, [requestId, userId]);
  }

  /**
   * 检查管理员批量导出限制
   */
  async checkAdminExportLimit(adminId, userCount) {
    // 检查单次导出数量
    if (userCount > this.limits.admin.maxUsersPerRequest) {
      return {
        allowed: false,
        reason: 'BATCH_SIZE_EXCEEDED',
        message: `单次导出用户数不能超过 ${this.limits.admin.maxUsersPerRequest}`,
        maxUsers: this.limits.admin.maxUsersPerRequest
      };
    }
    
    // 检查每日导出次数
    const today = new Date().toISOString().split('T')[0];
    const key = `export:admin:${adminId}:${today}`;
    const count = await this.redis.incr(key);
    
    if (count === 1) {
      await this.redis.expire(key, 24 * 3600);
    }
    
    if (count > this.limits.admin.maxRequestsPerDay) {
      return {
        allowed: false,
        reason: 'DAILY_LIMIT_EXCEEDED',
        message: `今日批量导出次数已达上限`,
        currentCount: count,
        maxCount: this.limits.admin.maxRequestsPerDay
      };
    }
    
    return {
      allowed: true,
      currentCount: count,
      maxCount: this.limits.admin.maxRequestsPerDay,
      remaining: this.limits.admin.maxRequestsPerDay - count
    };
  }

  _formatCooldown(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    
    if (days > 0) return `${days}天`;
    if (hours > 0) return `${hours}小时`;
    return `${Math.floor(seconds / 60)}分钟`;
  }
}

module.exports = ExportRateLimiter;
```

### 4.2 管理员批量导出审批工作流

创建 `backend/services/user-service/src/workflows/exportApprovalWorkflow.js`：

```javascript
/**
 * 批量导出审批工作流
 */
class ExportApprovalWorkflow {
  constructor(db, eventBus, notificationService) {
    this.db = db;
    this.eventBus = eventBus;
    this.notificationService = notificationService;
    
    // 审批流程配置
    this.approvalThresholds = {
      small: { min: 1, max: 100, approvers: 1 },      // 小批量：1人审批
      medium: { min: 101, max: 500, approvers: 2 },   // 中批量：2人审批
      large: { min: 501, max: 1000, approvers: 3 }    // 大批量：3人审批
    };
  }

  /**
   * 提交批量导出申请
   */
  async submitExportRequest(adminId, request) {
    const { userIds, reason, filters } = request;
    
    // 确定审批级别
    const size = userIds.length;
    const approvalLevel = this._getApprovalLevel(size);
    
    // 创建审批请求
    const result = await this.db.query(`
      INSERT INTO export_approval_requests
        (admin_id, user_count, user_ids, reason, filters, 
         approval_level, required_approvers, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
      RETURNING id
    `, [
      adminId,
      size,
      JSON.stringify(userIds),
      reason,
      JSON.stringify(filters),
      approvalLevel.level,
      approvalLevel.approvers
    ]);
    
    const requestId = result.rows[0].id;
    
    // 发送审批通知
    await this._sendApprovalNotifications(requestId, adminId, size, reason);
    
    // 发布事件
    await this.eventBus.publish('export.request.submitted', {
      requestId,
      adminId,
      userCount: size,
      approvalLevel: approvalLevel.level
    });
    
    return {
      requestId,
      status: 'pending',
      approvalLevel: approvalLevel.level,
      requiredApprovers: approvalLevel.approvers
    };
  }

  /**
   * 审批导出请求
   */
  async approveExportRequest(requestId, approverId, comment) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 检查请求状态
      const request = await client.query(`
        SELECT * FROM export_approval_requests
        WHERE id = $1 AND status = 'pending'
        FOR UPDATE
      `, [requestId]);
      
      if (request.rows.length === 0) {
        throw new Error('Request not found or already processed');
      }
      
      const requestData = request.rows[0];
      
      // 检查审批人权限（需要不同人员）
      if (requestData.admin_id === approverId) {
        throw new Error('Cannot approve own request');
      }
      
      // 记录审批
      await client.query(`
        INSERT INTO export_approvals
          (request_id, approver_id, action, comment, created_at)
        VALUES ($1, $2, 'approved', $3, NOW())
      `, [requestId, approverId, comment]);
      
      // 更新已审批人数
      const updatedRequest = await client.query(`
        UPDATE export_approval_requests
        SET current_approvers = current_approvers + 1,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [requestId]);
      
      const current = updatedRequest.rows[0];
      
      // 检查是否达到审批人数
      if (current.current_approvers >= current.required_approvers) {
        // 标记为已批准
        await client.query(`
          UPDATE export_approval_requests
          SET status = 'approved', 
              approved_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `, [requestId]);
        
        // 触发导出任务
        await this._triggerExportTask(requestId);
        
        await client.query('COMMIT');
        
        return {
          status: 'approved',
          message: 'Export request approved and task triggered',
          requestId
        };
      }
      
      await client.query('COMMIT');
      
      return {
        status: 'pending',
        message: `Approved (${current.current_approvers}/${current.required_approvers})`,
        requestId,
        remaining: current.required_approvers - current.current_approvers
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 拒绝导出请求
   */
  async rejectExportRequest(requestId, approverId, reason) {
    const result = await this.db.query(`
      UPDATE export_approval_requests
      SET status = 'rejected',
          rejected_by = $2,
          reject_reason = $3,
          rejected_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING admin_id
    `, [requestId, approverId, reason]);
    
    if (result.rows.length === 0) {
      throw new Error('Request not found or already processed');
    }
    
    // 通知申请人
    await this.notificationService.send(
      result.rows[0].admin_id,
      'export_request_rejected',
      { requestId, reason }
    );
    
    // 记录审计日志
    await this.eventBus.publish('export.request.rejected', {
      requestId,
      rejectedBy: approverId,
      reason
    });
    
    return { status: 'rejected', requestId };
  }

  _getApprovalLevel(size) {
    for (const [level, config] of Object.entries(this.approvalThresholds)) {
      if (size >= config.min && size <= config.max) {
        return { level, ...config };
      }
    }
    throw new Error('Export size exceeds maximum allowed');
  }

  async _sendApprovalNotifications(requestId, adminId, size, reason) {
    // 获取有审批权限的管理员
    const approvers = await this.db.query(`
      SELECT user_id FROM admin_users
      WHERE role IN ('super_admin', 'data_protection_officer')
      AND user_id != $1
    `, [adminId]);
    
    // 发送通知
    for (const approver of approvers.rows) {
      await this.notificationService.send(
        approver.user_id,
        'export_approval_required',
        { requestId, userCount: size, reason }
      );
    }
  }

  async _triggerExportTask(requestId) {
    // 将导出任务加入队列
    await this.eventBus.publish('export.task.created', { requestId });
  }
}

module.exports = ExportApprovalWorkflow;
```

### 4.3 敏感数据脱敏引擎

创建 `backend/services/user-service/src/utils/dataMaskingEngine.js`：

```javascript
/**
 * 数据脱敏引擎
 * 根据数据类型和用户角色自动脱敏敏感字段
 */
class DataMaskingEngine {
  constructor() {
    // 脱敏规则定义
    this.maskingRules = {
      // 用户数据
      user: {
        email: { type: 'email', partial: true },
        phone: { type: 'phone', showLast: 4 },
        real_name: { type: 'name', showFirst: 1 },
        id_number: { type: 'full' },
        password_hash: { type: 'full' },
        two_factor_secret: { type: 'full' }
      },
      // 支付数据
      payment: {
        card_number: { type: 'card', showLast: 4 },
        card_holder: { type: 'name', showFirst: 1 },
        cvv: { type: 'full' },
        billing_address: { type: 'address', partial: true }
      },
      // 位置数据
      location: {
        exact_gps: { type: 'gps', precision: 0.001 },  // 精度降低到100米
        ip_address: { type: 'ip', partial: true },
        device_id: { type: 'device', showLast: 8 }
      },
      // 社交数据
      social: {
        friend_ids: { type: 'list', maxShow: 10 },
        messages: { type: 'content', maxLength: 100 }
      }
    };
    
    // 角色权限配置
    this.rolePermissions = {
      user: ['user.email', 'user.real_name'],
      admin: ['user.email', 'user.phone', 'user.real_name', 'location.ip_address'],
      data_protection_officer: ['*'],  // 完全访问
      auditor: []  // 全部脱敏
    };
  }

  /**
   * 脱敏数据
   * @param {string} dataType - 数据类型（user/payment/location等）
   * @param {object} data - 原始数据
   * @param {string} requesterRole - 请求者角色
   * @returns {object} 脱敏后的数据
   */
  mask(dataType, data, requesterRole) {
    const rules = this.maskingRules[dataType];
    if (!rules) return data;
    
    const permissions = this.rolePermissions[requesterRole] || [];
    const maskedData = { ...data };
    
    for (const [field, rule] of Object.entries(rules)) {
      if (!maskedData[field]) continue;
      
      // 检查是否有权限访问该字段
      const fieldPath = `${dataType}.${field}`;
      const hasPermission = permissions.includes('*') || permissions.includes(fieldPath);
      
      if (!hasPermission) {
        maskedData[field] = this._applyMasking(maskedData[field], rule);
      }
    }
    
    return maskedData;
  }

  /**
   * 应用脱敏规则
   */
  _applyMasking(value, rule) {
    switch (rule.type) {
      case 'email':
        return this._maskEmail(value, rule.partial);
      
      case 'phone':
        return this._maskPhone(value, rule.showLast);
      
      case 'name':
        return this._maskName(value, rule.showFirst);
      
      case 'card':
        return this._maskCardNumber(value, rule.showLast);
      
      case 'gps':
        return this._maskGPS(value, rule.precision);
      
      case 'ip':
        return this._maskIP(value, rule.partial);
      
      case 'full':
        return '***';
      
      case 'list':
        return this._maskList(value, rule.maxShow);
      
      case 'content':
        return this._maskContent(value, rule.maxLength);
      
      default:
        return value;
    }
  }

  _maskEmail(email, partial) {
    if (!partial) return '***@***.***';
    const [local, domain] = email.split('@');
    const maskedLocal = local[0] + '***' + local.slice(-1);
    return `${maskedLocal}@${domain}`;
  }

  _maskPhone(phone, showLast) {
    const visible = phone.slice(-showLast);
    return '*'.repeat(phone.length - showLast) + visible;
  }

  _maskName(name, showFirst) {
    return name[0] + '***';
  }

  _maskCardNumber(number, showLast) {
    const visible = number.slice(-showLast);
    return '*'.repeat(number.length - showLast) + visible;
  }

  _maskGPS(coords, precision) {
    // 降低GPS精度，防止精确定位
    if (typeof coords === 'object') {
      return {
        lat: Math.round(coords.lat / precision) * precision,
        lng: Math.round(coords.lng / precision) * precision
      };
    }
    return coords;
  }

  _maskIP(ip, partial) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.***.***`;
    }
    return '***.***.***.***';
  }

  _maskList(list, maxShow) {
    if (!Array.isArray(list)) return list;
    if (list.length <= maxShow) return list;
    
    return {
      items: list.slice(0, maxShow),
      total: list.length,
      truncated: true
    };
  }

  _maskContent(content, maxLength) {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength) + '...';
  }

  /**
   * 批量脱敏
   */
  maskBatch(dataType, dataArray, requesterRole) {
    return dataArray.map(data => this.mask(dataType, data, requesterRole));
  }
}

module.exports = DataMaskingEngine;
```

### 4.4 异常导出检测算法

创建 `backend/services/user-service/src/detection/exportAnomalyDetector.js`：

```javascript
/**
 * 导出异常检测器
 * 识别批量数据窃取、异常导出模式
 */
class ExportAnomalyDetector {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
    
    // 检测阈值
    this.thresholds = {
      // 单用户短时间内导出次数
      rapidExportCount: 3,
      rapidExportWindow: 3600,  // 1小时
      
      // 管理员批量导出异常
      adminBulkExportUsers: 500,
      adminExportFrequency: 5,  // 单日5次
      
      // 异常时段导出（凌晨2-5点）
      abnormalHours: [2, 3, 4, 5],
      
      // 短时间大量用户数据导出
      burstExportCount: 100,
      burstExportWindow: 600  // 10分钟
    };
  }

  /**
   * 检测导出异常
   */
  async detect(userId, isAdmin = false) {
    const anomalies = [];
    
    // 1. 快速重复导出检测
    const rapidExport = await this._detectRapidExport(userId);
    if (rapidExport) {
      anomalies.push(rapidExport);
    }
    
    // 2. 管理员异常批量导出
    if (isAdmin) {
      const adminAnomaly = await this._detectAdminAnomaly(userId);
      if (adminAnomaly) {
        anomalies.push(adminAnomaly);
      }
    }
    
    // 3. 异常时段导出
    const timeAnomaly = this._detectAbnormalTime();
    if (timeAnomaly) {
      anomalies.push(timeAnomaly);
    }
    
    // 4. 突发性导出检测（系统级）
    const burstAnomaly = await this._detectBurstExport();
    if (burstAnomaly) {
      anomalies.push(burstAnomaly);
    }
    
    // 5. 历史行为对比
    const behaviorAnomaly = await this._detectBehaviorChange(userId, isAdmin);
    if (behaviorAnomaly) {
      anomalies.push(behaviorAnomaly);
    }
    
    if (anomalies.length > 0) {
      await this._logAnomaly(userId, anomalies);
    }
    
    return {
      hasAnomaly: anomalies.length > 0,
      anomalies,
      riskScore: this._calculateRiskScore(anomalies),
      recommendedAction: this._getRecommendedAction(anomalies)
    };
  }

  /**
   * 检测快速重复导出
   */
  async _detectRapidExport(userId) {
    const key = `export:rapid:${userId}`;
    const now = Date.now();
    const windowStart = now - this.thresholds.rapidExportWindow * 1000;
    
    // 获取窗口内导出次数
    const count = await this.redis.zcount(key, windowStart, '+inf');
    
    if (count >= this.thresholds.rapidExportCount) {
      return {
        type: 'RAPID_EXPORT',
        severity: 'high',
        message: `短时间内多次导出数据（${count}次）`,
        count,
        threshold: this.thresholds.rapidExportCount
      };
    }
    
    return null;
  }

  /**
   * 检测管理员异常
   */
  async _detectAdminAnomaly(adminId) {
    const today = new Date().toISOString().split('T')[0];
    
    // 查询今日导出统计
    const result = await this.db.query(`
      SELECT 
        COUNT(*) as export_count,
        SUM(user_count) as total_users
      FROM export_audit_log
      WHERE admin_id = $1
        AND DATE(created_at) = $2
        AND export_type = 'admin_bulk'
    `, [adminId, today]);
    
    const stats = result.rows[0];
    
    // 检查单日导出频次
    if (parseInt(stats.export_count) >= this.thresholds.adminExportFrequency) {
      return {
        type: 'ADMIN_EXPORT_FREQUENCY',
        severity: 'critical',
        message: `管理员单日导出次数异常（${stats.export_count}次）`,
        count: stats.export_count,
        threshold: this.thresholds.adminExportFrequency
      };
    }
    
    // 检查导出用户总数
    if (parseInt(stats.total_users) >= this.thresholds.adminBulkExportUsers) {
      return {
        type: 'ADMIN_BULK_EXPORT',
        severity: 'critical',
        message: `管理员导出用户数量异常（${stats.total_users}用户）`,
        count: stats.total_users,
        threshold: this.thresholds.adminBulkExportUsers
      };
    }
    
    return null;
  }

  /**
   * 检测异常时段
   */
  _detectAbnormalTime() {
    const hour = new Date().getHours();
    
    if (this.thresholds.abnormalHours.includes(hour)) {
      return {
        type: 'ABNORMAL_TIME',
        severity: 'medium',
        message: `异常时段导出数据（${hour}:00）`,
        hour
      };
    }
    
    return null;
  }

  /**
   * 检测突发性导出（系统级）
   */
  async _detectBurstExport() {
    const key = 'export:system:burst';
    const now = Date.now();
    const windowStart = now - this.thresholds.burstExportWindow * 1000;
    
    const count = await this.redis.zcount(key, windowStart, '+inf');
    
    if (count >= this.thresholds.burstExportCount) {
      return {
        type: 'BURST_EXPORT',
        severity: 'critical',
        message: `系统短时间内大量导出（${count}次）`,
        count,
        threshold: this.thresholds.burstExportCount
      };
    }
    
    return null;
  }

  /**
   * 检测行为变化
   */
  async _detectBehaviorChange(userId, isAdmin) {
    // 获取用户历史导出行为基线
    const baseline = await this._getUserBaseline(userId, isAdmin);
    
    // 获取近期行为
    const recent = await this._getRecentBehavior(userId, isAdmin);
    
    // 对比检测
    if (recent.exportCount > baseline.avgExportCount * 3) {
      return {
        type: 'BEHAVIOR_CHANGE',
        severity: 'high',
        message: '导出行为显著偏离历史基线',
        baseline: baseline.avgExportCount,
        recent: recent.exportCount
      };
    }
    
    return null;
  }

  /**
   * 计算风险分数
   */
  _calculateRiskScore(anomalies) {
    const severityWeights = {
      critical: 40,
      high: 25,
      medium: 10,
      low: 5
    };
    
    const score = anomalies.reduce((sum, anomaly) => {
      return sum + (severityWeights[anomaly.severity] || 0);
    }, 0);
    
    return Math.min(score, 100);  // 上限100分
  }

  /**
   * 获取推荐操作
   */
  _getRecommendedAction(anomalies) {
    const score = this._calculateRiskScore(anomalies);
    
    if (score >= 80) {
      return 'BLOCK_AND_ALERT';
    } else if (score >= 50) {
      return 'REQUIRE_MFA';
    } else if (score >= 30) {
      return 'LOG_AND_MONITOR';
    }
    
    return 'ALLOW_WITH_LOG';
  }

  async _logAnomaly(userId, anomalies) {
    await this.db.query(`
      INSERT INTO export_anomaly_log
        (user_id, anomalies, risk_score, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [userId, JSON.stringify(anomalies), this._calculateRiskScore(anomalies)]);
  }

  async _getUserBaseline(userId, isAdmin) {
    // 简化实现：返回平均基线
    return {
      avgExportCount: isAdmin ? 2 : 0.5
    };
  }

  async _getRecentBehavior(userId, isAdmin) {
    const result = await this.db.query(`
      SELECT COUNT(*) as export_count
      FROM export_audit_log
      WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '7 days'
    `, [userId]);
    
    return {
      exportCount: parseInt(result.rows[0].export_count)
    };
  }
}

module.exports = ExportAnomalyDetector;
```

### 4.5 导出任务队列与异步处理

创建 `backend/services/user-service/src/queue/exportTaskQueue.js`：

```javascript
/**
 * 导出任务队列
 * 异步处理大批量数据导出，避免阻塞主线程
 */
const Bull = require('bull');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('export-queue');

class ExportTaskQueue {
  constructor(redisConfig) {
    this.queue = new Bull('export-tasks', {
      redis: redisConfig,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000
        }
      }
    });
    
    this._setupProcessors();
    this._setupEventHandlers();
  }

  /**
   * 添加导出任务
   */
  async addExportTask(requestId, taskData) {
    const job = await this.queue.add('export', {
      requestId,
      ...taskData,
      createdAt: new Date().toISOString()
    }, {
      jobId: requestId,
      timeout: 30 * 60 * 1000  // 30分钟超时
    });
    
    logger.info({ requestId, jobId: job.id }, 'Export task added to queue');
    
    return {
      jobId: job.id,
      status: 'queued',
      estimatedTime: this._estimateProcessingTime(taskData.userCount)
    };
  }

  /**
   * 设置任务处理器
   */
  _setupProcessors() {
    this.queue.process('export', async (job) => {
      const { requestId, userIds, adminId } = job.data;
      
      try {
        // 更新任务状态
        job.progress(10);
        
        // 执行数据导出
        const exportService = require('../gdprService');
        const exportData = await exportService.exportBatch(userIds, adminId);
        
        job.progress(60);
        
        // 加密导出文件
        const encryptedFile = await this._encryptExport(exportData);
        
        job.progress(80);
        
        // 上传到临时存储
        const fileUrl = await this._uploadToTempStorage(encryptedFile, requestId);
        
        job.progress(90);
        
        // 更新数据库状态
        await this._markExportComplete(requestId, fileUrl);
        
        // 发送通知
        await this._sendCompletionNotification(requestId, adminId);
        
        job.progress(100);
        
        return { success: true, fileUrl };
        
      } catch (error) {
        logger.error({ requestId, error: error.message }, 'Export task failed');
        await this._markExportFailed(requestId, error.message);
        throw error;
      }
    });
  }

  /**
   * 设置事件处理器
   */
  _setupEventHandlers() {
    this.queue.on('completed', (job, result) => {
      logger.info({ jobId: job.id }, 'Export task completed');
    });
    
    this.queue.on('failed', (job, err) => {
      logger.error({ jobId: job.id, error: err.message }, 'Export task failed');
    });
    
    this.queue.on('progress', (job, progress) => {
      logger.debug({ jobId: job.id, progress }, 'Export task progress');
    });
    
    this.queue.on('stalled', (job) => {
      logger.warn({ jobId: job.id }, 'Export task stalled');
    });
  }

  /**
   * 获取任务状态
   */
  async getTaskStatus(jobId) {
    const job = await this.queue.getJob(jobId);
    
    if (!job) {
      return { status: 'not_found' };
    }
    
    const state = await job.getState();
    const progress = job.progress();
    
    return {
      status: state,
      progress,
      data: job.returnvalue,
      failedReason: job.failedReason,
      timestamp: job.timestamp
    };
  }

  /**
   * 取消任务
   */
  async cancelTask(jobId) {
    const job = await this.queue.getJob(jobId);
    
    if (job) {
      await job.remove();
      logger.info({ jobId }, 'Export task cancelled');
      return { cancelled: true };
    }
    
    return { cancelled: false, reason: 'not_found' };
  }

  _estimateProcessingTime(userCount) {
    // 每秒处理约100用户
    return Math.ceil(userCount / 100);
  }

  async _encryptExport(data) {
    const crypto = require('crypto');
    const algorithm = 'aes-256-gcm';
    const key = Buffer.from(process.env.EXPORT_ENCRYPTION_KEY, 'hex');
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data)),
      cipher.final()
    ]);
    
    return {
      iv: iv.toString('hex'),
      data: encrypted.toString('base64'),
      authTag: cipher.getAuthTag().toString('hex')
    };
  }

  async _uploadToTempStorage(encryptedData, requestId) {
    // 上传到临时存储（S3/MinIO等）
    // 文件7天后自动删除
    const s3Client = require('../../../shared/storage/s3Client');
    const key = `exports/${requestId}.json.enc`;
    
    await s3Client.upload(key, JSON.stringify(encryptedData), {
      Expires: new Date(Date.now() + 7 * 24 * 3600 * 1000)
    });
    
    // 返回带签名的临时URL
    return s3Client.getSignedUrl(key, 3600);  // 1小时有效
  }

  async _markExportComplete(requestId, fileUrl) {
    await this.db.query(`
      UPDATE export_approval_requests
      SET status = 'completed',
          file_url = $2,
          completed_at = NOW()
      WHERE id = $1
    `, [requestId, fileUrl]);
  }

  async _markExportFailed(requestId, error) {
    await this.db.query(`
      UPDATE export_approval_requests
      SET status = 'failed',
          error_message = $2,
          failed_at = NOW()
      WHERE id = $1
    `, [requestId, error]);
  }

  async _sendCompletionNotification(requestId, adminId) {
    const notificationService = require('../../../shared/notification');
    await notificationService.send(adminId, 'export_completed', { requestId });
  }
}

module.exports = ExportTaskQueue;
```

## 5. 验收标准（可测试）

- [ ] 用户导出频率限制生效，每月超过2次导出返回429错误
- [ ] 管理员批量导出超过1000用户返回错误提示
- [ ] 管理员批量导出需经过审批流程，至少1-3人审批
- [ ] 导出数据中敏感字段（邮箱、电话、GPS等）已自动脱敏
- [ ] 所有导出操作记录到审计日志，包含请求人、时间、用户列表
- [ ] 异常导出行为（短时间多次、异常时段、大批量）被正确检测
- [ ] 高风险导出操作触发二次验证或管理员通知
- [ ] 导出文件加密存储，URL有效期不超过24小时
- [ ] 异步导出任务队列正常工作，支持进度查询
- [ ] 导出文件7天后自动删除
- [ ] 新增单元测试覆盖率 > 80%

## 6. 工作量估算

**工作量：L（Large）**

**理由：**
- 频率限制中间件开发（~300行）