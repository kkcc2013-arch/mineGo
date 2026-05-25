-- ============================================================
-- Pocket Monster Go - Initial Schema v1
-- PostgreSQL 15 + PostGIS
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE team_enum AS ENUM ('VALOR', 'MYSTIC', 'INSTINCT');
CREATE TYPE rarity_enum AS ENUM ('COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY');
CREATE TYPE ball_type_enum AS ENUM ('POKE_BALL', 'GREAT_BALL', 'ULTRA_BALL', 'MASTER_BALL');
CREATE TYPE throw_rating_enum AS ENUM ('MISS', 'NICE', 'GREAT', 'EXCELLENT');
CREATE TYPE catch_result_enum AS ENUM ('CAUGHT', 'FLED', 'BALL_USED');
CREATE TYPE gym_battle_result_enum AS ENUM ('WIN', 'LOSE', 'DRAW');
CREATE TYPE raid_status_enum AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'EXPIRED');
CREATE TYPE order_status_enum AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');
CREATE TYPE friendship_level_enum AS ENUM ('GOOD', 'GREAT', 'ULTRA', 'BEST');
CREATE TYPE pokemon_type_enum AS ENUM (
  'NORMAL','FIRE','WATER','ELECTRIC','GRASS','ICE',
  'FIGHTING','POISON','GROUND','FLYING','PSYCHIC',
  'BUG','ROCK','GHOST','DRAGON','DARK','STEEL','FAIRY'
);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone           VARCHAR(20) UNIQUE,
  phone_hash      VARCHAR(64) UNIQUE,          -- bcrypt hash for privacy
  nickname        VARCHAR(30) UNIQUE NOT NULL,
  avatar_url      VARCHAR(500),
  team            team_enum,
  team_changed_at TIMESTAMP,
  level           SMALLINT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 50),
  xp              BIGINT NOT NULL DEFAULT 0 CHECK (xp >= 0),
  stardust        INTEGER NOT NULL DEFAULT 500 CHECK (stardust >= 0),
  coins           INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
  premium_coins   INTEGER NOT NULL DEFAULT 0 CHECK (premium_coins >= 0),
  pokeball_count  INTEGER NOT NULL DEFAULT 50,
  greatball_count INTEGER NOT NULL DEFAULT 0,
  ultraball_count INTEGER NOT NULL DEFAULT 0,
  masterball_count INTEGER NOT NULL DEFAULT 0,
  is_banned       BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason      TEXT,
  last_login_at   TIMESTAMP,
  last_lat        DECIMAL(9,6),
  last_lng        DECIMAL(9,6),
  total_distance_km DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_nickname ON users(nickname);
CREATE INDEX idx_users_level ON users(level);
CREATE INDEX idx_users_team ON users(team);

