-- migrate:up
-- Epic E05：成就（REQ-00076）与称号（REQ-00106）收敛为一套权威实现 + 游戏事件 outbox
--
-- 现状：V1 的 achievement_definitions/user_achievements（分档计数，catch_total 等）与后续迁移新增的
-- achievements（成就定义，JSONB 触发条件/奖励）并存；user_achievements 因 V1 先建表，后续 CREATE TABLE
-- 被跳过，只补了列，外键仍指向 achievement_definitions，新成就根本写不进去。
-- 收敛：以 achievements 为唯一成就定义表，user_achievements.achievement_id 改为引用 achievements；
-- V1 计数行按源数据回填新成就进度后删除（achievement_definitions 保留为历史表，不再写入）。
--
-- 事件接入：各业务表上的触发器把"发生了什么"写进 outbox 表 achievement_events（与业务同一事务，
-- 业务回滚则事件也不存在；触发器内部异常只告警、不影响业务），插入时 pg_notify('pmg_game_events')；
-- 由 backend/shared/achievementEngine.js 消费：推进成就进度、解锁称号/装饰、生成站内消息。

-- ============================================================
-- 1. 成就定义 achievements
-- ============================================================
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE achievements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
-- 5 大类之外增加 成长/收藏/活动 三类（等级、收藏室、活动成就）
ALTER TABLE achievements DROP CONSTRAINT IF EXISTS achievements_category_check;
ALTER TABLE achievements ADD CONSTRAINT achievements_category_check
  CHECK (category IN ('catch', 'breed', 'battle', 'social', 'explore', 'growth', 'collection', 'event'));
CREATE INDEX IF NOT EXISTS idx_achievements_trigger_type ON achievements ((trigger_conditions->>'type'));

-- 原种子里引用了道具表不存在的道具（孵化器、护符…），领取时会被跳过：换成已定义的道具
UPDATE achievements SET rewards = '{"coins": 5000, "items": [{"item_id": "LUCKY_EGG", "count": 2}]}'
 WHERE achievement_id = 'breed_master_50' AND rewards::text LIKE '%incubator%';
UPDATE achievements SET rewards = '{"coins": 300, "items": [{"item_id": "INCENSE", "count": 1}]}'
 WHERE achievement_id = 'walker_10km' AND rewards::text LIKE '%incubator%';
UPDATE achievements SET rewards = '{"coins": 5000, "items": [{"item_id": "STAR_PIECE", "count": 1}]}'
 WHERE achievement_id = 'walker_100km' AND rewards::text LIKE '%incubator%';
UPDATE achievements SET rewards = '{"coins": 20000, "items": [{"item_id": "STAR_PIECE", "count": 3}], "title": "world_traveler"}'
 WHERE achievement_id = 'walker_1000km' AND rewards::text LIKE '%incubator%';
UPDATE achievements SET rewards = '{"coins": 15000, "items": [{"item_id": "LUCKY_EGG", "count": 3}]}',
       description = '{"zh": "通过交换获得一只亮晶晶精灵", "en": "Get a lucky Pokémon from a trade", "ja": "交換でキラポケモンを手に入れる"}'
 WHERE achievement_id = 'lucky_encounter' AND rewards::text LIKE '%lucky_pendant%';
UPDATE achievements SET rewards = '{"coins": 20000, "items": [{"item_id": "RARE_CANDY", "count": 10}]}',
       description = '{"zh": "孵化出一只完美个体值精灵", "en": "Hatch a Pokémon with perfect IVs", "ja": "完全個体値のポケモンを孵化させる"}'
 WHERE achievement_id = 'perfectionist' AND rewards::text LIKE '%iv_checker%';

