// database/migrations/202606302200_bandwidth_monitoring.js
// REQ-00397: API 响应压缩与带宽优化系统 - 数据库迁移

'use strict';

module.exports = {
  up: async (client) => {
    // 带宽使用统计表
    await client.query(`
      CREATE TABLE IF NOT EXISTS bandwidth_stats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        service VARCHAR(100) NOT NULL,
        endpoint VARCHAR(255) NOT NULL,
        request_count INTEGER DEFAULT 0,
        total_bytes INTEGER DEFAULT 0,
        compressed_bytes INTEGER DEFAULT 0,
        avg_response_size INTEGER DEFAULT 0,
        compression_ratio DECIMAL(5,2) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 压缩缓存记录表
    await client.query(`
      CREATE TABLE IF NOT EXISTS compression_cache (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cache_key VARCHAR(255) NOT NULL UNIQUE,
        algorithm VARCHAR(20) NOT NULL,
        original_size INTEGER NOT NULL,
        compressed_size INTEGER NOT NULL,
        hit_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);

    // 带宽使用历史表（按小时统计）
    await client.query(`
      CREATE TABLE IF NOT EXISTS bandwidth_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hour_bucket TIMESTAMPTZ NOT NULL,
        service VARCHAR(100) NOT NULL,
        total_bytes INTEGER DEFAULT 0,
        compressed_bytes INTEGER DEFAULT 0,
        request_count INTEGER DEFAULT 0,
        avg_compression_ratio DECIMAL(5,2),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 创建索引
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bandwidth_stats_service ON bandwidth_stats(service);
      CREATE INDEX IF NOT EXISTS idx_bandwidth_stats_endpoint ON bandwidth_stats(endpoint);
      CREATE INDEX IF NOT EXISTS idx_bandwidth_stats_time ON bandwidth_stats(created_at DESC);
      
      CREATE INDEX IF NOT EXISTS idx_compression_cache_key ON compression_cache(cache_key);
      CREATE INDEX IF NOT EXISTS idx_compression_cache_expires ON compression_cache(expires_at);
      
      CREATE INDEX IF NOT EXISTS idx_bandwidth_history_hour ON bandwidth_history(hour_bucket DESC);
      CREATE INDEX IF NOT EXISTS idx_bandwidth_history_service ON bandwidth_history(service, hour_bucket DESC);
    `);

    // 创建带宽历史统计视图
    await client.query(`
      CREATE OR REPLACE VIEW bandwidth_daily_summary AS
      SELECT
        DATE(created_at) as date,
        service,
        SUM(total_bytes) as total_bytes,
        SUM(compressed_bytes) as compressed_bytes,
        SUM(request_count) as total_requests,
        ROUND(AVG(compression_ratio), 2) as avg_compression_ratio
      FROM bandwidth_stats
      GROUP BY DATE(created_at), service
      ORDER BY date DESC;
    `);

    console.log('✅ REQ-00397: bandwidth_monitoring tables created');
  },

  down: async (client) => {
    await client.query('DROP VIEW IF EXISTS bandwidth_daily_summary;');
    await client.query('DROP TABLE IF EXISTS bandwidth_history;');
    await client.query('DROP TABLE IF EXISTS compression_cache;');
    await client.query('DROP TABLE IF EXISTS bandwidth_stats;');
    console.log('✅ REQ-00397: bandwidth_monitoring tables dropped');
  }
};