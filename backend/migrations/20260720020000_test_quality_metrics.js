// Migration: Test Quality Metrics Tables
// 创建测试质量度量表

'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 变异测试结果表
    await queryInterface.createTable('mutation_test_results', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      service: {
        type: Sequelize.STRING(100),
        allowNull: false,
        comment: '服务名称'
      },
      file_path: {
        type: Sequelize.STRING(255),
        allowNull: false,
        comment: '变异的文件路径'
      },
      mutation_type: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: '变异类型'
      },
      original_code: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: '原始代码'
      },
      mutated_code: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: '变异后代码'
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        comment: '状态: killed, survived, timeout, no_coverage'
      },
      line_number: {
        type: Sequelize.INTEGER,
        comment: '变异所在行号'
      },
      test_run_id: {
        type: Sequelize.STRING(100),
        comment: '测试运行 ID'
      },
      branch: {
        type: Sequelize.STRING(100),
        comment: 'Git 分支'
      },
      commit_sha: {
        type: Sequelize.STRING(40),
        comment: 'Git commit SHA'
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('mutation_test_results', ['service', 'created_at']);
    await queryInterface.addIndex('mutation_test_results', ['status']);

    // 测试质量历史记录表
    await queryInterface.createTable('test_quality_history', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
        unique: true,
        comment: '记录日期'
      },
      service: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: '服务名称，null 表示全局'
      },
      mutation_score: {
        type: Sequelize.DECIMAL(5, 2),
        comment: '变异测试覆盖率'
      },
      line_coverage: {
        type: Sequelize.DECIMAL(5, 2),
        comment: '行覆盖率'
      },
      branch_coverage: {
        type: Sequelize.DECIMAL(5, 2),
        comment: '分支覆盖率'
      },
      assertion_density: {
        type: Sequelize.DECIMAL(5, 4),
        comment: '断言密度'
      },
      boundary_coverage: {
        type: Sequelize.DECIMAL(5, 2),
        comment: '边界覆盖率'
      },
      quality_score: {
        type: Sequelize.DECIMAL(5, 2),
        comment: '测试质量分数'
      },
      grade: {
        type: Sequelize.CHAR(1),
        comment: '质量等级 A-F'
      },
      test_count: {
        type: Sequelize.INTEGER,
        comment: '测试用例总数'
      },
      weak_test_count: {
        type: Sequelize.INTEGER,
        comment: '弱测试数量'
      },
      killed_mutants: {
        type: Sequelize.INTEGER,
        comment: '被杀死的变异体数'
      },
      survived_mutants: {
        type: Sequelize.INTEGER,
        comment: '存活的变异体数'
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('test_quality_history', ['date']);
    await queryInterface.addIndex('test_quality_history', ['service', 'date']);

    // 弱测试记录表
    await queryInterface.createTable('weak_tests', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      file_path: {
        type: Sequelize.STRING(255),
        allowNull: false,
        comment: '测试文件路径'
      },
      test_name: {
        type: Sequelize.STRING(255),
        allowNull: false,
        comment: '测试用例名称'
      },
      type: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: '弱测试类型'
      },
      severity: {
        type: Sequelize.STRING(20),
        allowNull: false,
        comment: '严重程度: critical, high, medium, low'
      },
      line: {
        type: Sequelize.INTEGER,
        comment: '测试所在行号'
      },
      message: {
        type: Sequelize.TEXT,
        comment: '问题描述'
      },
      suggestion: {
        type: Sequelize.TEXT,
        comment: '改进建议'
      },
      details: {
        type: Sequelize.TEXT,
        comment: '详细信息'
      },
      detected_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      fixed_at: {
        type: Sequelize.DATE,
        comment: '修复时间'
      },
      fixed_by: {
        type: Sequelize.INTEGER,
        comment: '修复者用户 ID'
      },
      fix_commit: {
        type: Sequelize.STRING(40),
        comment: '修复的 commit SHA'
      }
    });

    await queryInterface.addIndex('weak_tests', ['file_path']);
    await queryInterface.addIndex('weak_tests', ['severity', 'fixed_at']);
    await queryInterface.addIndex('weak_tests', ['type']);

    // 测试质量趋势汇总表
    await queryInterface.createTable('test_quality_trends', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      week_start: {
        type: Sequelize.DATEONLY,
        allowNull: false,
        unique: true,
        comment: '周起始日期'
      },
      avg_mutation_score: {
        type: Sequelize.DECIMAL(5, 2),
        comment: '平均变异覆盖率'
      },
      avg_quality_score: {
        type: Sequelize.DECIMAL(5, 2),
        comment: '平均质量分数'
      },
      total_weak_tests: {
        type: Sequelize.INTEGER,
        comment: '弱测试总数'
      },
      fixed_weak_tests: {
        type: Sequelize.INTEGER,
        comment: '已修复弱测试数'
      },
      trend_direction: {
        type: Sequelize.STRING(20),
        comment: '趋势方向: improving, stable, declining'
      },
      created_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('test_quality_trends');
    await queryInterface.dropTable('weak_tests');
    await queryInterface.dropTable('test_quality_history');
    await queryInterface.dropTable('mutation_test_results');
  }
};