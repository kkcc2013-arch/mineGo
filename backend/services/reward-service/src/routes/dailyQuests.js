'use strict';

const express = require('express');
const { requireAuth, AppError, successResp } = require('../../../../shared/auth');

const REWARD = Object.freeze({ pokeballs: 10, stardust: 1000, xp: 500, coins: 5 });

function isComplete(quest) {
  if (![quest.catch_target, quest.spin_target, quest.walk_target_km].every(value => Number.isFinite(Number(value)) && Number(value) > 0)) return false;
  return quest.catch_current >= quest.catch_target &&
    quest.spin_current >= quest.spin_target &&
    Number(quest.walk_current_km) >= Number(quest.walk_target_km);
}

// Keep the V1 database-session calendar contract shared with catch/location/user routes.
// Modern randomized quest pools have separate storage and require their own verification.
function createDailyQuestRouter(db) {
  const router = express.Router();
  router.use(requireAuth);
  router.get('/', async (req, res, next) => {
    try {
      const quest = await db.transaction(async client => {
        await client.query(`INSERT INTO daily_quests(user_id, quest_date)
          VALUES($1,CURRENT_DATE) ON CONFLICT(user_id,quest_date) DO NOTHING`, [req.user.id]);
        const { rows: [row] } = await client.query(`SELECT * FROM daily_quests
          WHERE user_id=$1 AND quest_date=CURRENT_DATE`, [req.user.id]);
        return row;
      });
      const progress = {
        catch: Math.min(100, Math.round(quest.catch_current / quest.catch_target * 100)),
        spin: Math.min(100, Math.round(quest.spin_current / quest.spin_target * 100)),
        walk: Math.min(100, Math.round(Number(quest.walk_current_km) / Number(quest.walk_target_km) * 100))
      };
      res.json(successResp({ ...quest, progress, allDone: isComplete(quest) }));
    } catch (error) { next(error); }
  });
  router.post('/claim', async (req, res, next) => {
    try {
      await db.transaction(async client => {
        // Lock owner before quest: the cascade-delete path uses the same lock order.
        const owner = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
        if (owner.rowCount !== 1) throw new AppError(2021, '今日任务不存在', 404);
        const { rows: [quest] } = await client.query(`SELECT * FROM daily_quests
          WHERE user_id=$1 AND quest_date=CURRENT_DATE FOR UPDATE`, [req.user.id]);
        if (!quest) throw new AppError(2021, '今日任务不存在', 404);
        if (quest.reward_claimed) throw new AppError(2022, '今日任务奖励已领取', 400);
        if (!isComplete(quest)) throw new AppError(2023, '今日任务尚未全部完成', 400);
        const granted = await client.query(`UPDATE users SET
          pokeball_count=pokeball_count+$2, stardust=stardust+$3,
          xp=xp+$4, coins=coins+$5 WHERE id=$1`,
        [req.user.id, REWARD.pokeballs, REWARD.stardust, REWARD.xp, REWARD.coins]);
        if (granted.rowCount !== 1) throw new AppError(2021, '今日任务不存在', 404);
        await client.query(`UPDATE daily_quests SET reward_claimed=true,
          completed=true, completed_at=COALESCE(completed_at,NOW()) WHERE id=$1`, [quest.id]);
      });
      res.json(successResp({ reward: REWARD }, '任务奖励已领取！'));
    } catch (error) { next(error); }
  });
  return router;
}

module.exports = { createDailyQuestRouter };
