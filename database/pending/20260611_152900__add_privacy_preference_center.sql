-- REQ-00053: 用户隐私偏好管理中心与数据透明度报告
-- 创建隐私偏好表、隐私政策版本表、数据透明度报告表等

-- 1. 隐私偏好表
CREATE TABLE IF NOT EXISTS user_privacy_preferences (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  category VARCHAR(32) NOT NULL CHECK (category IN ('location', 'behavior', 'marketing', 'analytics', 'social', 'payment', 'device', 'profile')),
  collectable BOOLEAN NOT NULL DEFAULT true,
  consented_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, category)
);

-- 2. 隐私政策版本表
CREATE TABLE IF NOT EXISTS privacy_policy_versions (
  id SERIAL PRIMARY KEY,
  version VARCHAR(16) NOT NULL UNIQUE,
  effective_date DATE NOT NULL,
  changes TEXT[],
  content_zh_cn TEXT NOT NULL,
  content_en_us TEXT NOT NULL,
  content_ja_jp TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. 数据透明度报告表
CREATE TABLE IF NOT EXISTS data_transparency_reports (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  month VARCHAR(7) NOT NULL,
  report_json JSONB NOT NULL,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, month)
);

-- 4. 用户政策接受记录
CREATE TABLE IF NOT EXISTS privacy_policy_acceptance (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  policy_version VARCHAR(16) NOT NULL,
  accepted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, policy_version)
);

