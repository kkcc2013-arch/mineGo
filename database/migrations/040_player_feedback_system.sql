-- REQ-00339: 玩家反馈收集与智能分析系统
-- 创建时间: 2026-06-26

-- 反馈主表
CREATE TABLE IF NOT EXISTS player_feedbacks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    feedback_type VARCHAR(20) NOT NULL CHECK (feedback_type IN ('bug', 'suggestion', 'complaint', 'other')),
    title VARCHAR(200),
    content TEXT NOT NULL,
    category VARCHAR(50),
    tags TEXT[],
    priority VARCHAR(10) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'resolved', 'closed')),
    sentiment VARCHAR(20) CHECK (sentiment IN ('very_positive', 'positive', 'neutral', 'negative', 'very_negative')),
    sentiment_score DECIMAL(3,2),
    
    -- 关联数据
    pokemon_id INTEGER,
    battle_id INTEGER,
    location_lat DECIMAL(10, 8),
    location_lng DECIMAL(11, 8),
    
    -- 设备信息
    device_info JSONB DEFAULT '{}',
    app_version VARCHAR(20),
    os_version VARCHAR(20),
    
    -- 附件
    attachments JSONB DEFAULT '[]',
    
    -- 处理信息
    assigned_to INTEGER REFERENCES users(id),
    resolved_at TIMESTAMP,
    resolution TEXT,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 反馈标签表
CREATE TABLE IF NOT EXISTS feedback_tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    category VARCHAR(50),
    usage_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 反馈分析结果表
CREATE TABLE IF NOT EXISTS feedback_analysis (
    id SERIAL PRIMARY KEY,
    feedback_id INTEGER REFERENCES player_feedbacks(id) ON DELETE CASCADE,
    analysis_type VARCHAR(50) NOT NULL,
    result JSONB NOT NULL,
    confidence DECIMAL(5,4),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 反馈工作流日志表
CREATE TABLE IF NOT EXISTS feedback_workflow_logs (
    id SERIAL PRIMARY KEY,
    feedback_id INTEGER REFERENCES player_feedbacks(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    from_status VARCHAR(20),
    to_status VARCHAR(20),
    operator_id INTEGER REFERENCES users(id),
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- FAQ 表
CREATE TABLE IF NOT EXISTS feedback_faq (
    id SERIAL PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category VARCHAR(50),
    keywords TEXT[],
    view_count INTEGER DEFAULT 0,
    helpful_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_feedbacks_user ON player_feedbacks(user_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON player_feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_type ON player_feedbacks(feedback_type);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON player_feedbacks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedbacks_sentiment ON player_feedbacks(sentiment);
CREATE INDEX IF NOT EXISTS idx_feedbacks_priority ON player_feedbacks(priority);
CREATE INDEX IF NOT EXISTS idx_feedbacks_category ON player_feedbacks(category);
CREATE INDEX IF NOT EXISTS idx_feedbacks_tags ON player_feedbacks USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_feedback_analysis_fid ON feedback_analysis(feedback_id);
CREATE INDEX IF NOT EXISTS idx_workflow_logs_fid ON feedback_workflow_logs(feedback_id);

-- 初始化默认标签
INSERT INTO feedback_tags (name, category) VALUES
    ('卡顿', 'performance'),
    ('闪退', 'performance'),
    ('延迟', 'performance'),
    ('掉帧', 'performance'),
    ('界面问题', 'ui'),
    ('按钮无响应', 'ui'),
    ('显示异常', 'ui'),
    ('技能问题', 'gameplay'),
    ('战斗问题', 'gameplay'),
    ('捕捉问题', 'gameplay'),
    ('进化问题', 'gameplay'),
    ('好友问题', 'social'),
    ('公会问题', 'social'),
    ('聊天问题', 'social'),
    ('交易问题', 'social'),
    ('支付问题', 'payment'),
    ('充值问题', 'payment'),
    ('货币问题', 'payment'),
    ('平衡性', 'balance'),
    ('数值问题', 'balance'),
    ('建议', 'other'),
    ('其他', 'other')
ON CONFLICT (name) DO NOTHING;

-- 初始化 FAQ
INSERT INTO feedback_faq (question, answer, category, keywords) VALUES
    ('游戏卡顿怎么办？', '请尝试：1. 关闭后台应用 2. 降低画质设置 3. 检查网络连接 4. 清理设备存储空间', 'performance', ARRAY['卡顿', 'lag', '慢']),
    ('如何报告Bug？', '点击设置->帮助与反馈->提交反馈，选择Bug报告类型，详细描述问题并附上截图', 'other', ARRAY['bug', '报告', '问题']),
    ('充值未到账怎么办？', '请稍等5-10分钟，如仍未到账请在反馈中提交订单号，我们会尽快处理', 'payment', ARRAY['充值', '支付', '未到账']),
    ('如何找回误删的精灵？', '误删的精灵可在7天内通过精灵恢复站找回，超过7天无法恢复', 'gameplay', ARRAY['精灵', '删除', '找回']),
    ('战斗中技能无法使用？', '请检查：1. 技能冷却时间 2. 能量是否足够 3. 是否被沉默状态影响', 'gameplay', ARRAY['技能', '战斗', '无法使用'])
ON CONFLICT DO NOTHING;

-- 触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_feedback_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_feedback_updated_at ON player_feedbacks;
CREATE TRIGGER trigger_feedback_updated_at
    BEFORE UPDATE ON player_feedbacks
    FOR EACH ROW
    EXECUTE FUNCTION update_feedback_updated_at();

-- 视图：反馈统计
CREATE OR REPLACE VIEW v_feedback_stats AS
SELECT 
    COUNT(*) as total_count,
    COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
    COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress_count,
    COUNT(*) FILTER (WHERE status = 'resolved') as resolved_count,
    COUNT(*) FILTER (WHERE priority = 'critical') as critical_count,
    COUNT(*) FILTER (WHERE priority = 'high') as high_count,
    AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL) as avg_resolution_hours,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today_count,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as week_count
FROM player_feedbacks;

-- 视图：高频问题
CREATE OR REPLACE VIEW v_top_issues AS
SELECT 
    title,
    category,
    feedback_type,
    sentiment,
    status,
    COUNT(*) as occurrence_count
FROM player_feedbacks
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY title, category, feedback_type, sentiment, status
HAVING COUNT(*) >= 3
ORDER BY occurrence_count DESC;

COMMENT ON TABLE player_feedbacks IS '玩家反馈主表';
COMMENT ON TABLE feedback_tags IS '反馈标签字典表';
COMMENT ON TABLE feedback_analysis IS '反馈AI分析结果表';
COMMENT ON TABLE feedback_workflow_logs IS '反馈工作流日志表';
COMMENT ON TABLE feedback_faq IS '常见问题FAQ表';
