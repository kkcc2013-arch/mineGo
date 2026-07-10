/**
 * REQ-00527: 数据导出任务队列
 */

const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const logger = require('../shared/logger');
const DataExporter = require('../shared/dataExporter/DataExporter');
const { auditLog } = require('../shared/auditLog');

class DataExportJob {
  constructor(config) {
    this.config = config;
    this.queue = new Queue('data-export', {
      connection: new Redis(config.redis),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        timeout: 30 * 60 * 1000, // 30 minutes
        removeOnComplete: 100,
        removeOnFail: 50
      }
    });
    
    this.worker = null;
    this.db = config.db;
    this.services = config.services;
  }

  /**
   * 创建导出任务
   */
  async create(userId, options) {
    const { format, dataTypes, encrypt = false, sign = false } = options;
    
    // 创建数据库记录
    const result = await this.db.query(`
      INSERT INTO data_export_jobs (user_id, format, data_types, status, encrypt, sign)
      VALUES ($1, $2, $3, 'pending', $4, $5)
      RETURNING id
    `, [userId, format, dataTypes, encrypt, sign]);
    
    const jobId = result.rows[0].id;
    
    // 添加到队列
    await this.queue.add('export', {
      jobId,
      userId,
      format,
      dataTypes,
      encrypt,
      sign,
      requestedAt: new Date().toISOString()
    });
    
    // 审计日志
    await auditLog({
      userId,
      action: 'DATA_EXPORT_REQUESTED',
      resource: 'data_export_job',
      resourceId: jobId,
      metadata: { format, dataTypes, encrypt, sign }
    });
    
    logger.info({ jobId, userId, format }, 'Export job created');
    
    return {
      jobId,
      estimatedTime: this._estimateTime(dataTypes.length, format)
    };
  }

  /**
   * 启动工作进程
   */
  start() {
    this.worker = new Worker('data-export', async (job) => {
      return await this.process(job);
    }, {
      connection: new Redis(this.config.redis),
      concurrency: 5
    });
    
    this.worker.on('completed', (job, result) => {
      logger.info({ jobId: job.data.jobId }, 'Export job completed');
    });
    
    this.worker.on('failed', (job, err) => {
      logger.error({ jobId: job.data.jobId, error: err.message }, 'Export job failed');
    });
    
    logger.info('Data export worker started');
  }

  /**
   * 处理导出任务
   */
  async process(job) {
    const { jobId, userId, format, dataTypes, encrypt, sign } = job.data;
    
    try {
      // 更新状态
      await this._updateStatus(jobId, 'processing', 0);
      
      // 执行导出
      const exporter = new DataExporter({
        ...this.config,
        services: this.services
      });
      
      const result = await exporter.export(userId, {
        format,
        dataTypes,
        encrypt,
        sign
      });
      
      // 更新完成状态
      await this.db.query(`
        UPDATE data_export_jobs
        SET status = 'completed',
            file_path = $1,
            file_size = $2,
            checksum = $3,
            encryption_key_id = $4,
            signature = $5,
            expires_at = $6,
            completed_at = NOW(),
            progress = 100
        WHERE id = $7
      `, [
        result.filePath,
        result.fileSize,
        result.checksum,
        result.encryptionKeyId,
        result.signature,
        result.expiresAt,
        jobId
      ]);
      
      // 审计日志
      await auditLog({
        userId,
        action: 'DATA_EXPORT_COMPLETED',
        resource: 'data_export_job',
        resourceId: jobId,
        metadata: { format, fileSize: result.fileSize }
      });
      
      return result;
    } catch (error) {
      // 更新失败状态
      await this._updateStatus(jobId, 'failed', 0, error.message);
      
      // 审计日志
      await auditLog({
        userId,
        action: 'DATA_EXPORT_FAILED',
        resource: 'data_export_job',
        resourceId: jobId,
        metadata: { error: error.message }
      });
      
      throw error;
    }
  }

  /**
   * 更新任务状态
   */
  async _updateStatus(jobId, status, progress, errorMessage = null) {
    await this.db.query(`
      UPDATE data_export_jobs
      SET status = $1, progress = $2, error_message = $3, updated_at = NOW()
      WHERE id = $4
    `, [status, progress, errorMessage, jobId]);
  }

  /**
   * 获取任务状态
   */
  async getStatus(jobId) {
    const result = await this.db.query(`
      SELECT 
        id, user_id, format, data_types, status, progress,
        file_path, file_size, checksum, encryption_key_id, signature,
        expires_at, error_message, created_at, completed_at
      FROM data_export_jobs
      WHERE id = $1
    `, [jobId]);
    
    return result.rows[0];
  }

  /**
   * 估算导出时间
   */
  _estimateTime(dataTypeCount, format) {
    const baseTime = 30; // seconds
    const perTypeTime = 10;
    const formatMultiplier = { json: 1, csv: 1.2, xml: 1.5, pdf: 2, parquet: 1.3 };
    
    return Math.ceil(baseTime + dataTypeCount * perTypeTime * (formatMultiplier[format] || 1));
  }

  /**
   * 清理过期任务
   */
  async cleanupExpired() {
    const result = await this.db.query(`
      DELETE FROM data_export_jobs
      WHERE expires_at < NOW() AND status IN ('completed', 'failed')
      RETURNING id, file_path
    `);
    
    // 删除文件
    const fs = require('fs').promises;
    for (const row of result.rows) {
      if (row.file_path) {
        try {
          await fs.unlink(row.file_path);
        } catch (err) {
          logger.warn({ filePath: row.file_path, error: err.message }, 'Failed to delete expired file');
        }
      }
    }
    
    logger.info({ count: result.rowCount }, 'Cleaned up expired export jobs');
    return result.rowCount;
  }
}

module.exports = DataExportJob;