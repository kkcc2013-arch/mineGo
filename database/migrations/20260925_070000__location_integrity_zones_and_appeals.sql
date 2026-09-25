-- migrate:up
-- REQ-00586 补全：地形校验（水域/禁入区域）与反作弊申诉
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1) 地形/禁入区域：位置落在水域等区域时作为可疑信号（降低可信度，不直接阻断——桥梁、渡轮、观景平台上的真实玩家也会落在水面上）
CREATE TABLE IF NOT EXISTS geo_restricted_zones (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  kind        VARCHAR(20)  NOT NULL CHECK (kind IN ('water', 'restricted')),
  area        GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL,
  source      VARCHAR(200),                    -- 数据来源（人工录入/OSM 导入等）
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name)
);
CREATE INDEX IF NOT EXISTS idx_geo_restricted_zones_area ON geo_restricted_zones USING GIST (area);

-- 初始数据：上海周边的大型水域（粗略多边形，远离岸线与航道桥梁；更精细的数据可通过管理接口导入 GeoJSON）
INSERT INTO geo_restricted_zones (name, kind, area, source) VALUES
  ('东海（长江口外海域）', 'water',
   ST_GeogFromText('MULTIPOLYGON(((122.30 30.60, 123.50 30.60, 123.50 31.90, 122.30 31.90, 122.30 30.60)))'), 'manual:coarse'),
  ('太湖（湖心区）', 'water',
   ST_GeogFromText('MULTIPOLYGON(((120.05 31.05, 120.40 30.98, 120.45 31.25, 120.30 31.40, 120.10 31.30, 120.05 31.05)))'), 'manual:coarse'),
  ('淀山湖（湖心区）', 'water',
   ST_GeogFromText('MULTIPOLYGON(((120.92 31.09, 121.00 31.09, 121.01 31.14, 120.95 31.16, 120.92 31.12, 120.92 31.09)))'), 'manual:coarse')
ON CONFLICT (name) DO NOTHING;

-- 2) 申诉：被风控降低可信度/限制功能的玩家可提交申诉，管理员审核通过后恢复可信度
CREATE TABLE IF NOT EXISTS location_appeals (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                 VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reason                 TEXT NOT NULL,
  evidence               JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 玩家补充信息（设备、场景说明等）
  trust_score_at_submit  INTEGER,
  incidents_snapshot     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- 提交时最近的风控记录（供审核）
  reviewed_by            UUID REFERENCES users(id),
  review_note            TEXT,
  trust_score_after      INTEGER,
  reviewed_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_location_appeals_pending ON location_appeals (user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_location_appeals_status ON location_appeals (status, created_at);

-- migrate:down
DROP TABLE IF EXISTS location_appeals;
DROP TABLE IF EXISTS geo_restricted_zones;
