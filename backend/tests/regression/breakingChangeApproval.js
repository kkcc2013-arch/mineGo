/**
 * Breaking Change 审批流程
 * 允许通过配置文件显式允许特定的 Breaking Change
 * 
 * @module BreakingChangeApproval
 */

const fs = require('fs').promises;
const path = require('path');

class BreakingChangeApproval {
  constructor(options = {}) {
    this.approvalFile = options.approvalFile || 
                        path.join(__dirname, 'approved-breaking-changes.json');
    this.expiryDays = options.expiryDays || 90;
    this.requireReason = options.requireReason !== false;
  }

  /**
   * 检查 Breaking Change 是否已被批准
   * @param {BreakingChange} change 
   * @returns {Promise<{approved: boolean, approval?: ApprovalRecord}>}
   */
  async isApproved(change) {
    const approvals = await this.loadApprovals();

    const approval = approvals.find(a => 
      this.matchesChange(a, change) &&
      a.approvedBy &&
      a.approvedAt &&
      new Date(a.expiresAt) > new Date()
    );

    return {
      approved: !!approval,
      approval,
    };
  }

  /**
   * 批量检查 Breaking Changes 的审批状态
   * @param {Array<BreakingChange>} changes 
   * @returns {Promise<Array<{change: BreakingChange, approved: boolean}>>}
   */
  async checkApprovals(changes) {
    const results = [];

    for (const change of changes) {
      const { approved, approval } = await this.isApproved(change);
      results.push({
        change,
        approved,
        approval,
      });
    }

    return results;
  }

  /**
   * 添加 Breaking Change 审批
   * @param {BreakingChange} change 
   * @param {string} approvedBy - 审批人
   * @param {string} reason - 审批理由
   * @param {object} options - 额外选项
   */
  async approve(change, approvedBy, reason, options = {}) {
    if (this.requireReason && !reason) {
      throw new Error('审批理由为必填项');
    }

    const approvals = await this.loadApprovals();

    const approval = {
      id: this.generateApprovalId(),
      type: change.type,
      path: change.path,
      method: change.method,
      parameter: change.parameter,
      statusCode: change.statusCode,
      property: change.property,
      approvedBy,
      reason,
      approvedAt: new Date().toISOString(),
      expiresAt: options.expiresAt || 
                 new Date(Date.now() + this.expiryDays * 24 * 60 * 60 * 1000).toISOString(),
      ticket: options.ticket,
      migrationGuide: options.migrationGuide,
      impact: options.impact,
      notifyClients: options.notifyClients || false,
    };

    approvals.push(approval);

    await this.saveApprovals(approvals);

    return approval;
  }

  /**
   * 撤销审批
   * @param {string} approvalId 
   */
  async revoke(approvalId) {
    const approvals = await this.loadApprovals();
    const index = approvals.findIndex(a => a.id === approvalId);

    if (index === -1) {
      throw new Error(`审批记录 ${approvalId} 不存在`);
    }

    const revoked = approvals[index];
    approvals.splice(index, 1);

    await this.saveApprovals(approvals);

    return revoked;
  }

  /**
   * 清理过期的审批记录
   */
  async cleanupExpired() {
    const approvals = await this.loadApprovals();
    const now = new Date();

    const active = approvals.filter(a => new Date(a.expiresAt) > now);
    const expired = approvals.filter(a => new Date(a.expiresAt) <= now);

    if (expired.length > 0) {
      await this.saveApprovals(active);
      console.log(`清理了 ${expired.length} 条过期的审批记录`);
    }

    return {
      activeCount: active.length,
      expiredCount: expired.length,
    };
  }

  /**
   * 列出所有审批记录
   * @param {object} filters - 过滤条件
   */
  async listApprovals(filters = {}) {
    let approvals = await this.loadApprovals();

    if (filters.type) {
      approvals = approvals.filter(a => a.type === filters.type);
    }

    if (filters.approvedBy) {
      approvals = approvals.filter(a => a.approvedBy === filters.approvedBy);
    }

    if (filters.active !== undefined) {
      const now = new Date();
      approvals = approvals.filter(a => {
        const isActive = new Date(a.expiresAt) > now;
        return filters.active ? isActive : !isActive;
      });
    }

    return approvals;
  }

  /**
   * 加载审批记录
   */
  async loadApprovals() {
    try {
      const content = await fs.readFile(this.approvalFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      // 文件不存在时返回空数组
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * 保存审批记录
   */
  async saveApprovals(approvals) {
    await fs.writeFile(
      this.approvalFile,
      JSON.stringify(approvals, null, 2)
    );
  }

  /**
   * 检查变更是否匹配
   */
  matchesChange(approval, change) {
    if (approval.type !== change.type) return false;
    if (approval.path !== change.path) return false;
    if (approval.method && change.method && approval.method !== change.method) return false;
    if (approval.parameter && change.parameter && approval.parameter !== change.parameter) return false;
    if (approval.statusCode && change.statusCode && approval.statusCode !== change.statusCode) return false;
    if (approval.property && change.property && approval.property !== change.property) return false;
    return true;
  }

  /**
   * 生成审批 ID
   */
  generateApprovalId() {
    return `approval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 生成审批报告
   */
  async generateApprovalReport() {
    const approvals = await this.loadApprovals();
    const now = new Date();

    const active = approvals.filter(a => new Date(a.expiresAt) > now);
    const expired = approvals.filter(a => new Date(a.expiresAt) <= now);

    const byType = {};
    for (const approval of approvals) {
      byType[approval.type] = (byType[approval.type] || 0) + 1;
    }

    const byApprover = {};
    for (const approval of approvals) {
      byApprover[approval.approvedBy] = (byApprover[approval.approvedBy] || 0) + 1;
    }

    return {
      total: approvals.length,
      active: active.length,
      expired: expired.length,
      byType,
      byApprover,
      recentApprovals: approvals
        .sort((a, b) => new Date(b.approvedAt) - new Date(a.approvedAt))
        .slice(0, 10),
    };
  }

  /**
   * 导出审批记录为 CSV
   */
  async exportToCSV() {
    const approvals = await this.loadApprovals();

    const headers = [
      'id', 'type', 'path', 'method', 'approvedBy', 'reason',
      'approvedAt', 'expiresAt', 'ticket'
    ];

    const rows = approvals.map(a => headers.map(h => {
      const value = a[h] || '';
      // CSV 转义
      if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }));

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }
}

module.exports = BreakingChangeApproval;