-- 5. 数据访问日志表（扩展审计日志）
CREATE TABLE IF NOT EXISTS data_access_logs (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  category VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  purpose VARCHAR(128),
  details TEXT,
  accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_user_privacy_preferences_user ON user_privacy_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_privacy_policy_versions_effective ON privacy_policy_versions(effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_data_transparency_reports_user_month ON data_transparency_reports(user_id, month);
CREATE INDEX IF NOT EXISTS idx_privacy_policy_acceptance_user ON privacy_policy_acceptance(user_id);
CREATE INDEX IF NOT EXISTS idx_data_access_logs_user ON data_access_logs(user_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_access_logs_category ON data_access_logs(user_id, category, accessed_at DESC);

-- 插入初始隐私政策版本
INSERT INTO privacy_policy_versions (version, effective_date, changes, content_zh_cn, content_en_us, content_ja_jp)
VALUES (
  'v1.0',
  '2026-01-01',
  ARRAY['初始版本'],
  '# mineGo 隐私政策

## 1. 数据收集
我们收集以下类型的数据以提供游戏服务：

### 1.1 位置数据（必需）
- GPS 坐标
- 移动轨迹
- 用于：精灵刷新、道馆定位、附近玩家

### 1.2 行为数据（可选）
- 捕捉记录
- 战斗历史
- 社交互动
- 用于：个性化推荐、游戏优化

### 1.3 营销数据（可选）
- 推送通知偏好
- 活动提醒设置
- 用于：活动通知、个性化推荐

### 1.4 分析数据（可选）
- 游戏使用统计
- 性能指标
- 崩溃报告
- 用于：改进游戏体验

### 1.5 社交数据（可选）
- 好友列表
- 聊天记录
- 精灵交易
- 用于：社交功能

### 1.6 支付数据（可选）
- 订单记录
- 精币余额
- 用于：内购服务

### 1.7 设备数据（必需）
- 设备型号
- 操作系统
- 唯一标识符
- 用于：反作弊、兼容性

### 1.8 个人资料（可选）
- 用户名
- 头像
- 语言偏好
- 用于：个性化体验

## 2. 数据使用
您的数据仅用于：
- 提供游戏服务
- 改进游戏体验
- 安全防护
- 合规要求

## 3. 数据共享
我们不会向第三方出售您的数据。
仅在以下情况共享：
- 法律要求
- 安全需要
- 您的明确同意

## 4. 数据保留
- 位置数据：90 天
- 行为数据：365 天
- 支付数据：365 天
- 个人资料：永久（直至账号删除）

## 5. 您的权利
- 访问您的数据
- 更正错误数据
- 删除您的数据
- 导出您的数据
- 撤回同意

## 6. 联系我们
隐私问题：privacy@minego.example.com

最后更新：2026年1月1日',
  '# mineGo Privacy Policy

## 1. Data Collection
We collect the following types of data to provide game services:

### 1.1 Location Data (Required)
- GPS coordinates
- Movement tracks
- Used for: Pokemon spawning, gym locations, nearby players

### 1.2 Behavior Data (Optional)
- Catch records
- Battle history
- Social interactions
- Used for: Personalized recommendations, game optimization

### 1.3 Marketing Data (Optional)
- Push notification preferences
- Event reminder settings
- Used for: Event notifications, personalized recommendations

### 1.4 Analytics Data (Optional)
- Game usage statistics
- Performance metrics
- Crash reports
- Used for: Improving game experience

### 1.5 Social Data (Optional)
- Friend list
- Chat records
- Pokemon trades
- Used for: Social features

### 1.6 Payment Data (Optional)
- Order records
- Coin balance
- Used for: In-app purchases

### 1.7 Device Data (Required)
- Device model
- Operating system
- Unique identifier
- Used for: Anti-cheat, compatibility

### 1.8 Profile Data (Optional)
- Username
- Avatar
- Language preference
- Used for: Personalized experience

## 2. Data Usage
Your data is only used for:
- Providing game services
- Improving game experience
- Security protection
- Compliance requirements

## 3. Data Sharing
We do not sell your data to third parties.
We only share data in the following cases:
- Legal requirements
- Security needs
- Your explicit consent

## 4. Data Retention
- Location data: 90 days
- Behavior data: 365 days
- Payment data: 365 days
- Profile data: Permanent (until account deletion)

## 5. Your Rights
- Access your data
- Correct incorrect data
- Delete your data
- Export your data
- Withdraw consent

## 6. Contact Us
Privacy questions: privacy@minego.example.com

Last updated: January 1, 2026',
  '# mineGo プライバシー政策

## 1. データ収集
ゲームサービスを提供するために、以下の種類のデータを収集します：

### 1.1 位置データ（必須）
- GPS座標
- 移動経路
- 用途：ポケモン出現、ジム位置、近くのプレイヤー

### 1.2 行動データ（任意）
- 捕獲記録
- バトル履歴
- ソーシャル交流
- 用途：パーソナライズ推奨、ゲーム最適化

### 1.3 マーケティングデータ（任意）
- プッシュ通知設定
- イベント通知設定
- 用途：イベント通知、パーソナライズ推奨

### 1.4 分析データ（任意）
- ゲーム使用統計
- パフォーマンス指標
- クラッシュレポート
- 用途：ゲーム体験の向上

### 1.5 ソーシャルデータ（任意）
- フレンドリスト
- チャット記録
- ポケモン交換
- 用途：ソーシャル機能

### 1.6 決済データ（任意）
- 注文記録
- コイン残高
- 用途：アプリ内購入

### 1.7 デバイスデータ（必須）
- デバイスモデル
- オペレーティングシステム
- 一意識別子
- 用途：チート対策、互換性

### 1.8 プロフィールデータ（任意）
- ユーザー名
- アバター
- 言語設定
- 用途：パーソナライズ体験

## 2. データ使用
データは以下の目的でのみ使用されます：
- ゲームサービスの提供
- ゲーム体験の向上
- セキュリティ保護
- コンプライアンス要件

## 3. データ共有
第三者にデータを販売することはありません。
以下の場合にのみ共有します：
- 法的要件
- セキュリティ要件
- 明示的な同意

## 4. データ保持
- 位置データ：90日
- 行動データ：365日
- 決済データ：365日
- プロフィールデータ：永久（アカウント削除まで）

## 5. あなたの権利
- データへのアクセス
- 誤ったデータの修正
- データの削除
- データのエクスポート
- 同意の撤回

## 6. お問い合わせ
プライバシー問題：privacy@minego.example.com

最終更新：2026年1月1日'
);

-- 插入默认隐私偏好模板
COMMENT ON TABLE user_privacy_preferences IS 'REQ-00053: 用户隐私偏好表';
COMMENT ON TABLE privacy_policy_versions IS 'REQ-00053: 隐私政策版本表';
COMMENT ON TABLE data_transparency_reports IS 'REQ-00053: 数据透明度报告表';
COMMENT ON TABLE privacy_policy_acceptance IS 'REQ-00053: 用户政策接受记录';
COMMENT ON TABLE data_access_logs IS 'REQ-00053: 数据访问日志表';
