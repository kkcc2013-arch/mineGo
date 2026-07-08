-- =====================================================
-- 注入检测系统数据库迁移
-- REQ-00503: 游戏客户端注入工具检测与防护系统
-- =====================================================

-- 1. 创建检测报告表
CREATE TABLE IF NOT EXISTS injection_detection_reports (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL,
  timestamp BIGINT NOT NULL,
  risk_level VARCHAR(16) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  detections JSONB NOT NULL,
  user_id VARCHAR(64),
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_injection_device ON injection_detection_reports(device_id);
CREATE INDEX IF NOT EXISTS idx_injection_risk ON injection_detection_reports(risk_level, created_at);
CREATE INDEX IF NOT EXISTS idx_injection_timestamp ON injection_detection_reports(timestamp);
CREATE INDEX IF NOT EXISTS idx_injection_user ON injection_detection_reports(user_id) WHERE user_id IS NOT NULL;

-- 2. 创建检测规则表
CREATE TABLE IF NOT EXISTS detection_rules (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  tool_type VARCHAR(32) NOT NULL CHECK (tool_type IN ('frida', 'xposed', 'gameguardian', 'virtual', 'other')),
  detection_strategy JSONB NOT NULL,
  severity VARCHAR(16) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  enabled BOOLEAN DEFAULT true,
  target_region VARCHAR(16),
  min_version VARCHAR(16),
  priority INTEGER DEFAULT 50,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 3. 创建设备安全标记表（持久化 Redis 缓存）
CREATE TABLE IF NOT EXISTS flagged_devices (
  device_id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64),
  risk_level VARCHAR(16) NOT NULL,
  flagged_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  reason VARCHAR(255),
  detection_count INTEGER DEFAULT 1,
  last_detection_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_flagged_expires ON flagged_devices(expires_at);
CREATE INDEX IF NOT EXISTS idx_flagged_user ON flagged_devices(user_id) WHERE user_id IS NOT NULL;

-- 4. 创建安全审查队列表
CREATE TABLE IF NOT EXISTS security_review_queue (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  risk_level VARCHAR(16) NOT NULL,
  source VARCHAR(32) NOT NULL,
  status VARCHAR(16) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'dismissed')),
  review_result VARCHAR(32),
  reviewer_id VARCHAR(64),
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_pending ON security_review_queue(status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_review_user ON security_review_queue(user_id);

-- 5. 插入初始检测规则
INSERT INTO detection_rules (id, name, tool_type, detection_strategy, severity, priority) VALUES
('frida-port', 'Frida 默认端口检测', 'frida', 
 '{"type": "port", "port": 27042, "description": "检测 Frida 服务端默认监听端口"}', 
 'medium', 80)
ON CONFLICT (id) DO NOTHING;

INSERT INTO detection_rules (id, name, tool_type, detection_strategy, severity, priority) VALUES
('frida-process', 'Frida 服务端进程检测', 'frida', 
 '{"type": "process", "patterns": ["frida-server", "frida"], "description": "检测 frida-server 进程"}', 
 'high', 90)
ON CONFLICT (id) DO NOTHING;

INSERT INTO detection_rules (id, name, tool_type, detection_strategy, severity, priority) VALUES
('frida-file', 'Frida 特征文件检测', 'frida', 
 '{"type": "file", "paths": ["data/local/tmp/frida-server", "/data/local/tmp/re.frida.server"], "description": "检测 Frida 服务端特征文件"}', 
 'high', 85)
ON CONFLICT (id) DO NOTHING;

INSERT INTO detection_rules (id, name, tool_type, detection_strategy, severity, priority) VALUES
('xposed-file', 'Xposed/LSPosed 特征文件检测', 'xposed', 
 '{"type": "file", "paths": ["system/framework/XposedBridge.jar", "/system/xposed.prop", "/data/adb/lspd/config"], "description": "检测 Xposed/LSPosed 模块特征文件"}', 
 'high', 90)
ON CONFLICT (id) DO NOTHING;

INSERT INTO detection_rules (id, name, tool_type, detection_strategy, severity, priority) VALUES
('xposed-api', 'Xposed API 痕迹检测', 'xposed', 
 '{"type": "api", "indicators": ["XposedBridge", "XposedHelpers"], "description": "检测 JavaScript 中的 Xposed API 痕迹"}', 
 'medium', 75)
ON CONFLICT (id) DO NOTHING;

INSERT INTO detection_rules (id, name, tool_type, detection_strategy, severity, priority) VALUES
('gg-process', 'GameGuardian 进程检测', 'gameguardian', 
 '{"type": "process", "patterns": ["gameguardian", "gg_process", "speed.gg"], "description": "检测 GameGuardian 进程"}', 
 'medium', 70)
ON CONFLICT (id) DO NOTHING;

INSERT INTO detection_rules (id, name, tool_type, detection_strategy, severity, priority) VALUES
('gg-file', 'GameGuardian 特征文件检测', 'gameguardian', 
 '{"type": "file", "paths": ["data/data/com.gameguardian", "/sdcard/GameGuardian"], "description": "检测 GameGuardian 数据文件"}', 
 'medium', 65)
ON CONFLICT (id) DO NOTHING;

INSERT INTO detection_rules (id, name, tool_type, detection_strategy, severity, priority) VALUES
('virtual-pkg', '虚拟环境包名检测', 'virtual', 
 '{"type": "package", "packages": ["io.va.exposed", "com.exposed.plugin", "com.lzplay.np", "me.weishu.exp"], "description": "检测 VirtualXposed、太极等虚拟环境应用"}', 
 'critical', 100)
ON CONFLICT (id) DO NOTHING;

INSERT INTO detection_rules (id, name, tool_type, detection_strategy, severity, priority) VALUES
('virtual-path', '虚拟环境路径检测', 'virtual', 
 '{"type": "path", "patterns": ["virtual", "clone", "parallel"], "description": "检测应用运行在虚拟环境中的路径特征"}', 
 'critical', 95)
ON CONFLICT (id) DO NOTHING;

-- 6. 创建统计视图
CREATE OR REPLACE VIEW injection_detection_stats AS
SELECT 
  DATE(created_at) as report_date,
  risk_level,
  COUNT(*) as report_count,
  COUNT(DISTINCT device_id) as unique_devices,
  AVG(jsonb_array_length(detections)) as avg_detection_count
FROM injection_detection_reports
GROUP BY DATE(created_at), risk_level
ORDER BY report_date DESC, risk_level;

-- 7. 创建清理函数（定期清理旧报告）
CREATE OR REPLACE FUNCTION cleanup_old_injection_reports(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM injection_detection_reports 
  WHERE created_at < NOW() - (days_to_keep || ' days')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 8. 创建触发器（自动更新 flagged_devices 表）
CREATE OR REPLACE FUNCTION update_flagged_device()
RETURNS TRIGGER AS $$
BEGIN
  -- 高风险报告时更新设备标记
  IF NEW.risk_level IN ('high', 'critical') THEN
    INSERT INTO flagged_devices (device_id, user_id, risk_level, expires_at, reason, detection_count, last_detection_at)
    VALUES (
      NEW.device_id,
      NEW.user_id,
      NEW.risk_level,
      NOW() + INTERVAL '30 days',
      'Injection tool detected',
      1,
      NOW()
    )
    ON CONFLICT (device_id) DO UPDATE SET
      risk_level = CASE WHEN NEW.risk_level = 'critical' THEN 'critical' ELSE EXCLUDED.risk_level END,
      detection_count = EXCLUDED.detection_count + 1,
      last_detection_at = NOW(),
      expires_at = NOW() + INTERVAL '30 days';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER injection_report_trigger
AFTER INSERT ON injection_detection_reports
FOR EACH ROW
EXECUTE FUNCTION update_flagged_device();

-- 9. 注释
COMMENT ON TABLE injection_detection_reports IS '注入工具检测报告记录表';
COMMENT ON TABLE detection_rules IS '检测规则配置表，支持热更新';
COMMENT ON TABLE flagged_devices IS '被标记的高风险设备表';
COMMENT ON TABLE security_review_queue IS '账号安全审查队列';
COMMENT ON FUNCTION cleanup_old_injection_reports IS '清理旧的检测报告，默认保留 90 天';