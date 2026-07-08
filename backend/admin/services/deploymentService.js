/**
 * 部署状态管理服务
 * REQ-00492: 部署流水线可视化看板与状态追踪系统
 */

const { EventEmitter } = require('events');

class DeploymentService extends EventEmitter {
  constructor(db, wsGateway = null) {
    super();
    this.db = db;
    this.wsGateway = wsGateway;
  }

  /**
   * 创建新部署记录
   */
  async createDeployment(data) {
    const deploymentId = data.deploymentId || `deploy-${Date.now()}-${data.service}`;
    
    const result = await this.db.query(`
      INSERT INTO deployment_records 
        (deployment_id, service, environment, version, commit_sha, branch, 
         status, started_at, triggered_by, trigger_type, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, 'running', NOW(), $7, $8, $9)
      RETURNING *
    `, [deploymentId, data.service, data.environment, data.version,
        data.commitSha || null, data.branch || null, data.triggeredBy || 'system',
        data.triggerType || 'manual', JSON.stringify(data.metadata || {})]);

    const deployment = result.rows[0];

    // 广播状态更新
    this._broadcast('created', deployment);

    return deployment;
  }

  /**
   * 更新部署状态
   */
  async updateStatus(deploymentId, status, metadata = {}) {
    const updateFields = ['status = $2'];
    const params = [deploymentId, status];

    if (status === 'success' || status === 'failed' || status === 'rolled_back') {
      updateFields.push('completed_at = NOW()');
      
      // 计算耗时
      const startTime = await this.db.query(
        'SELECT started_at FROM deployment_records WHERE deployment_id = $1',
        [deploymentId]
      );
      
      if (startTime.rows[0]?.started_at) {
        const duration = Math.floor((Date.now() - startTime.rows[0].started_at.getTime()) / 1000);
        updateFields.push(`duration_seconds = ${duration}`);
      }
    }

    const result = await this.db.query(`
      UPDATE deployment_records SET ${updateFields.join(', ')}
      WHERE deployment_id = $1
      RETURNING *
    `, params);

    const deployment = result.rows[0];

    this._broadcast('status_update', deployment);

    return deployment;
  }

  /**
   * 添加部署步骤
   */
  async addStep(deploymentId, step) {
    const result = await this.db.query(`
      INSERT INTO deployment_steps 
        (deployment_id, step_name, step_order, status, started_at, log_text)
      VALUES ($1, $2, $3, 'running', NOW(), $4)
      RETURNING *
    `, [deploymentId, step.name, step.order, step.log || '']);

    const stepRecord = result.rows[0];
    this._broadcast('step_started', { deploymentId, step: stepRecord });

    return stepRecord;
  }

  /**
   * 完成部署步骤
   */
  async completeStep(deploymentId, stepOrder, status, data = {}) {
    const result = await this.db.query(`
      UPDATE deployment_steps SET
        status = $3,
        completed_at = NOW(),
        log_text = COALESCE($4, log_text),
        error_message = $5
      WHERE deployment_id = $1 AND step_order = $2
      RETURNING *
    `, [deploymentId, stepOrder, status, data.log || null, data.error || null]);

    const stepRecord = result.rows[0];
    this._broadcast('step_completed', { deploymentId, step: stepRecord });

    return stepRecord;
  }

  /**
   * 添加告警
   */
  async addAlert(deploymentId, type, message) {
    const result = await this.db.query(`
      INSERT INTO deployment_alerts (deployment_id, alert_type, message)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [deploymentId, type, message]);

    const alert = result.rows[0];
    this._broadcast('alert', { deploymentId, alert });

    return alert;
  }

  /**
   * 确认告警
   */
  async acknowledgeAlert(alertId, acknowledgedBy) {
    const result = await this.db.query(`
      UPDATE deployment_alerts SET
        acknowledged = true,
        acknowledged_by = $2,
        acknowledged_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [alertId, acknowledgedBy]);

    return result.rows[0];
  }

  /**
   * 获取当前活跃部署
   */
  async getActiveDeployments(environment = null) {
    let query = `
      SELECT * FROM deployment_records
      WHERE status IN ('pending', 'running')
    `;
    const params = [];

    if (environment) {
      params.push(environment);
      query += ` AND environment = $${params.length}`;
    }

    query += ' ORDER BY started_at DESC';
    
    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * 获取服务部署历史
   */
  async getServiceHistory(service, limit = 20) {
    const result = await this.db.query(`
      SELECT * FROM deployment_records
      WHERE service = $1
      ORDER BY started_at DESC
      LIMIT $2
    `, [service, limit]);
    return result.rows;
  }

  /**
   * 获取部署详情（含步骤）
   */
  async getDeploymentDetails(deploymentId) {
    const deploymentResult = await this.db.query(`
      SELECT * FROM deployment_records WHERE deployment_id = $1
    `, [deploymentId]);

    if (!deploymentResult.rows[0]) {
      return null;
    }

    const stepsResult = await this.db.query(`
      SELECT * FROM deployment_steps
      WHERE deployment_id = $1
      ORDER BY step_order
    `, [deploymentId]);

    const alertsResult = await this.db.query(`
      SELECT * FROM deployment_alerts
      WHERE deployment_id = $1
      ORDER BY created_at
    `, [deploymentId]);

    return {
      deployment: deploymentResult.rows[0],
      steps: stepsResult.rows,
      alerts: alertsResult.rows
    };
  }

  /**
   * 获取所有服务最新状态概览
   */
  async getServicesOverview(environment = 'production') {
    const result = await this.db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (service) deployment_id
        FROM deployment_records
        WHERE environment = $1
        ORDER BY service, started_at DESC
      )
      SELECT 
        dr.*,
        COUNT(ds.id) FILTER (WHERE ds.status = 'success') as success_steps,
        COUNT(ds.id) FILTER (WHERE ds.status = 'failed') as failed_steps,
        COUNT(ds.id) as total_steps
      FROM deployment_records dr
      LEFT JOIN deployment_steps ds ON dr.deployment_id = ds.deployment_id
      WHERE dr.deployment_id IN (SELECT deployment_id FROM latest)
      GROUP BY dr.id
      ORDER BY dr.service
    `, [environment]);

    return result.rows;
  }

  /**
   * 获取所有服务的部署历史（综合）
   */
  async getAllHistory(limit = 50, filters = {}) {
    let query = `
      SELECT * FROM deployment_records
      WHERE 1=1
    `;
    const params = [];

    if (filters.service) {
      params.push(filters.service);
      query += ` AND service = $${params.length}`;
    }

    if (filters.status) {
      params.push(filters.status);
      query += ` AND status = $${params.length}`;
    }

    if (filters.environment) {
      params.push(filters.environment);
      query += ` AND environment = $${params.length}`;
    }

    params.push(limit);
    query += ` ORDER BY started_at DESC LIMIT $${params.length}`;

    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * 清理过期历史记录（90天后）
   */
  async cleanupOldRecords(retentionDays = 90) {
    const result = await this.db.query(`
      DELETE FROM deployment_records
      WHERE completed_at < NOW() - INTERVAL '${retentionDays} days'
      AND status IN ('success', 'failed', 'rolled_back')
      RETURNING deployment_id
    `);

    console.log(`[DeploymentService] 清理了 ${result.rows.length} 条过期记录`);
    return result.rows.length;
  }

  /**
   * 广播事件
   */
  _broadcast(type, data) {
    this.emit(type, data);
    
    if (this.wsGateway) {
      this.wsGateway.broadcast('deployment', { type, ...data });
    }
  }
}

module.exports = DeploymentService;