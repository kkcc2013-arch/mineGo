const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const { query: db } = require('../../../shared/db');
const { requireAuth } = require('../../../shared/auth');
const { successResp, errorResp } = require('../../../shared');

// 所有路由需要认证
router.use(requireAuth);

// ============ 公会管理 ============

/**
 * 创建公会
 * POST /api/v1/guilds
 */
router.post('/', [
  body('name').trim().isLength({ min: 2, max: 50 }).withMessage('公会名称长度需在2-50字符之间'),
  body('description').optional().trim().isLength({ max: 500 }),
  body('badgeUrl').optional().isURL(),
  body('joinType').optional().isIn(['public', 'apply', 'invite_only']),
  body('minLevel').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const { name, description, badgeUrl, joinType = 'apply', minLevel = 5 } = req.body;

    // 检查用户是否已加入公会
    const existingMember = await db.query(
      'SELECT guild_id FROM guild_members WHERE user_id = $1',
      [userId]
    );

    if (existingMember.rows.length > 0) {
      return res.status(400).json({ error: '您已加入公会，无法创建新公会' });
    }

    // 检查用户等级和金币
    const userResult = await db.query(
      'SELECT level, coins FROM users WHERE id = $1',
      [userId]
    );

    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 创建公会消耗（假设需要 10000 金币）
    const creationCost = 10000;
    if (user.coins < creationCost) {
      return res.status(400).json({ error: `创建公会需要 ${creationCost} 金币` });
    }

    // 生成唯一公会标识
    const guildKey = generateGuildKey();

    // 开启事务
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // 扣除金币
      await client.query(
        'UPDATE users SET coins = coins - $1 WHERE id = $2',
        [creationCost, userId]
      );

      // 创建公会
      const guildResult = await client.query(`
        INSERT INTO guilds (guild_key, name, description, badge_url, join_type, min_level, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [guildKey, name, description, badgeUrl, joinType, minLevel, userId]);

      const guild = guildResult.rows[0];

      // 创建者成为会长
      await client.query(`
        INSERT INTO guild_members (guild_id, user_id, role, contribution, permissions)
        VALUES ($1, $2, 'leader', 100, '{"canInvite": true, "canKick": true, "canPromote": true, "canEdit": true, "canManageBank": true}')
      `, [guild.id, userId]);

      // 更新用户的公会ID
      await client.query(
        'UPDATE users SET guild_id = $1 WHERE id = $2',
        [guild.id, userId]
      );

      await client.query('COMMIT');

      res.status(201).json({
        success: true,
        guild: {
          id: guild.id,
          guildKey: guild.guild_key,
          name: guild.name,
          description: guild.description,
          badgeUrl: guild.badge_url,
          level: guild.level,
          memberCount: 1,
          joinType: guild.join_type,
          createdAt: guild.created_at
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating guild:', error);
    res.status(500).json({ error: '创建公会失败' });
  }
});

/**
 * 获取公会详情
 * GET /api/v1/guilds/:guildId
 */
router.get('/:guildId', [
  param('guildId').isInt()
], async (req, res) => {
  try {
    const { guildId } = req.params;

    const guildResult = await db.query(`
      SELECT 
        g.*,
        COUNT(gm.id) as member_count,
        u.username as leader_name
      FROM guilds g
      LEFT JOIN guild_members gm ON g.id = gm.guild_id
      LEFT JOIN users u ON g.created_by = u.id
      WHERE g.id = $1 AND g.status != 'disbanded'
      GROUP BY g.id, u.username
    `, [guildId]);

    if (guildResult.rows.length === 0) {
      return res.status(404).json({ error: '公会不存在' });
    }

    const guild = guildResult.rows[0];

    // 获取公会成员（前20名）
    const membersResult = await db.query(`
      SELECT 
        gm.user_id,
        u.username,
        gm.role,
        gm.contribution,
        gm.joined_at,
        u.level,
        u.avatar_url
      FROM guild_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.guild_id = $1
      ORDER BY 
        CASE gm.role 
          WHEN 'leader' THEN 1 
          WHEN 'co_leader' THEN 2 
          WHEN 'elder' THEN 3 
          WHEN 'member' THEN 4 
          ELSE 5 
        END,
        gm.contribution DESC
      LIMIT 20
    `, [guildId]);

    res.json({
      success: true,
      guild: {
        id: guild.id,
        guildKey: guild.guild_key,
        name: guild.name,
        description: guild.description,
        badgeUrl: guild.badge_url,
        bannerUrl: guild.banner_url,
        level: guild.level,
        experience: guild.experience,
        memberCount: parseInt(guild.member_count),
        maxMembers: guild.max_members,
        treasury: guild.treasury,
        totalContribution: guild.total_contribution,
        joinType: guild.join_type,
        minLevel: guild.min_level,
        activeBuffs: guild.active_buffs,
        totalBattlesWon: guild.total_battles_won,
        totalRaidsCompleted: guild.total_raids_completed,
        leaderName: guild.leader_name,
        createdAt: guild.created_at,
        members: membersResult.rows.map(m => ({
          userId: m.user_id,
          username: m.username,
          role: m.role,
          contribution: m.contribution,
          level: m.level,
          avatarUrl: m.avatar_url,
          joinedAt: m.joined_at
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching guild:', error);
    res.status(500).json({ error: '获取公会信息失败' });
  }
});

/**
 * 搜索公会
 * GET /api/v1/guilds
 */
router.get('/', [
  query('search').optional().trim(),
  query('joinType').optional().isIn(['public', 'apply', 'invite_only']),
  query('minLevel').optional().isInt(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 })
], async (req, res) => {
  try {
    const { search, joinType, minLevel, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let queryStr = `
      SELECT 
        g.id,
        g.guild_key,
        g.name,
        g.description,
        g.badge_url,
        g.level,
        g.join_type,
        g.min_level,
        g.total_contribution,
        COUNT(gm.id) as member_count
      FROM guilds g
      LEFT JOIN guild_members gm ON g.id = gm.guild_id
      WHERE g.status = 'active'
    `;

    const params = [];
    let paramIndex = 1;

    if (search) {
      queryStr += ` AND (g.name ILIKE $${paramIndex} OR g.description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (joinType) {
      queryStr += ` AND g.join_type = $${paramIndex}`;
      params.push(joinType);
      paramIndex++;
    }

    if (minLevel !== undefined) {
      queryStr += ` AND g.min_level <= $${paramIndex}`;
      params.push(minLevel);
      paramIndex++;
    }

    queryStr += ` GROUP BY g.id ORDER BY g.level DESC, g.total_contribution DESC`;
    queryStr += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await db.query(queryStr, params);

    // 获取总数
    let countQuery = 'SELECT COUNT(DISTINCT g.id) as total FROM guilds g WHERE g.status = \'active\'';
    const countParams = [];
    let countIndex = 1;

    if (search) {
      countQuery += ` AND (g.name ILIKE $${countIndex} OR g.description ILIKE $${countIndex})`;
      countParams.push(`%${search}%`);
      countIndex++;
    }

    if (joinType) {
      countQuery += ` AND g.join_type = $${countIndex}`;
      countParams.push(joinType);
      countIndex++;
    }

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      guilds: result.rows.map(g => ({
        id: g.id,
        guildKey: g.guild_key,
        name: g.name,
        description: g.description,
        badgeUrl: g.badge_url,
        level: g.level,
        joinType: g.join_type,
        minLevel: g.min_level,
        memberCount: parseInt(g.member_count),
        totalContribution: g.total_contribution
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error searching guilds:', error);
    res.status(500).json({ error: '搜索公会失败' });
  }
});

/**
 * 更新公会设置
 * PUT /api/v1/guilds/:guildId
 */
router.put('/:guildId', [
  param('guildId').isInt(),
  body('name').optional().trim().isLength({ min: 2, max: 50 }),
  body('description').optional().trim().isLength({ max: 500 }),
  body('joinType').optional().isIn(['public', 'apply', 'invite_only']),
  body('minLevel').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const { guildId } = req.params;
    const userId = req.user.id;

    // 检查权限
    const memberResult = await db.query(
      'SELECT role, permissions FROM guild_members WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(403).json({ error: '您不是该公会成员' });
    }

    const member = memberResult.rows[0];
    if (!['leader', 'co_leader'].includes(member.role)) {
      return res.status(403).json({ error: '权限不足' });
    }

    const updates = req.body;
    const setClauses = [];
    const params = [guildId];
    let paramIndex = 2;

    if (updates.name) {
      setClauses.push(`name = $${paramIndex}`);
      params.push(updates.name);
      paramIndex++;
    }

    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIndex}`);
      params.push(updates.description);
      paramIndex++;
    }

    if (updates.joinType) {
      setClauses.push(`join_type = $${paramIndex}`);
      params.push(updates.joinType);
      paramIndex++;
    }

    if (updates.minLevel !== undefined) {
      setClauses.push(`min_level = $${paramIndex}`);
      params.push(updates.minLevel);
      paramIndex++;
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: '没有要更新的内容' });
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');

    const result = await db.query(`
      UPDATE guilds 
      SET ${setClauses.join(', ')}
      WHERE id = $1
      RETURNING *
    `, params);

    res.json({
      success: true,
      guild: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating guild:', error);
    res.status(500).json({ error: '更新公会失败' });
  }
});

/**
 * 解散公会
 * DELETE /api/v1/guilds/:guildId
 */
router.delete('/:guildId', [
  param('guildId').isInt()
], async (req, res) => {
  try {
    const { guildId } = req.params;
    const userId = req.user.id;

    // 检查是否是会长
    const memberResult = await db.query(
      'SELECT role FROM guild_members WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );

    if (memberResult.rows.length === 0 || memberResult.rows[0].role !== 'leader') {
      return res.status(403).json({ error: '只有会长可以解散公会' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // 更新公会状态
      await client.query(
        'UPDATE guilds SET status = \'disbanded\' WHERE id = $1',
        [guildId]
      );

      // 清除所有成员的公会ID
      await client.query(
        'UPDATE users SET guild_id = NULL WHERE guild_id = $1',
        [guildId]
      );

      // 删除所有成员记录
      await client.query(
        'DELETE FROM guild_members WHERE guild_id = $1',
        [guildId]
      );

      await client.query('COMMIT');

      res.json({ success: true, message: '公会已解散' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error disbanding guild:', error);
    res.status(500).json({ error: '解散公会失败' });
  }
});

// ============ 公会加入/退出 ============

/**
 * 申请加入公会
 * POST /api/v1/guilds/:guildId/applications
 */
router.post('/:guildId/applications', [
  param('guildId').isInt(),
  body('applicationText').optional().trim().isLength({ max: 200 })
], async (req, res) => {
  try {
    const { guildId } = req.params;
    const { applicationText } = req.body;
    const userId = req.user.id;

    // 检查用户是否已加入公会
    const existingMember = await db.query(
      'SELECT guild_id FROM guild_members WHERE user_id = $1',
      [userId]
    );

    if (existingMember.rows.length > 0) {
      return res.status(400).json({ error: '您已加入公会' });
    }

    // 检查公会是否存在
    const guildResult = await db.query(
      'SELECT * FROM guilds WHERE id = $1 AND status = \'active\'',
      [guildId]
    );

    if (guildResult.rows.length === 0) {
      return res.status(404).json({ error: '公会不存在' });
    }

    const guild = guildResult.rows[0];

    // 检查用户等级
    const userResult = await db.query(
      'SELECT level FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows[0].level < guild.min_level) {
      return res.status(400).json({ 
        error: `需要达到 ${guild.min_level} 级才能申请此公会` 
      });
    }

    // 如果是公开公会，直接加入
    if (guild.join_type === 'public') {
      const client = await db.getClient();
      try {
        await client.query('BEGIN');

        // 检查公会人数
        const countResult = await client.query(
          'SELECT COUNT(*) FROM guild_members WHERE guild_id = $1',
          [guildId]
        );

        if (parseInt(countResult.rows[0].count) >= guild.max_members) {
          return res.status(400).json({ error: '公会人数已满' });
        }

        // 加入公会
        await client.query(`
          INSERT INTO guild_members (guild_id, user_id, role, contribution)
          VALUES ($1, $2, 'novice', 0)
        `, [guildId, userId]);

        // 更新用户的公会ID
        await client.query(
          'UPDATE users SET guild_id = $1 WHERE id = $2',
          [guildId, userId]
        );

        await client.query('COMMIT');

        return res.json({
          success: true,
          message: '已成功加入公会',
          status: 'joined'
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    // 检查是否已申请
    const existingApp = await db.query(
      'SELECT id FROM guild_applications WHERE guild_id = $1 AND user_id = $2 AND status = \'pending\'',
      [guildId, userId]
    );

    if (existingApp.rows.length > 0) {
      return res.status(400).json({ error: '您已申请过此公会，请等待审核' });
    }

    // 创建申请
    const result = await db.query(`
      INSERT INTO guild_applications (guild_id, user_id, application_text)
      VALUES ($1, $2, $3)
      RETURNING id, created_at
    `, [guildId, userId, applicationText]);

    res.status(201).json({
      success: true,
      message: '申请已提交，请等待审核',
      applicationId: result.rows[0].id,
      status: 'pending'
    });
  } catch (error) {
    console.error('Error applying to guild:', error);
    res.status(500).json({ error: '申请加入公会失败' });
  }
});

/**
 * 处理申请
 * PUT /api/v1/guilds/:guildId/applications/:applicationId
 */
router.put('/:guildId/applications/:applicationId', [
  param('guildId').isInt(),
  param('applicationId').isInt(),
  body('action').isIn(['approve', 'reject']),
  body('note').optional().trim()
], async (req, res) => {
  try {
    const { guildId, applicationId } = req.params;
    const { action, note } = req.body;
    const userId = req.user.id;

    // 检查权限
    const memberResult = await db.query(
      'SELECT role FROM guild_members WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(403).json({ error: '权限不足' });
    }

    const member = memberResult.rows[0];
    if (!['leader', 'co_leader', 'elder'].includes(member.role)) {
      return res.status(403).json({ error: '只有长老及以上职位可以处理申请' });
    }

    // 获取申请信息
    const appResult = await db.query(
      'SELECT * FROM guild_applications WHERE id = $1 AND guild_id = $2 AND status = \'pending\'',
      [applicationId, guildId]
    );

    if (appResult.rows.length === 0) {
      return res.status(404).json({ error: '申请不存在或已处理' });
    }

    const application = appResult.rows[0];

    if (action === 'approve') {
      const client = await db.getClient();
      try {
        await client.query('BEGIN');

        // 检查公会人数
        const guildResult = await client.query(
          'SELECT max_members FROM guilds WHERE id = $1',
          [guildId]
        );

        const countResult = await client.query(
          'SELECT COUNT(*) FROM guild_members WHERE guild_id = $1',
          [guildId]
        );

        if (parseInt(countResult.rows[0].count) >= guildResult.rows[0].max_members) {
          return res.status(400).json({ error: '公会人数已满' });
        }

        // 加入公会
        await client.query(`
          INSERT INTO guild_members (guild_id, user_id, role, contribution)
          VALUES ($1, $2, 'novice', 0)
        `, [guildId, application.user_id]);

        // 更新用户的公会ID
        await client.query(
          'UPDATE users SET guild_id = $1 WHERE id = $2',
          [guildId, application.user_id]
        );

        // 更新申请状态
        await client.query(`
          UPDATE guild_applications 
          SET status = 'approved', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, review_note = $2
          WHERE id = $3
        `, [userId, note, applicationId]);

        await client.query('COMMIT');

        res.json({ success: true, message: '已批准申请' });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else {
      // 拒绝申请
      await db.query(`
        UPDATE guild_applications 
        SET status = 'rejected', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, review_note = $2
        WHERE id = $3
      `, [userId, note, applicationId]);

      res.json({ success: true, message: '已拒绝申请' });
    }
  } catch (error) {
    console.error('Error handling application:', error);
    res.status(500).json({ error: '处理申请失败' });
  }
});

/**
 * 退出公会
 * POST /api/v1/guilds/:guildId/leave
 */
router.post('/:guildId/leave', [
  param('guildId').isInt()
], async (req, res) => {
  try {
    const { guildId } = req.params;
    const userId = req.user.id;

    // 检查成员信息
    const memberResult = await db.query(
      'SELECT role FROM guild_members WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(400).json({ error: '您不是该公会成员' });
    }

    const role = memberResult.rows[0].role;

    // 如果是会长，需要先转让会长职位或解散公会
    if (role === 'leader') {
      return res.status(400).json({ error: '会长需要先转让职位或解散公会' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // 移除成员
      await client.query(
        'DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2',
        [guildId, userId]
      );

      // 更新用户的公会ID
      await client.query(
        'UPDATE users SET guild_id = NULL WHERE id = $1',
        [userId]
      );

      await client.query('COMMIT');

      res.json({ success: true, message: '已退出公会' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error leaving guild:', error);
    res.status(500).json({ error: '退出公会失败' });
  }
});

/**
 * 踢出成员
 * POST /api/v1/guilds/:guildId/kick/:memberId
 */
router.post('/:guildId/kick/:memberId', [
  param('guildId').isInt(),
  param('memberId').isInt()
], async (req, res) => {
  try {
    const { guildId, memberId } = req.params;
    const userId = req.user.id;

    // 检查权限
    const actorResult = await db.query(
      'SELECT role FROM guild_members WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );

    if (actorResult.rows.length === 0) {
      return res.status(403).json({ error: '权限不足' });
    }

    const actorRole = actorResult.rows[0].role;
    if (!['leader', 'co_leader'].includes(actorRole)) {
      return res.status(403).json({ error: '只有会长和副会长可以踢出成员' });
    }

    // 检查目标成员
    const targetResult = await db.query(
      'SELECT role FROM guild_members WHERE guild_id = $1 AND user_id = $2',
      [guildId, memberId]
    );

    if (targetResult.rows.length === 0) {
      return res.status(404).json({ error: '成员不存在' });
    }

    const targetRole = targetResult.rows[0].role;

    // 不能踢出会长或同级别成员
    if (targetRole === 'leader' || (targetRole === 'co_leader' && actorRole !== 'leader')) {
      return res.status(403).json({ error: '无法踢出该成员' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      await client.query(
        'DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2',
        [guildId, memberId]
      );

      await client.query(
        'UPDATE users SET guild_id = NULL WHERE id = $1',
        [memberId]
      );

      await client.query('COMMIT');

      res.json({ success: true, message: '已踢出成员' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error kicking member:', error);
    res.status(500).json({ error: '踢出成员失败' });
  }
});

/**
 * 捐赠金币
 * POST /api/v1/guilds/:guildId/donate
 */
router.post('/:guildId/donate', [
  param('guildId').isInt(),
  body('amount').isInt({ min: 100, max: 100000 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { guildId } = req.params;
    const { amount } = req.body;
    const userId = req.user.id;

    // 检查成员身份
    const memberResult = await db.query(
      'SELECT contribution FROM guild_members WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );

    if (memberResult.rows.length === 0) {
      return res.status(403).json({ error: '您不是该公会成员' });
    }

    // 检查用户金币
    const userResult = await db.query(
      'SELECT coins FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows[0].coins < amount) {
      return res.status(400).json({ error: '金币不足' });
    }

    // 计算贡献值（假设 100 金币 = 1 贡献值）
    const contributionGained = Math.floor(amount / 100);

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // 扣除用户金币
      await client.query(
        'UPDATE users SET coins = coins - $1 WHERE id = $2',
        [amount, userId]
      );

      // 增加公会资金
      await client.query(
        'UPDATE guilds SET treasury = treasury + $1, total_contribution = total_contribution + $2 WHERE id = $3',
        [amount, contributionGained, guildId]
      );

      // 增加成员贡献
      await client.query(`
        UPDATE guild_members 
        SET contribution = contribution + $1, 
            weekly_contribution = weekly_contribution + $1,
            total_donated = total_donated + $2,
            last_contribution_at = CURRENT_TIMESTAMP
        WHERE guild_id = $3 AND user_id = $4
      `, [contributionGained, amount, guildId, userId]);

      // 记录捐赠
      await client.query(`
        INSERT INTO guild_donations (guild_id, user_id, donation_type, amount, contribution_gained)
        VALUES ($1, $2, 'coins', $3, $4)
      `, [guildId, userId, amount, contributionGained]);

      await client.query('COMMIT');

      res.json({
        success: true,
        message: '捐赠成功',
        donated: amount,
        contributionGained
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error donating to guild:', error);
    res.status(500).json({ error: '捐赠失败' });
  }
});

// ============ 工具函数 ============

function generateGuildKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = '';
  for (let i = 0; i < 8; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

module.exports = router;
