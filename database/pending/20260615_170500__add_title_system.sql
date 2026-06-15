-- REQ-00106: 玩家称号系统与个性化展示
-- 创建时间：2026-06-15

-- 称号定义表
CREATE TABLE IF NOT EXISTS title_definitions (
  title_id VARCHAR(50) PRIMARY KEY,
  name JSONB NOT NULL,           -- 多语言名称 {"zh": "精灵大师", "en": "Pokemon Master"}
  description JSONB NOT NULL,    -- 多语言描述
  category VARCHAR(30) NOT NULL, -- 分类：achievement/event/rank/special
  rarity VARCHAR(20) NOT NULL,   -- 稀有度：common/rare/epic/legendary/mythic
  icon_url TEXT,
  
  -- 属性加成
  stat_bonuses JSONB DEFAULT '{}', -- {"catch_rate": 0.05, "exp_bonus": 0.1}
  
  -- 获取条件
  unlock_type VARCHAR(30) NOT NULL, -- achievement/event/milestone/purchase
  unlock_criteria JSONB NOT NULL,   -- {"achievement_id": "ach_001"} 或 {"event_id": "evt_001"}
  
  -- 特效
  special_effects JSONB DEFAULT '{}', -- {"glow_color": "#FFD700", "particles": true}
  
  is_active BOOLEAN DEFAULT true,
  is_limited BOOLEAN DEFAULT false,
  available_until TIMESTAMP,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_title_definitions_category ON title_definitions(category);
CREATE INDEX IF NOT EXISTS idx_title_definitions_rarity ON title_definitions(rarity);
CREATE INDEX IF NOT EXISTS idx_title_definitions_unlock_type ON title_definitions(unlock_type);
CREATE INDEX IF NOT EXISTS idx_title_definitions_unlock_achievement ON title_definitions((unlock_criteria->>'achievement_id')) WHERE unlock_type = 'achievement';

-- 用户称号表
CREATE TABLE IF NOT EXISTS user_titles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id VARCHAR(50) NOT NULL REFERENCES title_definitions(title_id),
  
  source_type VARCHAR(30) NOT NULL,  -- achievement/event/purchase/gift
  source_id VARCHAR(100),             -- 来源ID（成就ID/活动ID等）
  
  is_active BOOLEAN DEFAULT false,    -- 当前激活的称号
  is_favorite BOOLEAN DEFAULT false,
  
  unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,               -- 限时称号过期时间
  
  UNIQUE(user_id, title_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_user_titles_user ON user_titles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_titles_active ON user_titles(user_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_user_titles_expires ON user_titles(expires_at) WHERE expires_at IS NOT NULL;

-- 称号统计视图
CREATE OR REPLACE VIEW user_title_stats AS
SELECT 
  u.id as user_id,
  COUNT(ut.id) as total_titles,
  COUNT(CASE WHEN td.rarity = 'legendary' THEN 1 END) as legendary_count,
  COUNT(CASE WHEN td.rarity = 'mythic' THEN 1 END) as mythic_count,
  ut_active.title_id as active_title_id
FROM users u
LEFT JOIN user_titles ut ON u.id = ut.user_id
LEFT JOIN title_definitions td ON ut.title_id = td.title_id
LEFT JOIN user_titles ut_active ON u.id = ut_active.user_id AND ut_active.is_active = true
GROUP BY u.id, ut_active.title_id;

-- 种子数据：成就类称号
INSERT INTO title_definitions (title_id, name, description, category, rarity, icon_url, stat_bonuses, unlock_type, unlock_criteria, special_effects, display_order) VALUES
('novice_trainer', '{"zh": "新手训练师", "en": "Novice Trainer"}', '{"zh": "捕捉第一只精灵", "en": "Catch your first Pokemon"}', 'achievement', 'common', '/icons/titles/novice.png', '{}', 'achievement', '{"achievement_id": "first_catch"}', '{}', 1),
('pokemon_collector', '{"zh": "精灵收藏家", "en": "Pokemon Collector"}', '{"zh": "收集100种不同精灵", "en": "Collect 100 different Pokemon species"}', 'achievement', 'rare', '/icons/titles/collector.png', '{"exp_bonus": 0.05}', 'achievement', '{"achievement_id": "species_100"}', '{}', 10),
('catch_master', '{"zh": "捕捉大师", "en": "Catch Master"}', '{"zh": "捕捉500只精灵", "en": "Catch 500 Pokemon"}', 'achievement', 'rare', '/icons/titles/catch_master.png', '{"catch_rate": 0.03}', 'achievement', '{"achievement_id": "catch_500"}', '{}', 15),
('gym_leader', '{"zh": "道馆馆主", "en": "Gym Leader"}', '{"zh": "征服10座道馆", "en": "Conquer 10 gyms"}', 'achievement', 'epic', '/icons/titles/gym_leader.png', '{"battle_power": 0.03}', 'achievement', '{"achievement_id": "gym_conqueror_10"}', '{"glow_color": "#4A90D9"}', 20),
('battle_veteran', '{"zh": "战斗老兵", "en": "Battle Veteran"}', '{"zh": "完成100场战斗", "en": "Complete 100 battles"}', 'achievement', 'rare', '/icons/titles/battle_vet.png', '{"battle_power": 0.02}', 'achievement', '{"achievement_id": "battle_100"}', '{}', 18),
('pvp_champion', '{"zh": "PVP冠军", "en": "PVP Champion"}', '{"zh": "PVP获胜50场", "en": "Win 50 PVP battles"}', 'achievement', 'epic', '/icons/titles/pvp_champ.png', '{"battle_power": 0.05}', 'achievement', '{"achievement_id": "pvp_wins_50"}', '{"glow_color": "#FF6B6B"}', 25),
('pokemon_master', '{"zh": "精灵大师", "en": "Pokemon Master"}', '{"zh": "完成所有主要成就", "en": "Complete all major achievements"}', 'achievement', 'legendary', '/icons/titles/master.png', '{"catch_rate": 0.1, "exp_bonus": 0.1, "battle_power": 0.05}', 'achievement', '{"achievement_id": "all_achievements"}', '{"glow_color": "#FFD700", "particles": true}', 50),
('shiny_hunter', '{"zh": "闪光猎人", "en": "Shiny Hunter"}', '{"zh": "捕捉10只闪光精灵", "en": "Catch 10 shiny Pokemon"}', 'achievement', 'legendary', '/icons/titles/shiny.png', '{"shiny_rate": 0.02}', 'achievement', '{"achievement_id": "shiny_10"}', '{"glow_color": "#FFD700", "sparkle": true}', 45)
ON CONFLICT (title_id) DO NOTHING;

-- 种子数据：活动类称号
INSERT INTO title_definitions (title_id, name, description, category, rarity, icon_url, stat_bonuses, unlock_type, unlock_criteria, special_effects, display_order) VALUES
('summer_champion', '{"zh": "夏日冠军", "en": "Summer Champion"}', '{"zh": "夏季活动冠军", "en": "Summer event champion"}', 'event', 'epic', '/icons/titles/summer.png', '{"catch_rate": 0.05}', 'event', '{"event_id": "summer_2026"}', '{"glow_color": "#FFA500"}', 30),
('winter_explorer', '{"zh": "冬日探险家", "en": "Winter Explorer"}', '{"zh": "冬季活动参与者", "en": "Winter event participant"}', 'event', 'rare', '/icons/titles/winter.png', '{"exp_bonus": 0.03}', 'event', '{"event_id": "winter_2026"}', '{}', 32),
('spring_gardener', '{"zh": "春日园丁", "en": "Spring Gardener"}', '{"zh": "春季活动完成者", "en": "Spring event finisher"}', 'event', 'rare', '/icons/titles/spring.png', '{}', 'event', '{"event_id": "spring_2026"}', '{}', 34),
('halloween_spooky', '{"zh": "幽灵猎手", "en": "Spooky Hunter"}', '{"zh": "万圣节活动限定", "en": "Halloween event limited"}', 'event', 'epic', '/icons/titles/halloween.png', '{"battle_power": 0.03}', 'event', '{"event_id": "halloween_2026"}', '{"glow_color": "#8B00FF"}', 36)
ON CONFLICT (title_id) DO NOTHING;

-- 种子数据：排名类称号
INSERT INTO title_definitions (title_id, name, description, category, rarity, icon_url, stat_bonuses, unlock_type, unlock_criteria, special_effects, display_order) VALUES
('top_100', '{"zh": "百强训练师", "en": "Top 100 Trainer"}', '{"zh": "排行榜前100名", "en": "Top 100 in leaderboard"}', 'rank', 'epic', '/icons/titles/top100.png', '{"exp_bonus": 0.08}', 'milestone', '{"rank_requirement": 100}', '{}', 40),
('top_10', '{"zh": "十强训练师", "en": "Top 10 Trainer"}', '{"zh": "排行榜前10名", "en": "Top 10 in leaderboard"}', 'rank', 'legendary', '/icons/titles/top10.png', '{"catch_rate": 0.08, "exp_bonus": 0.1}', 'milestone', '{"rank_requirement": 10}', '{"glow_color": "#00CED1"}', 55),
('champion', '{"zh": "冠军", "en": "Champion"}', '{"zh": "排行榜第一名", "en": "Rank #1 in leaderboard"}', 'rank', 'mythic', '/icons/titles/champion.png', '{"catch_rate": 0.15, "exp_bonus": 0.15, "battle_power": 0.1}', 'milestone', '{"rank_requirement": 1}', '{"glow_color": "#FF00FF", "particles": true, "aura": true}', 100)
ON CONFLICT (title_id) DO NOTHING;

-- 种子数据：特殊称号
INSERT INTO title_definitions (title_id, name, description, category, rarity, icon_url, stat_bonuses, unlock_type, unlock_criteria, special_effects, display_order) VALUES
('early_supporter', '{"zh": "早期支持者", "en": "Early Supporter"}', '{"zh": "感谢早期支持", "en": "Thank you for early support"}', 'special', 'rare', '/icons/titles/early.png', '{"exp_bonus": 0.05}', 'special', '{"beta_user": true}', '{}', 60),
('community_helper', '{"zh": "社区贡献者", "en": "Community Helper"}', '{"zh": "社区贡献奖励", "en": "Community contribution reward"}', 'special', 'epic', '/icons/titles/helper.png', '{}', 'special', '{"contribution_score": 100}', '{"glow_color": "#32CD32"}', 65),
('bug_finder', '{"zh": "Bug猎人", "en": "Bug Hunter"}', '{"zh": "报告重要Bug", "en": "Reported significant bugs"}', 'special', 'rare', '/icons/titles/bug.png', '{}', 'special', '{"bugs_reported": 5}', '{}', 70)
ON CONFLICT (title_id) DO NOTHING;

-- 更新时间触发器
CREATE OR REPLACE FUNCTION update_title_definitions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_title_definitions_updated_at
BEFORE UPDATE ON title_definitions
FOR EACH ROW
EXECUTE FUNCTION update_title_definitions_updated_at();

-- 评论
COMMENT ON TABLE title_definitions IS '称号定义表，存储所有可获得的称号信息';
COMMENT ON TABLE user_titles IS '用户称号表，记录用户已解锁的称号';
COMMENT ON VIEW user_title_stats IS '用户称号统计视图，快速获取用户的称号数量和稀有度统计';