-- 新增成就：成长（训练师等级）、活动、收藏室、首次类、隐藏成就、成就收集（元成就）
INSERT INTO achievements (achievement_id, category, name, description, rarity, points, is_hidden, trigger_conditions, rewards, display_order) VALUES
('catch_master_10', 'catch', '{"zh": "初出茅庐", "en": "Getting Started", "ja": "駆け出し"}', '{"zh": "捕捉 10 只精灵", "en": "Catch 10 Pokémon", "ja": "ポケモンを10匹捕まえる"}', 'common', 20, false, '{"type": "catch_count", "target": 10}', '{"stardust": 500, "items": [{"item_id": "POKE_BALL", "count": 10}]}', 2),
('perfect_catch', 'catch', '{"zh": "完美邂逅", "en": "Perfect Encounter", "ja": "完璧な出会い"}', '{"zh": "捕捉一只完美个体值精灵", "en": "Catch a Pokémon with perfect IVs", "ja": "完全個体値のポケモンを捕まえる"}', 'epic', 150, false, '{"type": "catch_count", "target": 1, "filters": {"is_perfect_iv": true}}', '{"stardust": 3000}', 20),
('night_owl', 'catch', '{"zh": "夜猫子", "en": "Night Owl", "ja": "夜ふかし"}', '{"zh": "在凌晨 0~5 点捕捉精灵", "en": "Catch a Pokémon between midnight and 5am", "ja": "深夜0〜5時にポケモンを捕まえる"}', 'rare', 50, true, '{"type": "catch_count", "target": 1, "filters": {"is_night": true}}', '{"stardust": 1000, "title": "night_owl"}', 90),
('first_pokestop', 'explore', '{"zh": "第一次补给", "en": "First Spin", "ja": "はじめてのポケストップ"}', '{"zh": "第一次转动补给站", "en": "Spin your first PokéStop", "ja": "はじめてポケストップを回す"}', 'common', 10, false, '{"type": "pokestop_visit", "target": 1}', '{"stardust": 100}', 1),
('pokestop_streak_7', 'explore', '{"zh": "持之以恒", "en": "Keep It Up", "ja": "継続は力なり"}', '{"zh": "补给站连续 7 天奖励", "en": "Get a 7-day PokéStop streak bonus", "ja": "ポケストップ7日連続ボーナス"}', 'rare', 60, true, '{"type": "pokestop_visit", "target": 1, "filters": {"streak_bonus": true}}', '{"stardust": 2000}', 91),
('trainer_level_5', 'growth', '{"zh": "崭露头角", "en": "Rising Trainer", "ja": "頭角を現す"}', '{"zh": "训练师达到 5 级", "en": "Reach trainer level 5", "ja": "トレーナーレベル5に到達"}', 'common', 20, false, '{"type": "trainer_level", "target": 5}', '{"pokeballs": 20}', 1),
('trainer_level_10', 'growth', '{"zh": "新星训练师", "en": "Rising Star", "ja": "期待の新星"}', '{"zh": "训练师达到 10 级", "en": "Reach trainer level 10", "ja": "トレーナーレベル10に到達"}', 'rare', 50, false, '{"type": "trainer_level", "target": 10}', '{"stardust": 3000, "title": "rising_star"}', 2),
('trainer_level_20', 'growth', '{"zh": "精英训练师", "en": "Elite Trainer", "ja": "エリートトレーナー"}', '{"zh": "训练师达到 20 级", "en": "Reach trainer level 20", "ja": "トレーナーレベル20に到達"}', 'epic', 100, false, '{"type": "trainer_level", "target": 20}', '{"stardust": 10000, "title": "elite_trainer", "decoration": "statue_golden_pokeball"}', 3),
('trainer_level_30', 'growth', '{"zh": "资深训练师", "en": "Veteran Trainer", "ja": "ベテラントレーナー"}', '{"zh": "训练师达到 30 级", "en": "Reach trainer level 30", "ja": "トレーナーレベル30に到達"}', 'epic', 150, false, '{"type": "trainer_level", "target": 30}', '{"stardust": 20000, "items": [{"item_id": "RARE_CANDY", "count": 10}]}', 4),
('trainer_level_40', 'growth', '{"zh": "大师训练师", "en": "Master Trainer", "ja": "マスタートレーナー"}', '{"zh": "训练师达到 40 级", "en": "Reach trainer level 40", "ja": "トレーナーレベル40に到達"}', 'legendary', 300, false, '{"type": "trainer_level", "target": 40}', '{"stardust": 50000, "title": "master_trainer"}', 5),
('achievement_hunter_10', 'growth', '{"zh": "成就收集者", "en": "Achievement Collector", "ja": "実績コレクター"}', '{"zh": "解锁 10 个成就", "en": "Unlock 10 achievements", "ja": "実績を10個解除"}', 'rare', 50, false, '{"type": "achievements_unlocked", "target": 10}', '{"stardust": 3000}', 10),
('achievement_hunter_30', 'growth', '{"zh": "成就猎人", "en": "Achievement Hunter", "ja": "実績ハンター"}', '{"zh": "解锁 30 个成就", "en": "Unlock 30 achievements", "ja": "実績を30個解除"}', 'legendary', 200, false, '{"type": "achievements_unlocked", "target": 30}', '{"stardust": 20000, "title": "achievement_hunter"}', 11),
('achievement_hunter_50', 'growth', '{"zh": "精灵大师", "en": "Pokémon Master", "ja": "ポケモンマスター"}', '{"zh": "解锁 50 个成就", "en": "Unlock 50 achievements", "ja": "実績を50個解除"}', 'legendary', 500, true, '{"type": "achievements_unlocked", "target": 50}', '{"stardust": 50000, "title": "pokemon_master"}', 12),
('first_gym_battle', 'battle', '{"zh": "初战道馆", "en": "Gym Debut", "ja": "ジムデビュー"}', '{"zh": "完成第一场道馆战", "en": "Finish your first gym battle", "ja": "はじめてのジムバトル"}', 'common', 10, false, '{"type": "gym_battle", "target": 1}', '{"stardust": 300}', 1),
('first_raid', 'battle', '{"zh": "团战新人", "en": "Raid Rookie", "ja": "レイド初参加"}', '{"zh": "第一次参加团体战", "en": "Join your first raid", "ja": "はじめてレイドに参加"}', 'common', 10, false, '{"type": "raid_participate", "target": 1}', '{"stardust": 300}', 2),
('raid_veteran_50', 'battle', '{"zh": "团战老兵", "en": "Raid Veteran", "ja": "レイドの古参"}', '{"zh": "参加 50 次团体战", "en": "Join 50 raids", "ja": "レイドに50回参加"}', 'rare', 100, false, '{"type": "raid_participate", "target": 50}', '{"stardust": 5000}', 30),
('first_friend', 'social', '{"zh": "第一位好友", "en": "First Friend", "ja": "はじめてのフレンド"}', '{"zh": "添加第一位好友", "en": "Add your first friend", "ja": "はじめてフレンドを追加"}', 'common', 10, false, '{"type": "friend_count", "target": 1}', '{"stardust": 200}', 1),
('friend_maker_10', 'social', '{"zh": "广交朋友", "en": "Friendly Trainer", "ja": "友だちの輪"}', '{"zh": "添加 10 位好友", "en": "Add 10 friends", "ja": "フレンドを10人追加"}', 'common', 30, false, '{"type": "friend_count", "target": 10}', '{"stardust": 1000}', 2),
('gift_giver_10', 'social', '{"zh": "礼尚往来", "en": "Gift Giver", "ja": "ギフト上手"}', '{"zh": "送出 10 份礼物", "en": "Send 10 gifts", "ja": "ギフトを10個送る"}', 'common', 30, false, '{"type": "gift_sent", "target": 10}', '{"stardust": 1000}', 3),
('gift_giver_100', 'social', '{"zh": "慷慨之星", "en": "Generous Star", "ja": "気前のいいスター"}', '{"zh": "送出 100 份礼物", "en": "Send 100 gifts", "ja": "ギフトを100個送る"}', 'rare', 100, false, '{"type": "gift_sent", "target": 100}', '{"stardust": 5000}', 4),
('event_first_join', 'event', '{"zh": "活动新人", "en": "Event Newcomer", "ja": "イベント初参加"}', '{"zh": "第一次参加游戏活动", "en": "Join your first event", "ja": "はじめてイベントに参加"}', 'common', 10, false, '{"type": "event_join", "target": 1}', '{"stardust": 300}', 1),
('event_regular_10', 'event', '{"zh": "活动常客", "en": "Event Regular", "ja": "イベント常連"}', '{"zh": "参加 10 次游戏活动", "en": "Join 10 events", "ja": "イベントに10回参加"}', 'rare', 80, false, '{"type": "event_join", "target": 10}', '{"stardust": 5000, "title": "event_regular"}', 2),
('event_first_complete', 'event', '{"zh": "活动达人", "en": "Event Finisher", "ja": "イベント達成"}', '{"zh": "完成一次活动并领取奖励", "en": "Complete an event and claim its reward", "ja": "イベントを達成して報酬を受け取る"}', 'common', 20, false, '{"type": "event_complete", "target": 1}', '{"stardust": 500}', 3),
('room_first_pokemon', 'collection', '{"zh": "开馆大吉", "en": "Grand Opening", "ja": "開館"}', '{"zh": "在收藏室展示第一只精灵", "en": "Display your first Pokémon in your collection room", "ja": "コレクションルームに初めてポケモンを飾る"}', 'common', 10, false, '{"type": "room_pokemon", "target": 1}', '{"stardust": 200, "decoration": "plant_potted_fern"}', 1),
('collector_bronze', 'collection', '{"zh": "铜牌收藏家", "en": "Bronze Collector", "ja": "ブロンズコレクター"}', '{"zh": "收藏室展示 10 只精灵", "en": "Display 10 Pokémon in your room", "ja": "ルームにポケモンを10匹飾る"}', 'common', 30, false, '{"type": "room_pokemon", "target": 10}', '{"stardust": 1000, "decoration": "statue_bronze_trophy"}', 2),
('collector_silver', 'collection', '{"zh": "银牌收藏家", "en": "Silver Collector", "ja": "シルバーコレクター"}', '{"zh": "收藏室展示 25 只精灵", "en": "Display 25 Pokémon in your room", "ja": "ルームにポケモンを25匹飾る"}', 'rare', 80, false, '{"type": "room_pokemon", "target": 25}', '{"stardust": 3000, "decoration": "statue_silver_trophy"}', 3),
('collector_gold', 'collection', '{"zh": "金牌收藏家", "en": "Gold Collector", "ja": "ゴールドコレクター"}', '{"zh": "收藏室展示 50 只精灵", "en": "Display 50 Pokémon in your room", "ja": "ルームにポケモンを50匹飾る"}', 'epic', 150, false, '{"type": "room_pokemon", "target": 50}', '{"stardust": 8000, "title": "curator", "decoration": "statue_gold_trophy"}', 4),
('shiny_collector', 'collection', '{"zh": "闪光收藏家", "en": "Shiny Collector", "ja": "色違いコレクター"}', '{"zh": "收藏室展示 10 只闪光精灵", "en": "Display 10 shiny Pokémon in your room", "ja": "色違いポケモンを10匹飾る"}', 'epic', 150, false, '{"type": "room_shiny", "target": 10}', '{"stardust": 8000, "decoration": "effect_sparkle_aura"}', 5),
('room_popular_10', 'collection', '{"zh": "小有名气", "en": "Getting Noticed", "ja": "ちょっと有名"}', '{"zh": "收藏室获得 10 个赞", "en": "Receive 10 likes on your room", "ja": "ルームに10いいね"}', 'common', 30, false, '{"type": "room_likes", "target": 10}', '{"stardust": 1000, "decoration": "banner_fan_club"}', 6),
('room_popular_100', 'collection', '{"zh": "人气展馆", "en": "Room Star", "ja": "人気ルーム"}', '{"zh": "收藏室获得 100 个赞", "en": "Receive 100 likes on your room", "ja": "ルームに100いいね"}', 'epic', 150, false, '{"type": "room_likes", "target": 100}', '{"stardust": 8000, "title": "room_star"}', 7),
('decorator_10', 'collection', '{"zh": "布置达人", "en": "Decorator", "ja": "模様替え名人"}', '{"zh": "在收藏室摆放 10 件装饰", "en": "Place 10 decorations in your room", "ja": "デコレーションを10個置く"}', 'common', 30, false, '{"type": "room_decorations", "target": 10}', '{"stardust": 1000, "decoration": "fountain_crystal"}', 8)
ON CONFLICT (achievement_id) DO NOTHING;

