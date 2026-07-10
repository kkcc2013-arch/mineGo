/**
 * REQ-00527: 用户数据导出 API 路由
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const rateLimitMiddleware = require('../middleware/exportRateLimiter');
const DataExportJob = require('../../jobs/dataExportJob');
const fs = require('fs').promises;
const logger = require('../../shared/logger');

// 导出任务实例
let exportJob = null;

/**
 * 初始化导出任务
 */
router.initExportJob = (config) => {
  exportJob = new DataExportJob(config);
  exportJob.start();
};

/**
 * POST /api/v1/user/data-export
 * 请求导出用户数据
 */
router.post('/', 
  authMiddleware.requireAuth,
  rateLimitMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { format = 'json', dataTypes, encrypt = false, sign = false } = req.body;
      
      // 验证参数
      const validFormats = ['json', 'csv', 'xml', 'pdf', 'parquet'];
      if (!validFormats.includes(format)) {
        return res.status(400).json({
          error: 'Invalid format',
          message: `Format must be one of: ${validFormats.join(', ')}`
        });
      }
      
      if (!dataTypes || !Array.isArray(dataTypes) || dataTypes.length === 0) {
        return res.status(400).json({
          error: 'Invalid dataTypes',
          message: 'dataTypes must be a non-empty array'
        });
      }
      
      const validDataTypes = [
        'profile', 'pokemon', 'items', 'transactions',
        'friends', 'achievements', 'battles', 'locations',
        'notifications', 'settings'
      ];
      
      for (const type of dataTypes) {
        if (!validDataTypes.includes(type)) {
          return res.status(400).json({
            error: 'Invalid data type',
            message: `Invalid data type: ${type}. Valid types: ${validDataTypes.join(', ')}`
          });
        }
      }
      
      // 创建导出任务
      const result = await exportJob.create(userId, {
        format,
        dataTypes,
        encrypt,
        sign
      });
      
      logger.info({ userId, jobId: result.jobId, format }, 'Export requested');
      
      res.status(202).json({
        jobId: result.jobId,
        status: 'pending',
        estimatedTimeSeconds: result.estimatedTime,
        message: 'Export job created. Poll status endpoint for updates.'
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Export request failed');
      res.status(500).json({
        error: 'Export failed',
        message: error.message
      });
    }
  }
);

/**
 * GET /api/v1/user/data-export/:jobId
 * 查询导出任务状态
 */
router.get('/:jobId', 
  authMiddleware.requireAuth,
  async (req, res) => {
    try {
      const { jobId } = req.params;
      const userId = req.user.id;
      
      const job = await exportJob.getStatus(jobId);
      
      if (!job) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Export job not found'
        });
      }
      
      // 验证所有权
      if (job.user_id !== userId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You do not have access to this export job'
        });
      }
      
      const response = {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        format: job.format,
        dataTypes: job.data_types,
        createdAt: job.created_at
      };
      
      if (job.status === 'completed') {
        response.downloadUrl = `/api/v1/user/data-export/${jobId}/download`;
        response.expiresAt = job.expires_at;
        response.fileSize = job.file_size;
        response.checksum = job.checksum;
      } else if (job.status === 'failed') {
        response.error = job.error_message;
      }
      
      res.json(response);
    } catch (error) {
      logger.error({ error: error.message }, 'Status query failed');
      res.status(500).json({
        error: 'Status query failed',
        message: error.message
      });
    }
  }
);

/**
 * GET /api/v1/user/data-export/:jobId/download
 * 下载导出文件
 */
router.get('/:jobId/download',
  authMiddleware.requireAuth,
  async (req, res) => {
    try {
      const { jobId } = req.params;
      const userId = req.user.id;
      
      const job = await exportJob.getStatus(jobId);
      
      if (!job) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Export job not found'
        });
      }
      
      // 验证所有权
      if (job.user_id !== userId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You do not have access to this file'
        });
      }
      
      // 验证状态
      if (job.status !== 'completed') {
        return res.status(400).json({
          error: 'Not ready',
          message: 'Export job is not completed'
        });
      }
      
      // 验证有效期
      if (new Date(job.expires_at) < new Date()) {
        return res.status(410).json({
          error: 'Expired',
          message: 'Download link has expired'
        });
      }
      
      // 读取文件
      const fileData = await fs.readFile(job.file_path);
      const fileName = `user-data-${userId}.${job.format}`;
      
      // 设置响应头
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', fileData.length);
      res.setHeader('X-Checksum', job.checksum);
      
      if (job.signature) {
        res.setHeader('X-Signature', job.signature);
      }
      
      res.send(fileData);
      
      logger.info({ userId, jobId }, 'File downloaded');
    } catch (error) {
      logger.error({ error: error.message }, 'Download failed');
      res.status(500).json({
        error: 'Download failed',
        message: error.message
      });
    }
  }
);

/**
 * GET /api/v1/user/data-export/formats
 * 获取支持的导出格式列表
 */
router.get('/formats/info', (req, res) => {
  res.json({
    formats: [
      {
        name: 'json',
        mimeType: 'application/json',
        description: 'Machine-readable JSON format, ideal for data migration',
        useCase: 'Recommended for transferring data to another platform'
      },
      {
        name: 'csv',
        mimeType: 'text/csv',
        description: 'Tabular format suitable for spreadsheet analysis',
        useCase: 'Ideal for manual data review in Excel or Google Sheets'
      },
      {
        name: 'xml',
        mimeType: 'application/xml',
        description: 'Enterprise integration format with schema validation',
        useCase: 'Suitable for enterprise system integration'
      },
      {
        name: 'pdf',
        mimeType: 'application/pdf',
        description: 'Human-readable PDF report for user review',
        useCase: 'Ideal for personal record keeping'
      },
      {
        name: 'parquet',
        mimeType: 'application/octet-stream',
        description: 'Columnar storage format for big data analytics',
        useCase: 'Recommended for data analysis with Apache Spark'
      }
    ],
    dataTypes: [
      { name: 'profile', description: 'User profile and settings' },
      { name: 'pokemon', description: 'Caught pokemon collection' },
      { name: 'items', description: 'Inventory items' },
      { name: 'transactions', description: 'Payment and transaction history' },
      { name: 'friends', description: 'Friend list and social connections' },
      { name: 'achievements', description: 'Achievements and badges' },
      { name: 'battles', description: 'Battle history' },
      { name: 'locations', description: 'Location history (fuzzy)' }
    ],
    options: {
      encrypt: 'Encrypt file with AES-256 (recommended)',
      sign: 'Add digital signature for integrity verification'
    }
  });
});

module.exports = router;