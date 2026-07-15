'use strict';

/**
 * 跨语言实时聊天翻译系统数据库迁移
 * REQ-00551
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 1. 翻译缓存表
    await queryInterface.createTable('translation_cache', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      source_text_hash: {
        type: Sequelize.STRING(64),
        allowNull: false,
        comment: '原文 MD5 哈希'
      },
      source_language: {
        type: Sequelize.STRING(10),
        allowNull: false,
        comment: '源语言代码'
      },
      target_language: {
        type: Sequelize.STRING(10),
        allowNull: false,
        comment: '目标语言代码'
      },
      translated_text: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: '翻译结果'
      },
      quality_score: {
        type: Sequelize.DECIMAL(3, 2),
        comment: '翻译质量评分'
      },
      usage_count: {
        type: Sequelize.INTEGER,
        defaultValue: 1,
        comment: '使用次数'
      },
      last_used_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()'),
        comment: '最后使用时间'
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    await queryInterface.addIndex('translation_cache', 
      ['source_text_hash', 'source_language', 'target_language'], 
      { 
        name: 'idx_translation_cache_lookup',
        unique: true 
      }
    );
    
    await queryInterface.addIndex('translation_cache', 
      ['usage_count', 'last_used_at'], 
      { name: 'idx_translation_cache_lru' }
    );

    // 2. 游戏术语词典表
    await queryInterface.createTable('game_term_dictionary', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      term_key: {
        type: Sequelize.STRING(128),
        allowNull: false,
        comment: '术语唯一标识'
      },
      source_language: {
        type: Sequelize.STRING(10),
        allowNull: false,
        comment: '源语言代码'
      },
      source_term: {
        type: Sequelize.STRING(256),
        allowNull: false,
        comment: '源语言术语'
      },
      translations: {
        type: Sequelize.JSONB,
        allowNull: false,
        comment: '多语言翻译 {"zh-CN": "精灵球", "ja-JP": "モンスターボール"}'
      },
      category: {
        type: Sequelize.STRING(50),
        comment: '术语类别：pokemon/item/skill/location/mechanic'
      },
      context_hint: {
        type: Sequelize.TEXT,
        comment: '上下文提示'
      },
      is_official: {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
        comment: '是否官方术语'
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    await queryInterface.addIndex('game_term_dictionary', 
      ['source_term', 'source_language'], 
      { name: 'idx_term_lookup' }
    );
    
    await queryInterface.addIndex('game_term_dictionary', 
      ['category'], 
      { name: 'idx_term_category' }
    );
    
    await queryInterface.addConstraint('game_term_dictionary', {
      fields: ['term_key', 'source_language'],
      type: 'unique',
      name: 'uq_term_key_language'
    });

    // 3. 翻译质量反馈表
    await queryInterface.createTable('translation_feedback', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      message_id: {
        type: Sequelize.STRING(128),
        allowNull: false,
        comment: '关联的消息ID'
      },
      user_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        comment: '用户ID'
      },
      source_text: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: '原文'
      },
      original_translation: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: '原始翻译'
      },
      suggested_translation: {
        type: Sequelize.TEXT,
        comment: '建议翻译'
      },
      source_language: {
        type: Sequelize.STRING(10),
        comment: '源语言'
      },
      target_language: {
        type: Sequelize.STRING(10),
        comment: '目标语言'
      },
      rating: {
        type: Sequelize.INTEGER,
        comment: '评分 1-5'
      },
      issue_type: {
        type: Sequelize.STRING(50),
        comment: '问题类型：accuracy/context/terminology/grammar'
      },
      status: {
        type: Sequelize.STRING(20),
        defaultValue: 'pending',
        comment: '状态：pending/reviewed/applied/ignored'
      },
      reviewed_at: {
        type: Sequelize.DATE,
        comment: '审核时间'
      },
      reviewer_id: {
        type: Sequelize.STRING(64),
        comment: '审核人ID'
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    await queryInterface.addIndex('translation_feedback', 
      ['status', 'created_at'], 
      { name: 'idx_translation_feedback_pending' }
    );
    
    await queryInterface.addIndex('translation_feedback', 
      ['user_id'], 
      { name: 'idx_translation_feedback_user' }
    );

    // 4. 翻译用量统计表
    await queryInterface.createTable('translation_usage_stats', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
        comment: '统计日期'
      },
      source_language: {
        type: Sequelize.STRING(10),
        comment: '源语言'
      },
      target_language: {
        type: Sequelize.STRING(10),
        comment: '目标语言'
      },
      message_count: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: '消息数量'
      },
      character_count: {
        type: Sequelize.BIGINT,
        defaultValue: 0,
        comment: '字符数量'
      },
      api_calls: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: 'API 调用次数'
      },
      cache_hits: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: '缓存命中次数'
      },
      errors: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: '错误次数'
      },
      avg_latency_ms: {
        type: Sequelize.INTEGER,
        comment: '平均延迟(毫秒)'
      },
      cost_usd: {
        type: Sequelize.DECIMAL(10, 4),
        comment: '成本(美元)'
      }
    });

    await queryInterface.addIndex('translation_usage_stats', 
      ['date'], 
      { name: 'idx_translation_usage_date' }
    );
    
    await queryInterface.addConstraint('translation_usage_stats', {
      fields: ['date', 'source_language', 'target_language'],
      type: 'unique',
      name: 'uq_usage_stats'
    });

    console.log('✅ Translation system tables created successfully');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('translation_usage_stats');
    await queryInterface.dropTable('translation_feedback');
    await queryInterface.dropTable('game_term_dictionary');
    await queryInterface.dropTable('translation_cache');
    
    console.log('✅ Translation system tables dropped successfully');
  }
};
