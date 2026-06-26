// database/migrations/20260626050000_add_user_unit_system.js
// REQ-00335: 游戏距离单位本地化与智能转换系统
// 为 users 表添加 unit_system 字段

'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    
    // 1. 添加 unit_system 字段
    await queryInterface.addColumn('users', 'unit_system', {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'metric',
      comment: '用户单位制偏好：metric（公制）或 imperial（英制）'
    });
    
    // 2. 创建索引
    await queryInterface.addIndex('users', ['unit_system'], {
      name: 'idx_users_unit_system'
    });
    
    // 3. 根据用户国家更新现有用户的单位制偏好
    // 美国、利比里亚、缅甸使用英制
    await queryInterface.sequelize.query(`
      UPDATE users
      SET unit_system = 'imperial'
      WHERE country IN ('US', 'LR', 'MM')
    `);
    
    console.log('[Migration] Added unit_system column to users table');
    console.log('[Migration] Updated US/LR/MM users to imperial unit system');
  },
  
  down: async (queryInterface, Sequelize) => {
    // 删除索引
    await queryInterface.removeIndex('users', 'idx_users_unit_system');
    
    // 删除字段
    await queryInterface.removeColumn('users', 'unit_system');
    
    console.log('[Migration] Removed unit_system column from users table');
  }
};
