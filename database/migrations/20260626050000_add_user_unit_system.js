// database/migrations/20260626050000_add_user_unit_system.js
// REQ-00335: 游戏距离单位本地化与智能转换系统
// 为 users 表添加 unit_system 字段
//
// 迁移执行器（database/migrate.js、database/bootstrap-dev.js）以 up(client) 传入 pg client；
// 原文件使用 Sequelize queryInterface，在本项目中无法执行。

'use strict';

module.exports = {
  up: async (client) => {
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS unit_system VARCHAR(10) NOT NULL DEFAULT 'metric';
      COMMENT ON COLUMN users.unit_system IS '用户单位制偏好：metric（公制）或 imperial（英制）';
      CREATE INDEX IF NOT EXISTS idx_users_unit_system ON users(unit_system);
    `);
    // 美国、利比里亚、缅甸使用英制（users 有 country 列时才据此初始化）
    await client.query(`
      DO $u$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'country') THEN
          EXECUTE 'UPDATE users SET unit_system = ''imperial'' WHERE country IN (''US'', ''LR'', ''MM'')';
        END IF;
      END $u$;
    `);
  },

  down: async (client) => {
    await client.query(`
      DROP INDEX IF EXISTS idx_users_unit_system;
      ALTER TABLE users DROP COLUMN IF EXISTS unit_system;
    `);
  },
};
