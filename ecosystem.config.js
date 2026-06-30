// ecosystem.config.js  — PM2 process manager configuration
// Usage:
//   pm2 start ecosystem.config.js        # start all
//   pm2 reload ecosystem.config.js       # zero-downtime reload
//   pm2 stop all                         # stop all
//   pm2 logs                             # view all logs
//   pm2 monit                            # live monitor
//   pm2 save && pm2 startup              # auto-start on reboot

const DEPLOY_DIR = process.env.DEPLOY_DIR || '/data/mineGo';
const BACKEND    = `${DEPLOY_DIR}/backend`;

// Shared env loaded from .env file
const commonEnv = {
  NODE_ENV: "production",
  POSTGRES_DB: "pmg",
  POSTGRES_USER: "pmg_user",
  POSTGRES_PASSWORD: "pmg1779688057bea7559741c5306f",
  DATABASE_URL: "postgres://pmg_user:pmg1779688057bea7559741c5306f@127.0.0.1:5432/pmg",
  DB_POOL_MAX: "20",
  DB_SSL: "false",
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: "6379",
  REDIS_PASSWORD: "3f7544dc9725e512eceb",
  JWT_ACCESS_SECRET: "1f340b5b6d76e2c0216a3e188c9a349ef2ce45f0097b2208b5d70988f3d2b564",
  JWT_REFRESH_SECRET: "68bb1b248bcdb7fc8a34a4e262d4fa36ec46963de3c9de19944951dc327b6d2d",
  JWT_ACCESS_TTL: "24h",
  JWT_REFRESH_TTL: "30d",
  GATEWAY_PORT: "8080",
  ADMIN_PORT: "3000",
  SMS_DEV_MODE: "true",
  EVENT_BUS_ADAPTER: "redis",
  REDIS_URL: "redis://:3f7544dc9725e512eceb@127.0.0.1:6379/0",
};

module.exports = {
  apps: [

    // ── API Gateway ────────────────────────────────────────
    {
      name:        'pmg-gateway',
      script:      `${BACKEND}/gateway/src/index.js`,
      cwd:         `${BACKEND}/gateway`,
      instances:   2,                    // 2 processes, load balanced
      exec_mode:   'cluster',
            env:         { ...commonEnv, PORT: '8080' },
      error_file:  `${DEPLOY_DIR}/logs/gateway-error.log`,
      out_file:    `${DEPLOY_DIR}/logs/gateway-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
      listen_timeout: 15000,
    },

    // ── User Service ───────────────────────────────────────
    {
      name:        'pmg-user',
      script:      `${BACKEND}/services/user-service/src/index.js`,
      cwd:         `${BACKEND}/services/user-service`,
      instances:   1,
            env:         { ...commonEnv, PORT: '8081' },
      error_file:  `${DEPLOY_DIR}/logs/user-error.log`,
      out_file:    `${DEPLOY_DIR}/logs/user-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Location Service ────────────────────────────────────
    {
      name:        'pmg-location',
      script:      `${BACKEND}/services/location-service/src/index.js`,
      cwd:         `${BACKEND}/services/location-service`,
      instances:   2,
      exec_mode:   'cluster',
            env:         { ...commonEnv, PORT: '8082' },
      error_file:  `${DEPLOY_DIR}/logs/location-error.log`,
      out_file:    `${DEPLOY_DIR}/logs/location-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Pokemon Service ─────────────────────────────────────
    {
      name:        'pmg-pokemon',
      script:      `${BACKEND}/services/pokemon-service/src/index.js`,
      cwd:         `${BACKEND}/services/pokemon-service`,
      instances:   1,
            env:         { ...commonEnv, PORT: '8083' },
      error_file:  `${DEPLOY_DIR}/logs/pokemon-error.log`,
      out_file:    `${DEPLOY_DIR}/logs/pokemon-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Catch Service ───────────────────────────────────────
    {
      name:        'pmg-catch',
      script:      `${BACKEND}/services/catch-service/src/index.js`,
      cwd:         `${BACKEND}/services/catch-service`,
      instances:   2,
      exec_mode:   'cluster',
            env:         { ...commonEnv, PORT: '8084' },
      error_file:  `${DEPLOY_DIR}/logs/catch-error.log`,
      out_file:    `${DEPLOY_DIR}/logs/catch-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Gym Service ─────────────────────────────────────────
    {
      name:        'pmg-gym',
      script:      `${BACKEND}/services/gym-service/src/index.js`,
      cwd:         `${BACKEND}/services/gym-service`,
      instances:   1,                    // WebSocket — single instance
            env:         { ...commonEnv, PORT: '8085' },
      error_file:  `${DEPLOY_DIR}/logs/gym-error.log`,
      out_file:    `${DEPLOY_DIR}/logs/gym-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Social Service ──────────────────────────────────────
    {
      name:        'pmg-social',
      script:      `${BACKEND}/services/social-service/src/index.js`,
      cwd:         `${BACKEND}/services/social-service`,
      instances:   1,
            env:         { ...commonEnv, PORT: '8086' },
      error_file:  `${DEPLOY_DIR}/logs/social-error.log`,
      out_file:    `${DEPLOY_DIR}/logs/social-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Reward Service ──────────────────────────────────────
    {
      name:        'pmg-reward',
      script:      `${BACKEND}/services/reward-service/src/index.js`,
      cwd:         `${BACKEND}/services/reward-service`,
      instances:   1,
            env:         { ...commonEnv, PORT: '8087' },
      error_file:  `${DEPLOY_DIR}/logs/reward-error.log`,
      out_file:    `${DEPLOY_DIR}/logs/reward-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
    },

    // ── Payment Service ─────────────────────────────────────
    {
      name:        'pmg-payment',
      script:      `${BACKEND}/services/payment-service/src/index.js`,
      cwd:         `${BACKEND}/services/payment-service`,
      instances:   1,
            env:         { ...commonEnv, PORT: '8088' },
      error_file:  `${DEPLOY_DIR}/logs/payment-error.log`,
      out_file:    `${DEPLOY_DIR}/logs/payment-out.log`,
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
        'cp .env.example .env 2>/dev/null || true',
        'pm2 reload ecosystem.config.js --env production',
        'pm2 save',
      ].join(' && '),
      env: { NODE_ENV: 'production' },
    },
  },
};
