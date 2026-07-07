-- 天气增益历史记录表
-- 用于记录天气增益效果的历史数据，支持审计和分析

CREATE TABLE IF NOT EXISTS weather_boost_history (
  id SERIAL PRIMARY KEY,
  location_id INTEGER NOT NULL,
  weather_condition VARCHAR(50) NOT NULL,
  boosted_types TEXT[] NOT NULL,
  spawn_multiplier DECIMAL(3,2) NOT NULL,
  rare_spawn_triggered BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_weather_history_location ON weather_boost_history(location_id);
CREATE INDEX IF NOT EXISTS idx_weather_history_time ON weather_boost_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_weather_history_condition ON weather_boost_history(weather_condition);

-- 天气事件统计表
CREATE TABLE IF NOT EXISTS weather_events_stats (
  id SERIAL PRIMARY KEY,
  weather_type VARCHAR(50) NOT NULL UNIQUE,
  total_occurrences INTEGER DEFAULT 0,
  total_boosted_spawns INTEGER DEFAULT 0,
  avg_spawn_multiplier DECIMAL(4,3) DEFAULT 0.0,
  rare_spawn_trigger_count INTEGER DEFAULT 0,
  last_occurrence TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 初始化天气统计数据
INSERT INTO weather_events_stats (weather_type, total_occurrences, avg_spawn_multiplier) VALUES
('clear', 0, 1.5),
('rain', 0, 1.6),
('cloudy', 0, 1.3),
('windy', 0, 1.4),
('fog', 0, 1.8),
('snow', 0, 1.7),
('thunderstorm', 0, 2.0)
ON CONFLICT (weather_type) DO NOTHING;

-- 天气增益配置表（允许动态调整）
CREATE TABLE IF NOT EXISTS weather_boost_config (
  id SERIAL PRIMARY KEY,
  weather_type VARCHAR(50) NOT NULL UNIQUE,
  boosted_types TEXT[] NOT NULL,
  spawn_multiplier DECIMAL(3,2) NOT NULL DEFAULT 1.0,
  rarity_boost DECIMAL(3,2) DEFAULT 0.0,
  special_event BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 初始化默认配置
INSERT INTO weather_boost_config (weather_type, boosted_types, spawn_multiplier, rarity_boost, special_event) VALUES
('clear', ARRAY['fire', 'grass', 'ground'], 1.5, 0.1, FALSE),
('rain', ARRAY['water', 'electric', 'bug'], 1.6, 0.15, FALSE),
('cloudy', ARRAY['fairy', 'fighting', 'poison'], 1.3, 0.05, FALSE),
('windy', ARRAY['dragon', 'flying', 'psychic'], 1.4, 0.2, FALSE),
('fog', ARRAY['ghost', 'dark'], 1.8, 0.3, TRUE),
('snow', ARRAY['ice', 'steel'], 1.7, 0.25, TRUE),
('thunderstorm', ARRAY['electric', 'water', 'dragon'], 2.0, 0.4, TRUE)
ON CONFLICT (weather_type) DO NOTHING;

-- 用户天气增益偏好表
CREATE TABLE IF NOT EXISTS user_weather_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  enable_weather_boost BOOLEAN DEFAULT TRUE,
  show_weather_notifications BOOLEAN DEFAULT TRUE,
  favorite_weather_types TEXT[] DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id)
);

-- 触发器：自动更新统计表
CREATE OR REPLACE FUNCTION update_weather_stats()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO weather_events_stats (
    weather_type, 
    total_occurrences, 
    total_boosted_spawns,
    avg_spawn_multiplier,
    rare_spawn_trigger_count,
    last_occurrence,
    updated_at
  ) VALUES (
    NEW.weather_condition,
    1,
    array_length(NEW.boosted_types, 1) || 0,
    NEW.spawn_multiplier,
    CASE WHEN NEW.rare_spawn_triggered THEN 1 ELSE 0 END,
    NEW.created_at,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (weather_type) DO UPDATE SET
    total_occurrences = weather_events_stats.total_occurrences + 1,
    total_boosted_spawns = weather_events_stats.total_boosted_spawns + array_length(NEW.boosted_types, 1),
    avg_spawn_multiplier = (weather_events_stats.avg_spawn_multiplier * weather_events_stats.total_occurrences + NEW.spawn_multiplier) / (weather_events_stats.total_occurrences + 1),
    rare_spawn_trigger_count = weather_events_stats.rare_spawn_trigger_count + CASE WHEN NEW.rare_spawn_triggered THEN 1 ELSE 0 END,
    last_occurrence = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_weather_stats
AFTER INSERT ON weather_boost_history
FOR EACH ROW
EXECUTE FUNCTION update_weather_stats();