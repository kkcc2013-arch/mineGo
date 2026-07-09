'use strict';

/**
 * REQ-00508: 服务发现与健康检查数据表迁移
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 服务实例表
    await queryInterface.createTable('service_instances', {
      id: {
        type: Sequelize.STRING(64),
        primaryKey: true
      },
      name: {
        type: Sequelize.STRING(64),
        allowNull: false,
        comment: '服务名称'
      },
      host: {
        type: Sequelize.STRING(128),
        allowNull: false,
        comment: '主机地址'
      },
      port: {
        type: Sequelize.INTEGER,
        allowNull: false,
        comment: '端口'
      },
      protocol: {
        type: Sequelize.STRING(16),
        defaultValue: 'http',
        comment: '协议'
      },
      weight: {
        type: Sequelize.INTEGER,
        defaultValue: 100,
        comment: '权重 (0-100)'
      },
      status: {
        type: Sequelize.STRING(16),
        defaultValue: 'unknown',
        comment: '状态: healthy/unhealthy/unknown'
      },
      metadata: {
        type: Sequelize.JSONB,
        defaultValue: {},
        comment: '元数据'
      },
      registered_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()'),
        comment: '注册时间'
      },
      last_heartbeat: {
        type: Sequelize.DATE,
        comment: '最后心跳时间'
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    }, {
      comment: '服务实例注册表'
    });

    // 创建索引
    await queryInterface.addIndex('service_instances', ['name'], { name: 'idx_service_instances_name' });
    await queryInterface.addIndex('service_instances', ['status'], { name: 'idx_service_instances_status' });
    await queryInterface.addIndex('service_instances', ['last_heartbeat'], { name: 'idx_service_instances_last_heartbeat' });
    await queryInterface.addIndex('service_instances', ['host', 'port'], { name: 'idx_service_instances_host_port', unique: true });

    // 健康检查历史表
    await queryInterface.createTable('health_check_history', {
      id: {
        type: Sequelize.STRING(64),
        primaryKey: true
      },
      instance_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        references: {
          model: 'service_instances',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        comment: '检查结果: healthy/unhealthy'
      },
      response_time_ms: {
        type: Sequelize.INTEGER,
        comment: '响应时间（毫秒）'
      },
      error_message: {
        type: Sequelize.TEXT,
        comment: '错误信息'
      },
      checked_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()'),
        comment: '检查时间'
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    }, {
      comment: '健康检查历史记录'
    });

    // 创建索引
    await queryInterface.addIndex('health_check_history', ['instance_id'], { name: 'idx_health_check_history_instance' });
    await queryInterface.addIndex('health_check_history', ['checked_at'], { name: 'idx_health_check_history_checked_at' });
    await queryInterface.addIndex('health_check_history', ['status'], { name: 'idx_health_check_history_status' });

    // 负载均衡统计表
    await queryInterface.createTable('load_balancer_stats', {
      id: {
        type: Sequelize.STRING(64),
        primaryKey: true
      },
      instance_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        references: {
          model: 'service_instances',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      active_connections: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: '活跃连接数'
      },
      total_requests: {
        type: Sequelize.BIGINT,
        defaultValue: 0,
        comment: '总请求数'
      },
      success_requests: {
        type: Sequelize.BIGINT,
        defaultValue: 0,
        comment: '成功请求数'
      },
      failed_requests: {
        type: Sequelize.BIGINT,
        defaultValue: 0,
        comment: '失败请求数'
      },
      avg_response_time_ms: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: '平均响应时间'
      },
      updated_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    }, {
      comment: '负载均衡统计数据'
    });

    await queryInterface.addIndex('load_balancer_stats', ['instance_id'], { name: 'idx_load_balancer_stats_instance' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('load_balancer_stats');
    await queryInterface.dropTable('health_check_history');
    await queryInterface.dropTable('service_instances');
  }
};