-- ============================================================
-- 2. 用户成就 user_achievements：外键改指 achievements
-- ============================================================
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.user_achievements'::regclass AND contype = 'f'
              AND confrelid = 'public.achievement_definitions'::regclass
  LOOP
    EXECUTE format('ALTER TABLE user_achievements DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS target INTEGER;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT FALSE;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS rewards_claimed BOOLEAN DEFAULT FALSE;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS rewards_claimed_at TIMESTAMPTZ;
ALTER TABLE user_achievements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- 成就进度按源数据回填（幂等：只升不降，已完成不回退）。V1 计数（catch_total 等）不再使用
CREATE OR REPLACE FUNCTION achievement_backfill_metric(p_type TEXT, p_user UUID, p_value INTEGER) RETURNS VOID AS $$
  INSERT INTO user_achievements (user_id, achievement_id, progress, target, completed, completed_at, updated_at)
  SELECT p_user, a.achievement_id, LEAST(p_value, (a.trigger_conditions->>'target')::int), (a.trigger_conditions->>'target')::int,
         p_value >= (a.trigger_conditions->>'target')::int,
         CASE WHEN p_value >= (a.trigger_conditions->>'target')::int THEN NOW() END, NOW()
    FROM achievements a
   WHERE a.trigger_conditions->>'type' = p_type AND a.is_active
     AND NOT (a.trigger_conditions ? 'filters') AND p_value > 0
  ON CONFLICT (user_id, achievement_id) DO UPDATE
     SET progress = GREATEST(COALESCE(user_achievements.progress, 0), EXCLUDED.progress),
         target = EXCLUDED.target,
         completed = COALESCE(user_achievements.completed, FALSE) OR EXCLUDED.completed,
         completed_at = COALESCE(user_achievements.completed_at, EXCLUDED.completed_at),
         updated_at = NOW();
$$ LANGUAGE sql;

DO $$
DECLARE r RECORD;
BEGIN
  -- 只在尚未收敛过（仍存在 V1 计数行，或有玩家但没有任何新成就进度）时回填，避免每次迁移重算
  IF EXISTS (SELECT 1 FROM user_achievements ua WHERE NOT EXISTS (SELECT 1 FROM achievements a WHERE a.achievement_id = ua.achievement_id))
     OR (EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM user_achievements)) THEN
    FOR r IN
      SELECT user_id, 'catch_count' AS t, COUNT(*)::int AS v FROM catch_sessions WHERE result = 'CAUGHT' GROUP BY user_id
      UNION ALL SELECT user_id, 'catch_species', COUNT(*)::int FROM pokedex_entries WHERE caught_count > 0 GROUP BY user_id
      UNION ALL SELECT user_id, 'shiny_catch', COUNT(*)::int FROM pokemon_instances WHERE is_shiny GROUP BY user_id
      UNION ALL SELECT user_id, 'pokestop_visit', COUNT(*)::int FROM pokestop_spins GROUP BY user_id
      UNION ALL SELECT id, 'trainer_level', level::int FROM users WHERE level > 1
      UNION ALL SELECT id, 'distance_traveled', FLOOR(COALESCE(total_distance_km, 0))::int FROM users WHERE total_distance_km >= 1
      UNION ALL SELECT u, 'friend_count', COUNT(*)::int FROM (SELECT user_a AS u FROM friendships UNION ALL SELECT user_b FROM friendships) f GROUP BY u
      UNION ALL SELECT raid.user_id, 'raid_participate', COUNT(*)::int FROM raid_participants raid GROUP BY raid.user_id
      UNION ALL SELECT user_id, 'event_join', COUNT(*)::int FROM event_participations GROUP BY user_id
    LOOP
      IF r.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE id = r.user_id) THEN
        PERFORM achievement_backfill_metric(r.t, r.user_id, r.v);
      END IF;
    END LOOP;
  END IF;
