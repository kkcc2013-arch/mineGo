// ecosystem.config.js  — PM2 process manager configuration
// Usage:
//   pm2 start ecosystem.config.js        # start all
//   pm2 reload ecosystem.config.js       # zero-downtime reload
//   pm2 stop all                         # stop all
//   pm2 logs                             # view all logs
//   pm2 monit                            # live monitor
//   pm2 save && pm2 startup              # auto-start on reboot

const fs   = require('fs');
const path = require('path');

// 部署目录默认取本文件所在目录（生产机为 /data/mineGo），可用 DEPLOY_DIR 覆盖
const DEPLOY_DIR = process.env.DEPLOY_DIR || __dirname;
const BACKEND    = `${DEPLOY_DIR}/backend`;

// ── 从 .env 读取配置（密钥绝不写进仓库）──────────────────────
// 优先级：进程环境变量 > .env 文件 > 下方非敏感默认值
function loadDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const fileEnv = loadDotEnv(process.env.ENV_FILE || path.join(DEPLOY_DIR, '.env'));
const env = (key, fallback) => process.env[key] ?? fileEnv[key] ?? fallback;

const REQUIRED = ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
const missing = REQUIRED.filter((k) => !env(k));
if (missing.length) {
  throw new Error(`[ecosystem] 缺少必需配置 ${missing.join(', ')}：请参考 .env.example 创建 ${path.join(DEPLOY_DIR, '.env')}`);
}

const PG_HOST = env('POSTGRES_HOST', '127.0.0.1');
const PG_PORT = env('POSTGRES_PORT', '5432');
const PG_DB   = env('POSTGRES_DB', 'pmg');
const PG_USER = env('POSTGRES_USER', 'pmg_user');
const PG_PASS = env('POSTGRES_PASSWORD');
const REDIS_HOST = env('REDIS_HOST', '127.0.0.1');
const REDIS_PORT = env('REDIS_PORT', '6379');
const REDIS_PASS = env('REDIS_PASSWORD');

