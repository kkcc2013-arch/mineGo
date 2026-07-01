'use strict';

/**
 * REQ-00398: 缺失翻译检测定时任务
 * 每天凌晨检查所有错误码的翻译完整性
 */

const { db } = require('../shared/db');
const logger = require('../shared/logger');
const nodemailer = require('nodemailer');
const translationMetrics = require('../shared/translationMetrics');

// 支持的语言列表
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP', 'zh-TW', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE'];

// 核心错误码（必须有翻译）
const CRITICAL_ERROR_CODES = [
  'SUCCESS',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL_ERROR',
  'INVALID_REQUEST',
  'RATE_LIMIT_EXCEEDED',
  'POKEMON_NOT_FOUND',
  'CATCH_FAILED',
  'PAYMENT_FAILED',
  'INSUFFICIENT_BALANCE',
  'USER_NOT_FOUND'
];

/**
 * 检查缺失翻译
 */
async function checkMissingTranslations() {
  logger.info('Starting missing translation check job');
  
  try {
    // 1. 从 errorCodes.js 获取所有错误码
    let allErrorCodes = [];
    
    try {
      const errorCodesModule = require('../shared/errorCodes');
      allErrorCodes = Object.keys(errorCodesModule.ERROR_CODES || {});
    } catch (e) {
      logger.warn('Could not load errorCodes module, will check database only');
    }
    
    // 2. 从数据库获取已定义的错误码
    const dbResult = await db.query(
      'SELECT DISTINCT error_code FROM error_translations'
    );
    
    const dbCodes = dbResult.rows.map(r => r.error_code);
    
    // 合并所有错误码
    const allCodes = [...new Set([...allErrorCodes, ...dbCodes])];
    
    logger.info(`Checking ${allCodes.length} error codes across ${SUPPORTED_LANGUAGES.length} languages`);
    
    // 3. 检查每个错误码的翻译完整性
    const missingTranslations = [];
    const criticalMissing = [];
    
    for (const errorCode of allCodes) {
      const result = await db.query(
        `SELECT language FROM error_translations 
         WHERE error_code = $1 
         GROUP BY language`,
        [errorCode]
      );
      
      const existingLanguages = result.rows.map(r => r.language);
      const missingLanguages = SUPPORTED_LANGUAGES.filter(l => !existingLanguages.includes(l));
      
      if (missingLanguages.length > 0) {
        missingTranslations.push({
          errorCode,
          missingLanguages,
          isCritical: CRITICAL_ERROR_CODES.includes(errorCode)
        });
        
        if (CRITICAL_ERROR_CODES.includes(errorCode)) {
          criticalMissing.push({
            errorCode,
            missingLanguages
          });
        }
      }
    }
    
    logger.info('Missing translation check completed', {
      totalMissing: missingTranslations.length,
      criticalMissing: criticalMissing.length
    });
    
    // 4. 更新缺失翻译告警表
    for (const missing of missingTranslations) {
      const severity = missing.isCritical ? 'critical' : 
                       missing.missingLanguages.length >= 2 ? 'warning' : 'info';
      
      const existing = await db.query(
        'SELECT * FROM missing_translation_alerts WHERE error_code = $1',
        [missing.errorCode]
      );
      
      if (existing.rows.length > 0) {
        await db.query(
          `UPDATE missing_translation_alerts 
           SET missing_languages = $1, 
               last_detected = CURRENT_TIMESTAMP,
               detection_count = detection_count + 1,
               severity = $2
           WHERE error_code = $3`,
          [missing.missingLanguages, severity, missing.errorCode]
        );
      } else {
        await db.query(
          `INSERT INTO missing_translation_alerts 
           (error_code, missing_languages, severity) 
           VALUES ($1, $2, $3)
           ON CONFLICT (error_code) DO UPDATE SET
             missing_languages = EXCLUDED.missing_languages,
             last_detected = CURRENT_TIMESTAMP,
             detection_count = missing_translation_alerts.detection_count + 1`,
          [missing.errorCode, missing.missingLanguages, severity]
        );
      }
    }
    
    // 5. 更新 Prometheus 指标
    const criticalCount = missingTranslations.filter(m => m.isCritical).length;
    const warningCount = missingTranslations.filter(m => !m.isCritical && m.missingLanguages.length >= 2).length;
    const infoCount = missingTranslations.filter(m => !m.isCritical && m.missingLanguages.length === 1).length;
    
    translationMetrics.missingTranslations.set({ severity: 'critical' }, criticalCount);
    translationMetrics.missingTranslations.set({ severity: 'warning' }, warningCount);
    translationMetrics.missingTranslations.set({ severity: 'info' }, infoCount);
    
    translationMetrics.alertCounts.set({ severity: 'critical', acknowledged: 'false' }, criticalCount);
    translationMetrics.alertCounts.set({ severity: 'warning', acknowledged: 'false' }, warningCount);
    
    // 6. 发送告警邮件（如果存在严重缺失）
    if (criticalMissing.length > 0) {
      await sendMissingTranslationAlert(criticalMissing, missingTranslations);
    }
    
    // 7. 返回结果
    return {
      totalChecked: allCodes.length,
      missingCount: missingTranslations.length,
      criticalCount: criticalMissing.length,
      warningCount,
      infoCount
    };
    
  } catch (error) {
    logger.error('Missing translation check failed', { error: error.message });
    throw error;
  }
}

