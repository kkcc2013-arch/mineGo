/**
 * 数据库迁移：用户安全偏好与动画安全规则
 * REQ-00356: 游戏光敏性癫痫防护与运动敏感性设置系统
 */

const migrations = [
  {
    version: '20260629001',
    name: 'create_user_safety_preferences_table',
    sql: `
      -- 用户安全偏好表
      CREATE TABLE IF NOT EXISTS user_safety_preferences (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        
        -- 癫痫防护
        epilepsy_protection VARCHAR(20) DEFAULT 'moderate' 
          CHECK (epilepsy_protection IN ('off', 'moderate', 'strong')),
        max_flash_hz REAL DEFAULT 3.0,
        max_contrast_ratio REAL DEFAULT 4.5,
        
        -- 运动敏感性
        motion_sensitivity_enabled BOOLEAN DEFAULT false,
        rotation_reduction REAL DEFAULT 0.5 CHECK (rotation_reduction BETWEEN 0 AND 1),
        translation_reduction REAL DEFAULT 0.3 CHECK (translation_reduction BETWEEN 0 AND 1),
        scaling_reduction REAL DEFAULT 0.4 CHECK (scaling_reduction BETWEEN 0 AND 1),
        parallax_reduction REAL DEFAULT 0.6 CHECK (parallax_reduction BETWEEN 0 AND 1),
        particles_reduction REAL DEFAULT 0.5 CHECK (particles_reduction BETWEEN 0 AND 1),
        
        -- 高风险场景
        safe_evolution BOOLEAN DEFAULT true,
        safe_battle_effects BOOLEAN DEFAULT true,
        safe_weather_effects BOOLEAN DEFAULT true,
        safe_gym_flashes BOOLEAN DEFAULT true,
        
        -- 时间戳
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        
        UNIQUE(user_id)
      );

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_safety_prefs_user ON user_safety_preferences(user_id);
      CREATE INDEX IF NOT EXISTS idx_safety_prefs_epilepsy ON user_safety_preferences(epilepsy_protection);

      COMMENT ON TABLE user_safety_preferences IS '用户安全偏好设置，用于光敏性癫痫防护和运动敏感性设置';
    `
  },
  {
    version: '20260629002',
    name: 'create_animation_safety_rules_table',
    sql: `
      -- 动画安全规则表
      CREATE TABLE IF NOT EXISTS animation_safety_rules (
        id SERIAL PRIMARY KEY,
        animation_id VARCHAR(100) NOT NULL UNIQUE,
        animation_name VARCHAR(200) NOT NULL,
        category VARCHAR(50) NOT NULL,
        
        -- 风险评估
        danger_level VARCHAR(20) NOT NULL 
          CHECK (danger_level IN ('low', 'medium', 'high', 'critical')),
        flash_frequency REAL DEFAULT 0,
        contrast_ratio REAL DEFAULT 0,
        motion_intensity REAL DEFAULT 0,
        
        -- 替代方案
        moderate_alternative JSONB DEFAULT '{}',
        strong_alternative JSONB DEFAULT '{}',
        static_fallback VARCHAR(200),
        
        -- 元数据
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_safety_rules_danger ON animation_safety_rules(danger_level);
      CREATE INDEX IF NOT EXISTS idx_safety_rules_category ON animation_safety_rules(category);

      -- 插入常见高风险动画规则
      INSERT INTO animation_safety_rules (animation_id, animation_name, category, danger_level, flash_frequency, contrast_ratio, motion_intensity, moderate_alternative, strong_alternative, static_fallback) VALUES
        ('evolution_flash', '精灵进化闪光', 'evolution', 'critical', 8.0, 10.0, 0.8,
          '{"type": "glow", "duration": 3000, "intensity": 0.5}',
          '{"type": "static", "image": "evolution_success.png"}',
          'evolution_success.png'),
        ('battle_beam', '战斗激光束', 'battle', 'high', 12.0, 7.5, 0.6,
          '{"type": "laser", "flickerRate": 2, "colors": ["white"]}',
          '{"type": "static", "image": "beam_hit.png"}',
          'beam_hit.png'),
        ('catch_explosion', '捕捉爆炸效果', 'catch', 'high', 15.0, 6.0, 0.7,
          '{"type": "particles", "count": 20, "sparkle": false}',
          '{"type": "fade", "duration": 500}',
          'catch_success.png'),
        ('lightning', '雷电天气效果', 'weather', 'critical', 20.0, 12.0, 0.9,
          '{"type": "dim_flash", "maxIntensity": 0.3}',
          '{"type": "static_overlay", "image": "clouds.png"}',
          'storm_clouds.png'),
        ('gym_flash', '道馆战斗闪光', 'gym', 'high', 10.0, 8.0, 0.5,
          '{"type": "glow", "intensity": 0.3}',
          '{"type": "static", "image": "gym_battle_result.png"}',
          'gym_result.png'),
        ('skill_particles', '技能粒子效果', 'battle', 'medium', 5.0, 4.0, 0.6,
          '{"type": "particles", "count": 15, "sparkle": false}',
          '{"type": "static", "image": "skill_effect.png"}',
          'skill_effect.png'),
        ('catch_stars', '捕捉星星散射', 'catch', 'medium', 6.0, 5.0, 0.4,
          '{"type": "particles", "count": 10, "sparkle": false}',
          '{"type": "fade", "duration": 300}',
          'stars.png'),
        ('weather_snow', '暴风雪效果', 'weather', 'medium', 3.0, 3.0, 0.7,
          '{"type": "particles", "count": 30, "speed": 0.3}',
          '{"type": "static_overlay", "image": "snow_static.png"}',
          'snow_static.png'),
        ('evolution_glow', '精灵进化光环', 'evolution', 'high', 6.0, 8.0, 0.5,
          '{"type": "glow", "intensity": 0.4, "duration": 4000}',
          '{"type": "static", "image": "evolution_glow_static.png"}',
          'evolution_glow_static.png'),
        ('battle_explosion', '战斗爆炸特效', 'battle', 'high', 18.0, 9.0, 0.8,
          '{"type": "particles", "count": 25, "sparkle": false}',
          '{"type": "static", "image": "explosion_static.png"}',
          'explosion_static.png')
      ON CONFLICT (animation_id) DO NOTHING;

      COMMENT ON TABLE animation_safety_rules IS '动画安全规则，定义各类动画的风险等级和替代方案';
    `
  },
  {
    version: '20260629003',
    name: 'create_safety_event_log_table',
    sql: `
      -- 安全事件日志表
      CREATE TABLE IF NOT EXISTS safety_event_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        event_type VARCHAR(50) NOT NULL,
        animation_id VARCHAR(100),
        
        -- 事件详情
        severity VARCHAR(20) NOT NULL 
          CHECK (severity IN ('info', 'warning', 'danger', 'critical')),
        flash_frequency REAL,
        motion_intensity REAL,
        
        -- 处理结果
        action_taken VARCHAR(50),
        alternative_applied VARCHAR(100),
        
        -- 上下文
        game_context JSONB DEFAULT '{}',
        session_id VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_safety_log_user ON safety_event_log(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_safety_log_severity ON safety_event_log(severity, created_at);
      CREATE INDEX IF NOT EXISTS idx_safety_log_animation ON safety_event_log(animation_id);
      CREATE INDEX IF NOT EXISTS idx_safety_log_type ON safety_event_log(event_type);

      COMMENT ON TABLE safety_event_log IS '安全事件日志，记录所有安全相关事件的检测和处理';
    `
  }
];

/**
 * 执行迁移
 */
async function runMigration(db) {
  for (const migration of migrations) {
    try {
      console.log(`Running migration: ${migration.name} (${migration.version})`);
      
      await db.query(migration.sql);
      
      // 记录迁移完成
      await db.query(
        `INSERT INTO migration_history (version, name, executed_at) 
         VALUES ($1, $2, NOW())
         ON CONFLICT (version) DO NOTHING`,
        [migration.version, migration.name]
      );
      
      console.log(`Migration ${migration.name} completed successfully`);
    } catch (error) {
      console.error(`Migration ${migration.name} failed:`, error.message);
      throw error;
    }
  }
}

module.exports = {
  migrations,
  runMigration
};