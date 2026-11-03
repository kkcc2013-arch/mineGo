/**
 * REQ-00016: GDPR 路由
 * 数据导出、删除等 GDPR 合规 API
 */

const express = require('express');
const router = express.Router();
const GDPRService = require('./gdprService');
const { requireAuth } = require('../../../../shared/auth');
const { auditLog, AuditActions } = require('../../../../shared/auditLog');
const logger = require('../../../../shared/logger');
const {RiskVerifier}=require('../../../../shared/riskVerifier');
const {getErasureStore}=require('../../../../shared/erasure/ErasureRequestStore');
const {ownerPolicy,readPolicy,respond}=require('./dataDeletion');
const erasureRisk=new RiskVerifier();
const erasureStore=getErasureStore();

// 初始化服务
let gdprService = null;

function initGDPRRoutes(db, eventBus) {
  gdprService = new GDPRService(db, eventBus);
  return router;
}

/**
 * GET /api/gdpr/privacy-policy
 * 获取隐私政策
 */
router.get('/privacy-policy', async (req, res) => {
  try {
    const { version } = req.query;
    const policy = await gdprService.getPrivacyPolicy(version);
    
    if (!policy) {
      return res.status(404).json({ error: 'Privacy policy not found' });
    }
    
    res.json(policy);
  } catch (err) {
    logger.error({ err }, 'Failed to get privacy policy');
    res.status(500).json({ error: 'Failed to get privacy policy' });
  }
});

/**
 * GET /api/gdpr/export
 * 导出用户数据（GDPR 第 20 条：数据可携带权）
 */
router.get('/export', requireAuth, erasureRisk.middleware(()=>({operation:'user.data.export',scope:'export-data',mandatory:true})), async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 记录审计日志
    await auditLog({
      userId,
      action: AuditActions.DATA_EXPORTED,
      details: { format: 'json' },
      req,
      service: 'user-service',
      db: req.app.locals.db
    });
    
    // 导出数据
    const userData = await gdprService.exportUserData(userId);
    
    // 设置下载头
    const filename = `minego-data-${userId}-${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    res.json(userData);
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Data export failed');
    res.status(500).json({ error: 'Failed to export data' });
  }
});

/**
 * DELETE /api/gdpr/delete
 * 删除用户数据（GDPR 第 17 条：被遗忘权）
 */
router.delete('/delete', requireAuth, erasureRisk.middleware(ownerPolicy), respond(async(req,res)=>{
  if(req.body?.confirmation!=='DELETE MY ACCOUNT')return res.status(400).json({success:false,code:'ERASURE_CONFIRMATION_REQUIRED'});
  const data=await erasureStore.createRequest(req.user.sub,{requestType:'full',reason:'user_request',dataTypes:['all']});
  res.status(202).json({success:true,data});
}));

/**
 * POST /api/gdpr/delete/confirm
 * 确认数据删除（通过邮件链接）
 */
router.post('/delete/confirm', requireAuth, erasureRisk.middleware(ownerPolicy), respond(async(req,res)=>{
  const data=await erasureStore.verifyRequest(req.user.sub,req.body?.requestId,req.body?.verificationCode??req.body?.token);
  res.json({success:true,data});
}));

/**
 * GET /api/gdpr/status
 * 获取删除请求状态
 */
router.get('/status', requireAuth, erasureRisk.middleware(readPolicy), respond(async(req,res)=>{
  const rows=await erasureStore.list(req.user.sub,{limit:1});
  res.json({hasRequest:rows.length>0,...(rows[0]||{})});
}));

/**
 * POST /api/gdpr/consent
 * 记录用户同意
 */
router.post('/consent', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { privacyPolicyVersion, termsVersion } = req.body;
    
    await gdprService.recordConsent(userId, {
      privacyPolicyVersion,
      termsVersion,
      req
    });
    
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to record consent');
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

/**
 * POST /api/gdpr/withdraw
 * 撤回同意
 */
router.post('/withdraw', requireAuth, erasureRisk.middleware(ownerPolicy), respond(async(req,res)=>{
  const data=await erasureStore.withdrawConsent(req.user.sub);
  res.status(202).json({success:true,data});
}));

/**
 * GET /api/gdpr/audit-logs
 * 获取用户审计日志
 */
router.get('/audit-logs', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = '100', action } = req.query;
    if(typeof limit!=='string'||!/^([1-9][0-9]{0,3})$/.test(limit)||Number(limit)>1000||action!==undefined&&(typeof action!=='string'||!action.length||action.length>100)){
      return res.status(400).json({error:'Invalid audit filters'});
    }
    
    const { getUserAuditLogs } = require('../../../../shared/auditLog');
    const logs = await getUserAuditLogs(
      userId,
      { limit: Number(limit), ...(action===undefined?{}:{action}) },
      gdprService.db
    );
    
    res.json(logs);
  } catch (err) {
    logger.error({ err }, 'Failed to get audit logs');
    res.status(500).json({ error: 'Failed to get audit logs' });
  }
});

module.exports = { router, initGDPRRoutes };