// Shared env for every service
const commonEnv = {
  NODE_ENV: env('NODE_ENV', 'production'),
  POSTGRES_DB: PG_DB,
  POSTGRES_USER: PG_USER,
  POSTGRES_PASSWORD: PG_PASS,
  DATABASE_URL: env('DATABASE_URL', `postgres://${PG_USER}:${encodeURIComponent(PG_PASS)}@${PG_HOST}:${PG_PORT}/${PG_DB}`),
  DB_POOL_MAX: env('DB_POOL_MAX', '20'),
  DB_SSL: env('DB_SSL', 'false'),
  REDIS_HOST,
  REDIS_PORT,
  REDIS_PASSWORD: REDIS_PASS,
  REDIS_URL: env('REDIS_URL', `redis://:${encodeURIComponent(REDIS_PASS)}@${REDIS_HOST}:${REDIS_PORT}/0`),
  JWT_ACCESS_SECRET: env('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: env('JWT_REFRESH_SECRET'),
  JWT_SECRET: env('JWT_SECRET', env('JWT_ACCESS_SECRET')), // 道馆战斗 WebSocket 使用
  JWT_ACCESS_TTL: env('JWT_ACCESS_TTL', '24h'),
  JWT_REFRESH_TTL: env('JWT_REFRESH_TTL', '30d'),
  GATEWAY_PORT: env('GATEWAY_PORT', env('PORT_BASE', '8080')),
  ADMIN_PORT: env('ADMIN_PORT', '3000'),
  EVENT_BUS_ADAPTER: env('EVENT_BUS_ADAPTER', 'redis'),
  TRUST_PROXY: env('TRUST_PROXY', 'loopback'),
  FIELD_ENCRYPTION_KEYS: env('FIELD_ENCRYPTION_KEYS', ''),
  FIELD_ENCRYPTION_ACTIVE_KID: env('FIELD_ENCRYPTION_ACTIVE_KID', ''),
  FIELD_HASH_KEY: env('FIELD_HASH_KEY', ''),
  // SMS_DEV_MODE 仅在非 production 下生效（见 user-service/src/routes/auth.js）
  SMS_DEV_MODE: env('SMS_DEV_MODE', 'false'),
};

// 支付渠道密钥：未配置的渠道在 production 下被禁用
const paymentEnv = {
  WECHAT_SECRET: env('WECHAT_SECRET', ''),
  ALIPAY_SECRET: env('ALIPAY_SECRET', ''),
  APPLE_SHARED_SECRET: env('APPLE_SHARED_SECRET', ''),
};
for (const k of Object.keys(paymentEnv)) if (!paymentEnv[k]) delete paymentEnv[k];

const LOG_DIR = env('LOG_DIR', `${DEPLOY_DIR}/logs`);
const instances = (key, def) => Number(env(key, def));

// 端口与进程名可整体平移，便于在同一台机器上并行运行预发/CI 栈（默认与生产一致）
const PORT_BASE = Number(env('PORT_BASE', '8080'));
const NAME_PREFIX = env('PM2_NAME_PREFIX', 'pmg-');
const port = (offset) => String(PORT_BASE + offset);
const serviceUrls = {
  USER_SERVICE_URL:     `http://localhost:${port(1)}`,
  LOCATION_SERVICE_URL: `http://localhost:${port(2)}`,
  POKEMON_SERVICE_URL:  `http://localhost:${port(3)}`,
  CATCH_SERVICE_URL:    `http://localhost:${port(4)}`,
  GYM_SERVICE_URL:      `http://localhost:${port(5)}`,
  SOCIAL_SERVICE_URL:   `http://localhost:${port(6)}`,
  REWARD_SERVICE_URL:   `http://localhost:${port(7)}`,
  PAYMENT_SERVICE_URL:  `http://localhost:${port(8)}`,
  GYM_BATTLE_WS_URL:    `http://localhost:${port(9)}`, // gym-service 实时对战 WebSocket（网关 /ws/battle 转发）
};
Object.assign(commonEnv, serviceUrls);

module.exports = {
  apps: [

    // ── API Gateway ────────────────────────────────────────
    {
      name:        `${NAME_PREFIX}gateway`,
      script:      `${BACKEND}/gateway/src/index.js`,
      cwd:         `${BACKEND}/gateway`,
      instances:   instances('GATEWAY_INSTANCES', 2), // load balanced
      exec_mode:   'cluster',
      env:         { ...commonEnv, PORT: port(0) },
      error_file:  `${LOG_DIR}/gateway-error.log`,
      out_file:    `${LOG_DIR}/gateway-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
      listen_timeout: 15000,
    },

    // ── User Service ───────────────────────────────────────
    {
      name:        `${NAME_PREFIX}user`,
      script:      `${BACKEND}/services/user-service/src/index.js`,
      cwd:         `${BACKEND}/services/user-service`,
      instances:   1,
      env:         { ...commonEnv, PORT: port(1) },
      error_file:  `${LOG_DIR}/user-error.log`,
      out_file:    `${LOG_DIR}/user-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Location Service ────────────────────────────────────
    {
      name:        `${NAME_PREFIX}location`,
      script:      `${BACKEND}/services/location-service/src/index.js`,
      cwd:         `${BACKEND}/services/location-service`,
      instances:   instances('LOCATION_INSTANCES', 2),
      exec_mode:   'cluster',
      env:         { ...commonEnv, PORT: port(2) },
      error_file:  `${LOG_DIR}/location-error.log`,
      out_file:    `${LOG_DIR}/location-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Pokemon Service ─────────────────────────────────────
    {
      name:        `${NAME_PREFIX}pokemon`,
      script:      `${BACKEND}/services/pokemon-service/src/index.js`,
      cwd:         `${BACKEND}/services/pokemon-service`,
      instances:   1,
      env:         { ...commonEnv, PORT: port(3) },
      error_file:  `${LOG_DIR}/pokemon-error.log`,
      out_file:    `${LOG_DIR}/pokemon-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Catch Service ───────────────────────────────────────
    {
      name:        `${NAME_PREFIX}catch`,
      script:      `${BACKEND}/services/catch-service/src/index.js`,
      cwd:         `${BACKEND}/services/catch-service`,
      instances:   instances('CATCH_INSTANCES', 2),
      exec_mode:   'cluster',
      env:         { ...commonEnv, PORT: port(4) },
      error_file:  `${LOG_DIR}/catch-error.log`,
      out_file:    `${LOG_DIR}/catch-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Gym Service ─────────────────────────────────────────
    {
      name:        `${NAME_PREFIX}gym`,
      script:      `${BACKEND}/services/gym-service/src/index.js`,
      cwd:         `${BACKEND}/services/gym-service`,
      instances:   1,                    // WebSocket — single instance
      env:         { ...commonEnv, PORT: port(5), WS_BATTLE_PORT: env('WS_BATTLE_PORT', port(9)) }, // 8086 与 social-service 冲突
      error_file:  `${LOG_DIR}/gym-error.log`,
      out_file:    `${LOG_DIR}/gym-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Social Service ──────────────────────────────────────
    {
      name:        `${NAME_PREFIX}social`,
      script:      `${BACKEND}/services/social-service/src/index.js`,
      cwd:         `${BACKEND}/services/social-service`,
      instances:   1,
      env:         { ...commonEnv, PORT: port(6) },
      error_file:  `${LOG_DIR}/social-error.log`,
      out_file:    `${LOG_DIR}/social-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Reward Service ──────────────────────────────────────
    {
      name:        `${NAME_PREFIX}reward`,
      script:      `${BACKEND}/services/reward-service/src/index.js`,
      cwd:         `${BACKEND}/services/reward-service`,
      instances:   1,
      env:         { ...commonEnv, PORT: port(7) },
      error_file:  `${LOG_DIR}/reward-error.log`,
      out_file:    `${LOG_DIR}/reward-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Payment Service ─────────────────────────────────────
    {
      name:        `${NAME_PREFIX}payment`,
      script:      `${BACKEND}/services/payment-service/src/index.js`,
      cwd:         `${BACKEND}/services/payment-service`,
      instances:   1,
      env:         { ...commonEnv, ...paymentEnv, PORT: port(8) },
      error_file:  `${LOG_DIR}/payment-error.log`,
      out_file:    `${LOG_DIR}/payment-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

  ],

  // ── PM2 Deploy config (alternative to GitHub Actions) ────
  deploy: {
    production: {
      user:         'root',
      host:         '81.68.170.192',
      port:         '17002',
      ref:          'origin/main',
      repo:         'https://github.com/kkcc2013-arch/mineGo.git',
      path:         '/data/mineGo',
      'pre-deploy': 'git fetch --all',
      'post-deploy': [
        'cd backend',
        'npm install --workspaces --omit=dev',
        'cd ..',
        'test -f .env || { echo "missing .env (see .env.example)"; exit 1; }',
        'pm2 reload ecosystem.config.js --env production',
        'pm2 save',
      ].join(' && '),
      env: { NODE_ENV: 'production' },
    },
  },
};