/**
 * 发送缺失翻译告警邮件
 */
async function sendMissingTranslationAlert(criticalMissing, allMissing) {
  // 如果没有配置 SMTP，跳过邮件发送
  if (!process.env.SMTP_HOST || !process.env.TRANSLATION_TEAM_EMAIL) {
    logger.warn('SMTP not configured, skipping email alert');
    return;
  }
  
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  
  const mailOptions = {
    from: process.env.ALERT_FROM_EMAIL || 'noreply@minego.com',
    to: process.env.TRANSLATION_TEAM_EMAIL,
    subject: `[mineGo] Translation Alert - ${criticalMissing.length} Critical Missing`,
    html: `
      <h2>Missing Translation Alert</h2>
      <p><strong>${criticalMissing.length} critical error codes</strong> are missing translations.</p>
      <p>Total missing: ${allMissing.length} error codes</p>
      
      <h3>Critical Missing (requires immediate action):</h3>
      <table border="1" cellpadding="5" style="border-collapse: collapse;">
        <tr><th>Error Code</th><th>Missing Languages</th></tr>
        ${criticalMissing.slice(0, 20).map(m => 
          `<tr>
            <td><strong>${m.errorCode}</strong></td>
            <td>${m.missingLanguages.join(', ')}</td>
          </tr>`
        ).join('')}
      </table>
      
      ${criticalMissing.length > 20 ? `<p>... and ${criticalMissing.length - 20} more</p>` : ''}
      
      <h3>All Missing Translations:</h3>
      <table border="1" cellpadding="5" style="border-collapse: collapse;">
        <tr><th>Error Code</th><th>Missing Languages</th><th>Severity</th></tr>
        ${allMissing.slice(0, 50).map(m => 
          `<tr>
            <td>${m.errorCode}</td>
            <td>${m.missingLanguages.join(', ')}</td>
            <td>${m.isCritical ? 'CRITICAL' : m.missingLanguages.length >= 2 ? 'WARNING' : 'INFO'}</td>
          </tr>`
        ).join('')}
      </table>
      
      ${allMissing.length > 50 ? `<p>... and ${allMissing.length - 50} more</p>` : ''}
      
      <hr>
      <p><a href="${process.env.ADMIN_URL || 'http://localhost:3001'}/translations/missing">View all missing translations in admin dashboard</a></p>
      <hr>
      <p style="color: #666; font-size: 12px;">This is an automated message from mineGo Translation System.</p>
    `
  };
  
  try {
    await transporter.sendMail(mailOptions);
    logger.info('Missing translation alert email sent', {
      criticalCount: criticalMissing.length,
      totalCount: allMissing.length,
      recipient: process.env.TRANSLATION_TEAM_EMAIL
    });
  } catch (error) {
    logger.error('Failed to send missing translation alert email', { error: error.message });
  }
}

/**
 * 获取翻译覆盖率报告
 */
async function getCoverageReport() {
  const result = await db.query(`
    SELECT 
      language,
      COUNT(*) as translation_count,
      COUNT(DISTINCT error_code) as unique_codes,
      ROUND(COUNT(*) * 100.0 / NULLIF(
        (SELECT COUNT(*) FROM (
          SELECT DISTINCT error_code FROM error_translations
        ) t), 0
      ), 2) as coverage_percentage
    FROM error_translations
    GROUP BY language
    ORDER BY language
  `);
  
  // 获取总覆盖率
  const totalResult = await db.query(`
    SELECT COUNT(DISTINCT error_code) as total_codes FROM error_translations
  `);
  
  const totalCodes = parseInt(totalResult.rows[0].total_codes, 10);
  
  // 计算每种语言的覆盖率
  const coverage = {};
  for (const row of result.rows) {
    coverage[row.language] = {
      translationCount: parseInt(row.translation_count, 10),
      uniqueCodes: parseInt(row.unique_codes, 10),
      coveragePercentage: parseFloat(row.coverage_percentage) || 0
    };
  }
  
  return {
    totalCodes,
    supportedLanguages: SUPPORTED_LANGUAGES,
    coverage,
    timestamp: new Date().toISOString()
  };
}

/**
 * 清理已过期的告警（超过 30 天无人确认且已修复）
 */
async function cleanupOldAlerts() {
  const result = await db.query(`
    DELETE FROM missing_translation_alerts 
    WHERE acknowledged = TRUE 
    AND acknowledged_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
    RETURNING error_code
  `);
  
  logger.info('Cleaned up old acknowledged alerts', { count: result.rowCount });
  
  return result.rowCount;
}

// 作为独立脚本运行
if (require.main === module) {
  checkMissingTranslations()
    .then(result => {
      console.log('Missing translation check completed:');
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(error => {
      console.error('Missing translation check failed:', error.message);
      process.exit(1);
    });
}

module.exports = {
  checkMissingTranslations,
  sendMissingTranslationAlert,
  getCoverageReport,
  cleanupOldAlerts,
  SUPPORTED_LANGUAGES,
  CRITICAL_ERROR_CODES
};