-- ============================================================
-- POKEMON SPECIES (master data)
-- ============================================================
CREATE TABLE pokemon_species (
  id                  SMALLINT PRIMARY KEY,       -- 1-151 etc.
  name_zh             VARCHAR(50) NOT NULL,
  name_en             VARCHAR(50) NOT NULL,
  type1               pokemon_type_enum NOT NULL,
  type2               pokemon_type_enum,
  rarity              rarity_enum NOT NULL DEFAULT 'COMMON',
  base_attack         SMALLINT NOT NULL,
  base_defense        SMALLINT NOT NULL,
  base_hp             SMALLINT NOT NULL,
  base_catch_rate     DECIMAL(5,4) NOT NULL DEFAULT 0.20,  -- 0~1
  base_flee_rate      DECIMAL(5,4) NOT NULL DEFAULT 0.10,
  candy_to_evolve     SMALLINT,
  evolves_to          SMALLINT REFERENCES pokemon_species(id),
  evolves_with_item   VARCHAR(50),                -- e.g. 'SUN_STONE'
  evolution_level     SMALLINT,
  biomes              TEXT[],                      -- ['WATER','URBAN']
  sprite_url          VARCHAR(500),
  sprite_shiny_url    VARCHAR(500),
  description_zh      TEXT,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_species_rarity ON pokemon_species(rarity);
CREATE INDEX idx_species_type1 ON pokemon_species(type1);

-- ============================================================
-- POKEMON INSTANCES (player's caught pokemon)
-- ============================================================
CREATE TABLE pokemon_instances (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id      SMALLINT NOT NULL REFERENCES pokemon_species(id),
  nickname        VARCHAR(30),                    -- player-given nickname
  cp              INTEGER NOT NULL CHECK (cp > 0),
  hp_current      INTEGER NOT NULL,
  hp_max          INTEGER NOT NULL,
  iv_attack       SMALLINT NOT NULL CHECK (iv_attack BETWEEN 0 AND 15),
  iv_defense      SMALLINT NOT NULL CHECK (iv_defense BETWEEN 0 AND 15),
  iv_hp           SMALLINT NOT NULL CHECK (iv_hp BETWEEN 0 AND 15),
  is_shiny        BOOLEAN NOT NULL DEFAULT FALSE,
  is_lucky        BOOLEAN NOT NULL DEFAULT FALSE,
  is_favorite     BOOLEAN NOT NULL DEFAULT FALSE,
  power_up_count  SMALLINT NOT NULL DEFAULT 0,
  fast_move       VARCHAR(50),
  charge_move     VARCHAR(50),
  caught_lat      DECIMAL(9,6),
  caught_lng      DECIMAL(9,6),
  caught_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  defending_gym_id UUID,                          -- FK added after gyms table
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_instances_user ON pokemon_instances(user_id);
CREATE INDEX idx_instances_species ON pokemon_instances(species_id);
CREATE INDEX idx_instances_cp ON pokemon_instances(cp DESC);
CREATE INDEX idx_instances_shiny ON pokemon_instances(is_shiny) WHERE is_shiny = TRUE;

-- ============================================================
-- CANDY INVENTORY
-- ============================================================
CREATE TABLE candy_inventory (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id  SMALLINT NOT NULL REFERENCES pokemon_species(id),
  amount      INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, species_id)
);

-- ============================================================
-- POKEDEX (which species user has seen/caught)
-- ============================================================
CREATE TABLE pokedex_entries (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id    SMALLINT NOT NULL REFERENCES pokemon_species(id),
  seen_count    INTEGER NOT NULL DEFAULT 1,
  caught_count  INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  first_caught_at TIMESTAMP,
  best_cp       INTEGER,
  has_shiny     BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, species_id)
);

-- ============================================================
-- SPAWN POINTS (geographic, master data)
-- ============================================================
CREATE TABLE spawn_points (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location    GEOGRAPHY(POINT, 4326) NOT NULL,
  lat         DECIMAL(9,6) NOT NULL,
  lng         DECIMAL(9,6) NOT NULL,
  biome       VARCHAR(30) NOT NULL DEFAULT 'URBAN',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  spawn_tier  SMALLINT NOT NULL DEFAULT 1 CHECK (spawn_tier BETWEEN 1 AND 3),
  last_spawn_at TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_spawn_location ON spawn_points USING GIST(location);
CREATE INDEX idx_spawn_active ON spawn_points(is_active);

-- ============================================================
-- WILD POKEMON (currently live on the map)
-- ============================================================
CREATE TABLE wild_pokemon (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  spawn_point_id  UUID REFERENCES spawn_points(id),
  species_id      SMALLINT NOT NULL REFERENCES pokemon_species(id),
  lat             DECIMAL(9,6) NOT NULL,
  lng             DECIMAL(9,6) NOT NULL,
  location        GEOGRAPHY(POINT, 4326) NOT NULL,
  cp              INTEGER NOT NULL,
  iv_attack       SMALLINT NOT NULL,
  iv_defense      SMALLINT NOT NULL,
  iv_hp           SMALLINT NOT NULL,
  is_shiny        BOOLEAN NOT NULL DEFAULT FALSE,
  weather_boosted BOOLEAN NOT NULL DEFAULT FALSE,
  spawned_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMP NOT NULL,
  is_caught       BOOLEAN NOT NULL DEFAULT FALSE,
  caught_by       UUID REFERENCES users(id)
);

CREATE INDEX idx_wild_location ON wild_pokemon USING GIST(location);
CREATE INDEX idx_wild_expires ON wild_pokemon(expires_at);
CREATE INDEX idx_wild_active ON wild_pokemon(is_caught, expires_at);

-- ============================================================
-- CATCH SESSIONS & HISTORY
-- ============================================================
CREATE TABLE catch_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  wild_pokemon_id UUID NOT NULL REFERENCES wild_pokemon(id),
  started_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMP,
  result          catch_result_enum,
  balls_used      SMALLINT NOT NULL DEFAULT 0,
  instance_id     UUID REFERENCES pokemon_instances(id),  -- set on success
  xp_earned       INTEGER NOT NULL DEFAULT 0,
  stardust_earned INTEGER NOT NULL DEFAULT 0,
  candy_earned    SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_catch_user ON catch_sessions(user_id);
CREATE INDEX idx_catch_result ON catch_sessions(result);

CREATE TABLE catch_throws (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      UUID NOT NULL REFERENCES catch_sessions(id),
  ball_type       ball_type_enum NOT NULL,
  throw_rating    throw_rating_enum NOT NULL,
  is_curve        BOOLEAN NOT NULL DEFAULT FALSE,
  berry_used      VARCHAR(30),
  catch_prob      DECIMAL(5,4) NOT NULL,
  success         BOOLEAN NOT NULL,
  thrown_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================
-- POKESTOPS
-- ============================================================
CREATE TABLE pokestops (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  lat             DECIMAL(9,6) NOT NULL,
  lng             DECIMAL(9,6) NOT NULL,
  location        GEOGRAPHY(POINT, 4326) NOT NULL,
  image_url       VARCHAR(500),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pokestops_location ON pokestops USING GIST(location);

CREATE TABLE pokestop_spins (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id),
  pokestop_id     UUID NOT NULL REFERENCES pokestops(id),
  spun_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  items_received  JSONB NOT NULL DEFAULT '[]',
  streak_day      SMALLINT NOT NULL DEFAULT 1
);

CREATE INDEX idx_spins_user_stop ON pokestop_spins(user_id, pokestop_id);

-- ============================================================
-- GYMS
-- ============================================================
CREATE TABLE gyms (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(100) NOT NULL,
  lat             DECIMAL(9,6) NOT NULL,
  lng             DECIMAL(9,6) NOT NULL,
  location        GEOGRAPHY(POINT, 4326) NOT NULL,
  image_url       VARCHAR(500),
  controlling_team team_enum,
  prestige        INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gyms_location ON gyms USING GIST(location);
CREATE INDEX idx_gyms_team ON gyms(controlling_team);

CREATE TABLE gym_defenders (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id          UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  pokemon_id      UUID NOT NULL REFERENCES pokemon_instances(id),
  hp_current      INTEGER NOT NULL,
  hp_max          INTEGER NOT NULL,
  assigned_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  last_fed_at     TIMESTAMP,
  coins_earned    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (gym_id, user_id)
);

CREATE INDEX idx_defenders_gym ON gym_defenders(gym_id);
CREATE INDEX idx_defenders_user ON gym_defenders(user_id);

-- Add FK back to pokemon_instances
ALTER TABLE pokemon_instances
  ADD CONSTRAINT fk_defending_gym
  FOREIGN KEY (defending_gym_id) REFERENCES gyms(id);

CREATE TABLE gym_battles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id          UUID NOT NULL REFERENCES gyms(id),
  attacker_id     UUID NOT NULL REFERENCES users(id),
  defender_team   team_enum NOT NULL,
  attacker_team   team_enum NOT NULL,
  result          gym_battle_result_enum NOT NULL,
  damage_dealt    INTEGER NOT NULL DEFAULT 0,
  duration_sec    INTEGER,
  battled_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================
-- RAIDS
-- ============================================================
CREATE TABLE raids (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id          UUID NOT NULL REFERENCES gyms(id),
  boss_species_id SMALLINT NOT NULL REFERENCES pokemon_species(id),
  boss_cp         INTEGER NOT NULL,
  boss_hp_max     INTEGER NOT NULL,
  boss_hp_current INTEGER NOT NULL,
  raid_level      SMALLINT NOT NULL CHECK (raid_level BETWEEN 1 AND 5),
  status          raid_status_enum NOT NULL DEFAULT 'PENDING',
  starts_at       TIMESTAMP NOT NULL,
  ends_at         TIMESTAMP NOT NULL,
  max_participants SMALLINT NOT NULL DEFAULT 20,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_raids_gym ON raids(gym_id);
CREATE INDEX idx_raids_status ON raids(status);
CREATE INDEX idx_raids_time ON raids(starts_at, ends_at);

CREATE TABLE raid_participants (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  raid_id     UUID NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  joined_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  damage_dealt INTEGER NOT NULL DEFAULT 0,
  balls_given SMALLINT NOT NULL DEFAULT 6,
  caught_boss BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (raid_id, user_id)
);

-- ============================================================
-- FRIENDSHIPS
-- ============================================================
CREATE TABLE friendships (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_a          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level           friendship_level_enum NOT NULL DEFAULT 'GOOD',
  interaction_days INTEGER NOT NULL DEFAULT 1,
  last_interaction_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_a, user_b),
  CHECK (user_a < user_b)  -- enforce canonical order
);

CREATE INDEX idx_friends_a ON friendships(user_a);
CREATE INDEX idx_friends_b ON friendships(user_b);

CREATE TABLE friend_gifts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id       UUID NOT NULL REFERENCES users(id),
  receiver_id     UUID NOT NULL REFERENCES users(id),
  pokestop_id     UUID REFERENCES pokestops(id),
  postcard_url    VARCHAR(500),
  items           JSONB NOT NULL DEFAULT '[]',
  opened          BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  opened_at       TIMESTAMP
);

CREATE INDEX idx_gifts_receiver ON friend_gifts(receiver_id, opened);

-- ============================================================
-- POKEMON TRADES
-- ============================================================
CREATE TABLE pokemon_trades (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  initiator_id    UUID NOT NULL REFERENCES users(id),
  receiver_id     UUID NOT NULL REFERENCES users(id),
  offered_pokemon UUID NOT NULL REFERENCES pokemon_instances(id),
  received_pokemon UUID REFERENCES pokemon_instances(id),
  stardust_cost   INTEGER NOT NULL DEFAULT 0,
  is_remote       BOOLEAN NOT NULL DEFAULT FALSE,
  is_lucky        BOOLEAN NOT NULL DEFAULT FALSE,
  status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  traded_at       TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ACHIEVEMENTS & BADGES
-- ============================================================
CREATE TABLE achievement_definitions (
  id          VARCHAR(50) PRIMARY KEY,
  name_zh     VARCHAR(100) NOT NULL,
  description_zh TEXT,
  category    VARCHAR(30) NOT NULL,
  tiers       JSONB NOT NULL DEFAULT '[]', -- [{tier:1, target:10, badge_url:"..."}, ...]
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE user_achievements (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id  VARCHAR(50) NOT NULL REFERENCES achievement_definitions(id),
  current_value   INTEGER NOT NULL DEFAULT 0,
  current_tier    SMALLINT NOT NULL DEFAULT 0,
  unlocked_at     TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, achievement_id)
);

-- ============================================================
-- DAILY QUESTS
-- ============================================================
CREATE TABLE daily_quests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  catch_target    SMALLINT NOT NULL DEFAULT 5,
  catch_current   SMALLINT NOT NULL DEFAULT 0,
  spin_target     SMALLINT NOT NULL DEFAULT 3,
  spin_current    SMALLINT NOT NULL DEFAULT 0,
  walk_target_km  DECIMAL(4,1) NOT NULL DEFAULT 2.0,
  walk_current_km DECIMAL(4,1) NOT NULL DEFAULT 0,
  completed       BOOLEAN NOT NULL DEFAULT FALSE,
  reward_claimed  BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at    TIMESTAMP,
  UNIQUE (user_id, quest_date)
);

CREATE INDEX idx_quests_user_date ON daily_quests(user_id, quest_date);

-- ============================================================
-- PAYMENTS & ORDERS
-- ============================================================
CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id),
  idempotency_key     VARCHAR(100) UNIQUE NOT NULL,
  product_id          VARCHAR(50) NOT NULL,
  product_name        VARCHAR(100) NOT NULL,
  amount_fen          INTEGER NOT NULL CHECK (amount_fen > 0), -- 分
  currency            VARCHAR(10) NOT NULL DEFAULT 'CNY',
  premium_coins_grant INTEGER NOT NULL DEFAULT 0,
  status              order_status_enum NOT NULL DEFAULT 'PENDING',
  payment_channel     VARCHAR(20),   -- 'WECHAT' | 'ALIPAY'
  channel_order_id    VARCHAR(200),  -- 第三方订单号
  paid_at             TIMESTAMP,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_idempotency ON orders(idempotency_key);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id   VARCHAR(100),
  ip_addr     INET,
  user_agent  TEXT,
  details     JSONB,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_audit_time ON audit_logs(created_at);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_instances_updated BEFORE UPDATE ON pokemon_instances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_gyms_updated BEFORE UPDATE ON gyms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_raids_updated BEFORE UPDATE ON raids
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
