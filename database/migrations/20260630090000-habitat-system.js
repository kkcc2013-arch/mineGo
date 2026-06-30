// database/migrations/20260630090000-habitat-system.js
// REQ-00361: 精灵栖息地偏好与环境加成系统

'use strict';

const { query } = require('../../backend/shared/db');

/**
 * Migration: Habitat System Tables
 * Creates tables for habitat types, pokemon habitat preferences, and habitat areas
 */

async function up() {
  console.log('Creating habitat system tables...');

  // 1. 栖息地类型表
  await query(`
    CREATE TABLE IF NOT EXISTS habitats (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      name_en VARCHAR(100) NOT NULL,
      terrain_features TEXT,
      description TEXT,
      bonus_multiplier DECIMAL(5,4) DEFAULT 1.0,
      icon_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // 2. 精灵栖息地偏好表
  await query(`
    CREATE TABLE IF NOT EXISTS pokemon_habitat_preferences (
      id SERIAL PRIMARY KEY,
      species_id VARCHAR(100) NOT NULL,
      habitat_id VARCHAR(50) NOT NULL REFERENCES habitats(id),
      priority INTEGER DEFAULT 1,
      battle_bonus DECIMAL(5,4) DEFAULT 1.15,
      catch_bonus DECIMAL(5,4) DEFAULT 1.15,
      spawn_boost DECIMAL(5,4) DEFAULT 1.5,
      is_primary BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(species_id, habitat_id)
    )
  `);

  // 3. 栖息地区域定义表（自定义区域）
  await query(`
    CREATE TABLE IF NOT EXISTS habitat_areas (
      id SERIAL PRIMARY KEY,
      habitat_id VARCHAR(50) NOT NULL REFERENCES habitats(id),
      area_name VARCHAR(200) NOT NULL,
      center_lat DECIMAL(10,8) NOT NULL,
      center_lon DECIMAL(11,8) NOT NULL,
      radius_meters INTEGER DEFAULT 500,
      geometry GEOMETRY(POLYGON, 4326),
      is_active BOOLEAN DEFAULT TRUE,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // 4. 用户栖息地缓存表（记录用户当前位置的环境）
  await query(`
    CREATE TABLE IF NOT EXISTS user_habitat_cache (
      user_id INTEGER PRIMARY KEY,
      current_habitat VARCHAR(50) REFERENCES habitats(id),
      last_location_lat DECIMAL(10,8),
      last_location_lon DECIMAL(11,8),
      confidence DECIMAL(5,4) DEFAULT 0.0,
      identified_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP
    )
  `);

  // 5. 插入 10 种核心栖息地类型
  await query(`
    INSERT INTO habitats (id, name, name_en, terrain_features, description, bonus_multiplier) VALUES
    ('forest', '森林', 'Forest', '树木覆盖率 >40%', '茂密的树林区域，适合草系和虫系精灵', 1.15),
    ('water', '水域', 'Water', '水面/河流/湖泊/海洋', '河流、湖泊、海洋等水域区域', 1.15),
    ('mountain', '山地', 'Mountain', '海拔 >500m', '高山区域，适合石系和飞行系精灵', 1.15),
    ('desert', '沙漠', 'Desert', '干旱/沙地/荒漠', '干燥的沙地区域，适合地面系和火系精灵', 1.15),
    ('grassland', '草原', 'Grassland', '开阔草地', '广阔的草原区域，适合草系和地面系精灵', 1.10),
    ('urban', '城市', 'Urban', '建筑密集区', '城市建筑密集区域，适合电系和毒系精灵', 1.10),
    ('coastal', '海岸', 'Coastal', '海岸线 <500m', '海岸线附近区域，适合水系和飞行系精灵', 1.15),
    ('cave', '洞穴', 'Cave', '地下空间/山洞', '地下洞穴空间，适合石系和幽灵系精灵', 1.15),
    ('wetland', '湿地', 'Wetland', '沼泽/湿地', '沼泽湿地区域，适合水系和草系精灵', 1.10),
    ('volcanic', '火山', 'Volcanic', '火山区域', '火山活动区域，适合火系精灵', 1.20)
    ON CONFLICT (id) DO NOTHING
  `);

  // 6. 插入精灵栖息地偏好示例数据（部分热门精灵）
  await query(`
    INSERT INTO pokemon_habitat_preferences (species_id, habitat_id, priority, battle_bonus, catch_bonus, spawn_boost, is_primary) VALUES
    -- 皮卡丘（电系）偏好城市和森林
    ('pikachu', 'urban', 1, 1.10, 1.15, 2.0, false),
    ('pikachu', 'forest', 2, 1.15, 1.10, 1.5, true),
    
    -- 小火龙（火系）偏好火山和沙漠
    ('charmander', 'volcanic', 1, 1.20, 1.20, 3.0, true),
    ('charmander', 'desert', 2, 1.15, 1.15, 2.0, false),
    
    -- 杰尼龟（水系）偏好水域和海岸
    ('squirtle', 'water', 1, 1.15, 1.20, 2.5, true),
    ('squirtle', 'coastal', 2, 1.15, 1.15, 2.0, false),
    
    -- 妙蛙种子（草系）偏好森林和草原
    ('bulbasaur', 'forest', 1, 1.15, 1.20, 2.5, true),
    ('bulbasaur', 'grassland', 2, 1.10, 1.15, 2.0, false),
    
    -- 伊布偏好草原和森林
    ('eevee', 'grassland', 1, 1.10, 1.15, 2.0, true),
    ('eevee', 'forest', 2, 1.15, 1.10, 1.5, false),
    
    -- 超梦偏好洞穴和山地
    ('mewtwo', 'cave', 1, 1.15, 1.10, 1.5, true),
    ('mewtwo', 'mountain', 2, 1.15, 1.05, 1.2, false),
    
    -- 快龙偏好水域和海岸
    ('dragonite', 'water', 1, 1.15, 1.15, 1.8, true),
    ('dragonite', 'coastal', 2, 1.15, 1.10, 1.5, false),
    
    -- 班吉拉斯偏好山地和洞穴
    ('tyranitar', 'mountain', 1, 1.20, 1.15, 1.8, true),
    ('tyranitar', 'cave', 2, 1.15, 1.10, 1.5, false),
    
    -- 暴鲤龙偏好水域和海岸
    ('gyarados', 'water', 1, 1.20, 1.15, 2.5, true),
    ('gyarados', 'coastal', 2, 1.15, 1.10, 1.8, false),
    
    -- 喷火龙偏好火山和山地
    ('charizard', 'volcanic', 1, 1.20, 1.15, 2.0, true),
    ('charizard', 'mountain', 2, 1.15, 1.10, 1.5, false)
    ON CONFLICT (species_id, habitat_id) DO NOTHING
  `);

  // 7. 创建索引
  await query(`CREATE INDEX IF NOT EXISTS idx_pokemon_habitat_species ON pokemon_habitat_preferences(species_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_pokemon_habitat_habitat ON pokemon_habitat_preferences(habitat_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_habitat_areas_habitat ON habitat_areas(habitat_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_habitat_areas_location ON habitat_areas USING GIST(geometry)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_user_habitat_user ON user_habitat_cache(user_id)`);

  console.log('Habitat system tables created successfully');
}

async function down() {
  console.log('Dropping habitat system tables...');

  await query(`DROP INDEX IF EXISTS idx_user_habitat_user`);
  await query(`DROP INDEX IF EXISTS idx_habitat_areas_location`);
  await query(`DROP INDEX IF EXISTS idx_habitat_areas_habitat`);
  await query(`DROP INDEX IF EXISTS idx_pokemon_habitat_habitat`);
  await query(`DROP INDEX IF EXISTS idx_pokemon_habitat_species`);

  await query(`DROP TABLE IF EXISTS user_habitat_cache`);
  await query(`DROP TABLE IF EXISTS habitat_areas`);
  await query(`DROP TABLE IF EXISTS pokemon_habitat_preferences`);
  await query(`DROP TABLE IF EXISTS habitats`);

  console.log('Habitat system tables dropped successfully');
}

module.exports = { up, down };