END $$;

DELETE FROM user_achievements ua
 WHERE NOT EXISTS (SELECT 1 FROM achievements a WHERE a.achievement_id = ua.achievement_id);
UPDATE user_achievements ua SET target = (a.trigger_conditions->>'target')::int
  FROM achievements a WHERE a.achievement_id = ua.achievement_id AND ua.target IS NULL;
UPDATE user_achievements SET progress = 0 WHERE progress IS NULL;
UPDATE user_achievements SET completed = FALSE WHERE completed IS NULL;
UPDATE user_achievements SET rewards_claimed = FALSE WHERE rewards_claimed IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_achievements_achievement') THEN
    ALTER TABLE user_achievements ADD CONSTRAINT fk_user_achievements_achievement
      FOREIGN KEY (achievement_id) REFERENCES achievements(achievement_id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_user_achievements_user_completed ON user_achievements (user_id, completed_at DESC) WHERE completed;
CREATE INDEX IF NOT EXISTS idx_user_achievements_unclaimed ON user_achievements (user_id) WHERE completed AND NOT rewards_claimed;

-- 进度快照（排行榜/资料卡使用）：按用户重算
CREATE OR REPLACE FUNCTION achievement_refresh_snapshot(p_user UUID) RETURNS VOID AS $$
  INSERT INTO achievement_progress_snapshots (user_id, category_progress, total_points, achievements_completed, last_updated)
  SELECT p_user,
         COALESCE((SELECT jsonb_object_agg(category, cnt) FROM (
            SELECT a.category, COUNT(*) AS cnt FROM user_achievements ua JOIN achievements a ON a.achievement_id = ua.achievement_id
             WHERE ua.user_id = p_user AND ua.completed GROUP BY a.category) c), '{}'::jsonb),
         COALESCE((SELECT SUM(a.points) FROM user_achievements ua JOIN achievements a ON a.achievement_id = ua.achievement_id
                    WHERE ua.user_id = p_user AND ua.completed), 0),
         (SELECT COUNT(*) FROM user_achievements ua WHERE ua.user_id = p_user AND ua.completed),
         NOW()
  ON CONFLICT (user_id) DO UPDATE SET category_progress = EXCLUDED.category_progress, total_points = EXCLUDED.total_points,
         achievements_completed = EXCLUDED.achievements_completed, last_updated = NOW();
$$ LANGUAGE sql;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT user_id FROM user_achievements WHERE completed
           AND user_id NOT IN (SELECT user_id FROM achievement_progress_snapshots) LOOP
    PERFORM achievement_refresh_snapshot(r.user_id);
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS idx_achievement_snapshots_rank ON achievement_progress_snapshots (total_points DESC, achievements_completed DESC);

-- ============================================================
-- 3. 称号：定义补全（≥20 个）、解锁条件指向真实成就、每人最多一个激活称号
-- ============================================================
INSERT INTO title_definitions (title_id, name, description, category, rarity, stat_bonuses, unlock_type, unlock_criteria, special_effects, display_order) VALUES
('catcher_100', '{"zh": "捕捉能手", "en": "Skilled Catcher", "ja": "捕獲の名手"}', '{"zh": "捕捉 100 只精灵", "en": "Caught 100 Pokémon", "ja": "ポケモンを100匹捕まえた"}', 'achievement', 'rare', '{"exp_bonus": 0.02}', 'achievement', '{"achievement_id": "catch_master_100"}', '{"color": "#4FC3F7"}', 20),
('catcher_1000', '{"zh": "捕捉宗师", "en": "Catch Grandmaster", "ja": "捕獲の達人"}', '{"zh": "捕捉 1000 只精灵", "en": "Caught 1000 Pokémon", "ja": "ポケモンを1000匹捕まえた"}', 'achievement', 'epic', '{"exp_bonus": 0.05}', 'achievement', '{"achievement_id": "catch_master_1000"}', '{"color": "#AB47BC", "glow": true}', 21),
('pokedex_master', '{"zh": "图鉴大师", "en": "Pokédex Master", "ja": "図鑑マスター"}', '{"zh": "收集 151 种精灵", "en": "Collected 151 species", "ja": "151種類を集めた"}', 'achievement', 'legendary', '{"exp_bonus": 0.08}', 'achievement', '{"achievement_id": "pokedex_151"}', '{"color": "#FFD700", "glow": true}', 22),
('gym_conqueror', '{"zh": "道馆征服者", "en": "Gym Conqueror", "ja": "ジム制覇者"}', '{"zh": "攻克 100 座道馆", "en": "Conquered 100 gyms", "ja": "ジムを100回攻略"}', 'achievement', 'epic', '{"battle_power": 0.05}', 'achievement', '{"achievement_id": "gym_conqueror_100"}', '{"color": "#E53935"}', 23),
('pvp_master', '{"zh": "对战大师", "en": "PvP Master", "ja": "対戦マスター"}', '{"zh": "赢得 100 场玩家对战", "en": "Won 100 PvP battles", "ja": "対戦で100勝"}', 'achievement', 'epic', '{"battle_power": 0.05}', 'achievement', '{"achievement_id": "pvp_master_100"}', '{"color": "#E53935"}', 24),
('shiny_breeder', '{"zh": "闪光培育师", "en": "Shiny Breeder", "ja": "色違いブリーダー"}', '{"zh": "培育出闪光精灵", "en": "Bred a shiny Pokémon", "ja": "色違いを育てた"}', 'achievement', 'epic', '{"shiny_rate": 0.01}', 'achievement', '{"achievement_id": "shiny_breeder"}', '{"color": "#FFB300"}', 25),
('trade_master', '{"zh": "交易大师", "en": "Trade Master", "ja": "交換マスター"}', '{"zh": "完成 100 次交易", "en": "Completed 100 trades", "ja": "交換を100回"}', 'achievement', 'epic', '{}', 'achievement', '{"achievement_id": "trade_master_100"}', '{"color": "#26A69A"}', 26),
('explorer', '{"zh": "探险家", "en": "Explorer", "ja": "探検家"}', '{"zh": "累计行走 500 公里", "en": "Walked 500 km", "ja": "500km歩いた"}', 'achievement', 'epic', '{"exp_bonus": 0.03}', 'achievement', '{"achievement_id": "walker_500km"}', '{"color": "#66BB6A"}', 27),
('world_traveler', '{"zh": "环球旅行家", "en": "World Traveler", "ja": "世界旅行者"}', '{"zh": "累计行走 1000 公里", "en": "Walked 1000 km", "ja": "1000km歩いた"}', 'achievement', 'legendary', '{"exp_bonus": 0.05}', 'achievement', '{"achievement_id": "walker_1000km"}', '{"color": "#43A047", "glow": true}', 28),
('stop_hunter', '{"zh": "补给站猎人", "en": "Stop Hunter", "ja": "ストップハンター"}', '{"zh": "访问 1000 次补给站", "en": "Visited 1000 PokéStops", "ja": "ポケストップを1000回"}', 'achievement', 'rare', '{}', 'achievement', '{"achievement_id": "pokestop_visitor_1000"}', '{"color": "#29B6F6"}', 29),
('rising_star', '{"zh": "新星训练师", "en": "Rising Star", "ja": "期待の新星"}', '{"zh": "训练师达到 10 级", "en": "Reached level 10", "ja": "レベル10に到達"}', 'achievement', 'rare', '{"exp_bonus": 0.02}', 'achievement', '{"achievement_id": "trainer_level_10"}', '{"color": "#29B6F6"}', 30),
('elite_trainer', '{"zh": "精英训练师", "en": "Elite Trainer", "ja": "エリートトレーナー"}', '{"zh": "训练师达到 20 级", "en": "Reached level 20", "ja": "レベル20に到達"}', 'achievement', 'epic', '{"exp_bonus": 0.03}', 'achievement', '{"achievement_id": "trainer_level_20"}', '{"color": "#7E57C2"}', 31),
('master_trainer', '{"zh": "大师训练师", "en": "Master Trainer", "ja": "マスタートレーナー"}', '{"zh": "训练师达到 40 级", "en": "Reached level 40", "ja": "レベル40に到達"}', 'achievement', 'legendary', '{"exp_bonus": 0.05, "catch_rate": 0.02}', 'achievement', '{"achievement_id": "trainer_level_40"}', '{"color": "#FFD700", "glow": true}', 32),
('curator', '{"zh": "策展人", "en": "Curator", "ja": "キュレーター"}', '{"zh": "收藏室展示 50 只精灵", "en": "Displayed 50 Pokémon", "ja": "50匹を展示"}', 'achievement', 'epic', '{}', 'achievement', '{"achievement_id": "collector_gold"}', '{"color": "#8D6E63"}', 33),
('room_star', '{"zh": "人气馆主", "en": "Room Star", "ja": "人気館長"}', '{"zh": "收藏室获得 100 个赞", "en": "Room got 100 likes", "ja": "ルームに100いいね"}', 'achievement', 'epic', '{}', 'achievement', '{"achievement_id": "room_popular_100"}', '{"color": "#EC407A"}', 34),
('achievement_hunter', '{"zh": "成就猎人", "en": "Achievement Hunter", "ja": "実績ハンター"}', '{"zh": "解锁 30 个成就", "en": "Unlocked 30 achievements", "ja": "実績を30個解除"}', 'achievement', 'legendary', '{"exp_bonus": 0.05}', 'achievement', '{"achievement_id": "achievement_hunter_30"}', '{"color": "#FFD700"}', 35),
('event_regular', '{"zh": "活动常客", "en": "Event Regular", "ja": "イベント常連"}', '{"zh": "参加 10 次活动", "en": "Joined 10 events", "ja": "イベントに10回参加"}', 'achievement', 'rare', '{}', 'achievement', '{"achievement_id": "event_regular_10"}', '{"color": "#FF7043"}', 36),
('night_owl', '{"zh": "夜猫子", "en": "Night Owl", "ja": "夜ふかし"}', '{"zh": "深夜捕捉精灵", "en": "Caught a Pokémon late at night", "ja": "深夜にポケモンを捕まえた"}', 'achievement', 'rare', '{}', 'achievement', '{"achievement_id": "night_owl"}', '{"color": "#5C6BC0"}', 37)
ON CONFLICT (title_id) DO NOTHING;

-- 旧种子的解锁条件引用了不存在的成就 ID（species_100、catch_500…），改为指向真实成就
UPDATE title_definitions SET unlock_criteria = '{"achievement_id": "pokedex_100"}' WHERE title_id = 'pokemon_collector' AND unlock_criteria->>'achievement_id' = 'species_100';
UPDATE title_definitions SET unlock_criteria = '{"achievement_id": "catch_master_500"}' WHERE title_id = 'catch_master' AND unlock_criteria->>'achievement_id' = 'catch_500';
UPDATE title_definitions SET unlock_criteria = '{"achievement_id": "battle_master_200"}' WHERE title_id = 'battle_veteran' AND unlock_criteria->>'achievement_id' = 'battle_100';
UPDATE title_definitions SET unlock_criteria = '{"achievement_id": "pvp_master_50"}' WHERE title_id = 'pvp_champion' AND unlock_criteria->>'achievement_id' = 'pvp_wins_50';
UPDATE title_definitions SET unlock_criteria = '{"achievement_id": "achievement_hunter_50"}' WHERE title_id = 'pokemon_master' AND unlock_criteria->>'achievement_id' = 'all_achievements';
UPDATE title_definitions SET unlock_criteria = '{"achievement_id": "shiny_hunter"}' WHERE title_id = 'shiny_hunter' AND unlock_criteria->>'achievement_id' = 'shiny_10';

-- 每人最多一个激活称号（并发激活不会出现两个）
UPDATE user_titles ut SET is_active = FALSE
 WHERE ut.is_active AND ut.id <> (SELECT id FROM user_titles x WHERE x.user_id = ut.user_id AND x.is_active ORDER BY unlocked_at DESC, id DESC LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_titles_one_active ON user_titles (user_id) WHERE is_active;
UPDATE user_titles SET source_type = 'achievement' WHERE source_type IS NULL AND source_achievement_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_titles_title')
     AND NOT EXISTS (SELECT 1 FROM user_titles ut WHERE NOT EXISTS (SELECT 1 FROM title_definitions td WHERE td.title_id = ut.title_id)) THEN
    ALTER TABLE user_titles ADD CONSTRAINT fk_user_titles_title FOREIGN KEY (title_id) REFERENCES title_definitions(title_id) ON DELETE CASCADE;
  END IF;
END $$;

-- 回填：已完成成就对应的称号
INSERT INTO user_titles (user_id, title_id, source_type, source_id, source_achievement_id)
SELECT ua.user_id, td.title_id, 'achievement', ua.achievement_id, ua.achievement_id
  FROM user_achievements ua
  JOIN achievements a ON a.achievement_id = ua.achievement_id
  JOIN title_definitions td ON td.title_id = a.rewards->>'title'
                            OR (td.unlock_type = 'achievement' AND td.unlock_criteria->>'achievement_id' = ua.achievement_id)
 WHERE ua.completed
ON CONFLICT (user_id, title_id) DO NOTHING;

-- ============================================================
-- 4. 游戏事件 outbox（achievement_events）+ 业务表触发器
-- ============================================================
ALTER TABLE achievement_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE achievement_events ADD COLUMN IF NOT EXISTS attempts SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE achievement_events ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE achievement_events ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(120);
UPDATE achievement_events SET processed = FALSE WHERE processed IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_achievement_events_dedupe ON achievement_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_achievement_events_pending ON achievement_events (user_id, id) WHERE NOT processed;
CREATE INDEX IF NOT EXISTS idx_achievement_events_processed_at ON achievement_events (processed_at) WHERE processed;

-- 写入一条游戏事件（同一 dedupe_key 只记一次）
CREATE OR REPLACE FUNCTION game_event_emit(p_user UUID, p_type TEXT, p_data JSONB, p_dedupe TEXT DEFAULT NULL) RETURNS VOID AS $$
BEGIN
  IF p_user IS NULL THEN RETURN; END IF;
  INSERT INTO achievement_events (user_id, event_type, event_data, processed, dedupe_key)
  VALUES (p_user, p_type, COALESCE(p_data, '{}'::jsonb), FALSE, p_dedupe)
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- 新事件通知消费者（同一事务内相同 payload 只投递一次）
CREATE OR REPLACE FUNCTION game_event_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pmg_game_events', NEW.user_id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_achievement_events_notify ON achievement_events;
CREATE TRIGGER trg_achievement_events_notify AFTER INSERT ON achievement_events
  FOR EACH ROW WHEN (NOT NEW.processed) EXECUTE FUNCTION game_event_notify();

-- 捕捉成功：catch_sessions.result 变为 CAUGHT
CREATE OR REPLACE FUNCTION trg_game_event_catch() RETURNS trigger AS $$
DECLARE p RECORD; new_species BOOLEAN; hr INT;
BEGIN
  IF NEW.result IS NULL OR NEW.result::text <> 'CAUGHT' OR NEW.instance_id IS NULL OR (TG_OP = 'UPDATE' AND OLD.result IS NOT DISTINCT FROM NEW.result) THEN RETURN NULL; END IF;
  BEGIN
    SELECT species_id, is_shiny, is_lucky, is_perfect_iv, cp INTO p FROM pokemon_instances WHERE id = NEW.instance_id;
    SELECT caught_count <= 1 INTO new_species FROM pokedex_entries WHERE user_id = NEW.user_id AND species_id = p.species_id;
    hr := EXTRACT(HOUR FROM NOW())::int;
    PERFORM game_event_emit(NEW.user_id, 'catch', jsonb_build_object(
      'sessionId', NEW.id, 'instanceId', NEW.instance_id, 'speciesId', p.species_id, 'cp', p.cp,
      'is_shiny', COALESCE(p.is_shiny, FALSE), 'is_lucky', COALESCE(p.is_lucky, FALSE),
      'is_perfect_iv', COALESCE(p.is_perfect_iv, FALSE), 'is_new_species', COALESCE(new_species, FALSE),
      'is_night', hr < 5, 'hour', hr), 'catch:' || NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (catch) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_catch_sessions_game_event ON catch_sessions;
CREATE TRIGGER trg_catch_sessions_game_event AFTER INSERT OR UPDATE OF result ON catch_sessions
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_catch();

-- 转动补给站
CREATE OR REPLACE FUNCTION trg_game_event_pokestop() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM game_event_emit(NEW.user_id, 'pokestop_spin', jsonb_build_object(
      'pokestopId', NEW.pokestop_id, 'streak', NEW.streak_day, 'streak_bonus', COALESCE(NEW.streak_day, 1) >= 7), 'spin:' || NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (pokestop) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_pokestop_spins_game_event ON pokestop_spins;
CREATE TRIGGER trg_pokestop_spins_game_event AFTER INSERT ON pokestop_spins
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_pokestop();

-- 训练师升级（trainer_level_ups 由 users 上的等级触发器写入，覆盖所有加经验路径）
CREATE OR REPLACE FUNCTION trg_game_event_level_up() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM game_event_emit(NEW.user_id, 'level_up', jsonb_build_object(
      'levelUpId', NEW.id, 'fromLevel', NEW.from_level, 'toLevel', NEW.to_level, 'rewards', NEW.rewards), 'lvl:' || NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (level_up) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_trainer_level_ups_game_event ON trainer_level_ups;
CREATE TRIGGER trg_trainer_level_ups_game_event AFTER INSERT ON trainer_level_ups
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_level_up();

-- 好友（两套好友表都接：friendships 为规范化的一行一对，friends 为每个方向一行）
CREATE OR REPLACE FUNCTION trg_game_event_friendship() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM game_event_emit(NEW.user_a, 'friend_added', jsonb_build_object('friendId', NEW.user_b), 'fs:' || NEW.id || ':a');
    PERFORM game_event_emit(NEW.user_b, 'friend_added', jsonb_build_object('friendId', NEW.user_a), 'fs:' || NEW.id || ':b');
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (friendship) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_friendships_game_event ON friendships;
CREATE TRIGGER trg_friendships_game_event AFTER INSERT ON friendships
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_friendship();

CREATE OR REPLACE FUNCTION trg_game_event_friends() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS NOT NULL AND NEW.status NOT IN ('accepted', 'active') THEN RETURN NULL; END IF;
  BEGIN
    PERFORM game_event_emit(NEW.user_id, 'friend_added', jsonb_build_object('friendId', NEW.friend_user_id), 'fr:' || NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (friends) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_friends_game_event ON friends;
CREATE TRIGGER trg_friends_game_event AFTER INSERT ON friends
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_friends();

-- 收到好友请求
CREATE OR REPLACE FUNCTION trg_game_event_friend_request() RETURNS trigger AS $$
BEGIN
  IF COALESCE(NEW.status, 'pending') <> 'pending' THEN RETURN NULL; END IF;
  BEGIN
    PERFORM game_event_emit(NEW.to_user_id, 'friend_request_received', jsonb_build_object(
      'requestId', NEW.id, 'fromUserId', NEW.from_user_id, 'message', LEFT(COALESCE(NEW.message, ''), 100)), 'freq:' || NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (friend_request) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_friend_requests_game_event ON friend_requests;
CREATE TRIGGER trg_friend_requests_game_event AFTER INSERT ON friend_requests
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_friend_request();

-- 礼物（两套礼物列都兼容）
CREATE OR REPLACE FUNCTION trg_game_event_gift() RETURNS trigger AS $$
DECLARE s UUID := COALESCE(NEW.sender_id, NEW.from_user_id); r UUID := COALESCE(NEW.receiver_id, NEW.to_user_id);
BEGIN
  BEGIN
    PERFORM game_event_emit(s, 'gift_sent', jsonb_build_object('giftId', NEW.id, 'toUserId', r), 'gs:' || NEW.id);
    PERFORM game_event_emit(r, 'gift_received', jsonb_build_object('giftId', NEW.id, 'fromUserId', s,
      'giftName', COALESCE(NEW.gift_name, '')), 'gr:' || NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (gift) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_friend_gifts_game_event ON friend_gifts;
CREATE TRIGGER trg_friend_gifts_game_event AFTER INSERT ON friend_gifts
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_gift();

-- 交易完成
CREATE OR REPLACE FUNCTION trg_game_event_trade() RETURNS trigger AS $$
BEGIN
  IF COALESCE(NEW.status, '') <> 'COMPLETED' OR (TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status) THEN RETURN NULL; END IF;
  BEGIN
    PERFORM game_event_emit(NEW.initiator_id, 'trade_completed', jsonb_build_object('tradeId', NEW.id, 'partnerId', NEW.receiver_id,
      'is_lucky', COALESCE(NEW.is_lucky, FALSE)), 'tr:' || NEW.id || ':i');
    PERFORM game_event_emit(NEW.receiver_id, 'trade_completed', jsonb_build_object('tradeId', NEW.id, 'partnerId', NEW.initiator_id,
      'is_lucky', COALESCE(NEW.is_lucky, FALSE)), 'tr:' || NEW.id || ':r');
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (trade) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_pokemon_trades_game_event ON pokemon_trades;
CREATE TRIGGER trg_pokemon_trades_game_event AFTER INSERT OR UPDATE OF status ON pokemon_trades
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_trade();

-- 道馆战
CREATE OR REPLACE FUNCTION trg_game_event_gym_battle() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM game_event_emit(COALESCE(NEW.attacker_user_id, NEW.attacker_id), 'gym_battle', jsonb_build_object(
      'battleId', NEW.id, 'gymId', NEW.gym_id, 'result', NEW.result::text), 'gb:' || NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (gym_battle) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_gym_battles_game_event ON gym_battles;
CREATE TRIGGER trg_gym_battles_game_event AFTER INSERT ON gym_battles
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_gym_battle();

-- 团体战参与
CREATE OR REPLACE FUNCTION trg_game_event_raid() RETURNS trigger AS $$
BEGIN
  BEGIN
    PERFORM game_event_emit(NEW.user_id, 'raid_join', jsonb_build_object('raidId', NEW.raid_id), 'rp:' || NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (raid) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_raid_participants_game_event ON raid_participants;
CREATE TRIGGER trg_raid_participants_game_event AFTER INSERT ON raid_participants
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_raid();

-- PvP 胜利
CREATE OR REPLACE FUNCTION trg_game_event_pvp() RETURNS trigger AS $$
BEGIN
  IF NEW.winner_id IS NULL OR (TG_OP = 'UPDATE' AND OLD.winner_id IS NOT DISTINCT FROM NEW.winner_id) THEN RETURN NULL; END IF;
  BEGIN
    PERFORM game_event_emit(NEW.winner_id, 'pvp_win', jsonb_build_object('battleId', NEW.id, 'battleType', NEW.battle_type), 'pvp:' || NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (pvp) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_pvp_battles_game_event ON pvp_battles;
CREATE TRIGGER trg_pvp_battles_game_event AFTER INSERT OR UPDATE OF winner_id ON pvp_battles
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_pvp();

-- 培育出蛋 / 孵化
CREATE OR REPLACE FUNCTION trg_game_event_egg() RETURNS trigger AS $$
DECLARE p RECORD;
BEGIN
  BEGIN
    SELECT is_shiny, is_perfect_iv INTO p FROM pokemon_instances WHERE id = NEW.pokemon_id;
    IF TG_OP = 'INSERT' THEN
      PERFORM game_event_emit(NEW.user_id, 'pokemon_bred', jsonb_build_object('eggId', NEW.id,
        'is_shiny', COALESCE(p.is_shiny, FALSE)), 'egg:' || NEW.id);
    ELSIF NEW.hatched_at IS NOT NULL AND OLD.hatched_at IS NULL THEN
      PERFORM game_event_emit(NEW.user_id, 'egg_hatched', jsonb_build_object('eggId', NEW.id,
        'is_shiny', COALESCE(p.is_shiny, FALSE), 'is_perfect_iv', COALESCE(p.is_perfect_iv, FALSE)), 'hatch:' || NEW.id);
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (egg) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_egg_hatching_game_event ON egg_hatching;
CREATE TRIGGER trg_egg_hatching_game_event AFTER INSERT OR UPDATE OF hatched_at ON egg_hatching
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_egg();

-- 活动参与 / 完成（领奖）
CREATE OR REPLACE FUNCTION trg_game_event_event_participation() RETURNS trigger AS $$
DECLARE k TEXT;
BEGIN
  BEGIN
    SELECT event_key INTO k FROM events WHERE id = NEW.event_id;
    IF TG_OP = 'INSERT' THEN
      PERFORM game_event_emit(NEW.user_id, 'event_joined', jsonb_build_object('eventId', NEW.event_id, 'eventKey', k), 'ej:' || NEW.id);
    END IF;
    IF COALESCE(NEW.rewards_claimed, FALSE) AND (TG_OP = 'INSERT' OR NOT COALESCE(OLD.rewards_claimed, FALSE)) THEN
      PERFORM game_event_emit(NEW.user_id, 'event_completed', jsonb_build_object('eventId', NEW.event_id, 'eventKey', k), 'ec:' || NEW.id);
    END IF;
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'game event (event) skipped: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_event_participations_game_event ON event_participations;
CREATE TRIGGER trg_event_participations_game_event AFTER INSERT OR UPDATE OF rewards_claimed ON event_participations
  FOR EACH ROW EXECUTE FUNCTION trg_game_event_event_participation();

COMMENT ON TABLE achievement_events IS '游戏事件 outbox：业务表触发器写入，backend/shared/achievementEngine.js 消费（成就进度/称号/消息）';

-- migrate:down
DROP TRIGGER IF EXISTS trg_event_participations_game_event ON event_participations;
DROP TRIGGER IF EXISTS trg_egg_hatching_game_event ON egg_hatching;
DROP TRIGGER IF EXISTS trg_pvp_battles_game_event ON pvp_battles;
DROP TRIGGER IF EXISTS trg_raid_participants_game_event ON raid_participants;
DROP TRIGGER IF EXISTS trg_gym_battles_game_event ON gym_battles;
DROP TRIGGER IF EXISTS trg_pokemon_trades_game_event ON pokemon_trades;
DROP TRIGGER IF EXISTS trg_friend_gifts_game_event ON friend_gifts;
DROP TRIGGER IF EXISTS trg_friend_requests_game_event ON friend_requests;
DROP TRIGGER IF EXISTS trg_friends_game_event ON friends;
DROP TRIGGER IF EXISTS trg_friendships_game_event ON friendships;
DROP TRIGGER IF EXISTS trg_trainer_level_ups_game_event ON trainer_level_ups;
DROP TRIGGER IF EXISTS trg_pokestop_spins_game_event ON pokestop_spins;
DROP TRIGGER IF EXISTS trg_catch_sessions_game_event ON catch_sessions;
DROP TRIGGER IF EXISTS trg_achievement_events_notify ON achievement_events;
DROP INDEX IF EXISTS uq_user_titles_one_active;
