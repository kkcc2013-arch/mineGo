# REQ-00409: 微服务配置中心与动态配置热更新系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00409 |
| 标题 | 微服务配置中心与动态配置热更新系统 |
| 类别 | 运维/CICD |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared/configCenter、infrastructure/k8s、admin-dashboard |
| 创建时间 | 2026-07-01 11:00 |

## 需求描述

构建统一的微服务配置中心，实现配置的集中管理、版本控制、动态热更新能力，支持配置变更实时推送、灰度发布、回滚机制，提升运维效率和系统可维护性。

### 核心目标

1. **集中配置管理**：统一管理所有微服务的配置文件，支持环境隔离（dev/staging/prod）
2. **动态热更新**：配置变更无需重启服务，实时生效，支持部分服务灰度验证
3. **版本控制与审计**：配置变更历史可追溯，支持快速回滚到任意版本
4. **安全与权限**：敏感配置加密存储，细粒度权限控制
5. **高可用**：配置中心故障不影响服务运行，本地缓存保障

## 技术方案

### 1. 配置中心架构设计

```javascript
// backend/shared/configCenter/ConfigCenter.js
const EventEmitter = require('events');
const Redis = require('ioredis');
const Crypto = require('crypto');
const { createClient } = require('@redis/client');

class ConfigCenter extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      redisUrl: process.env.CONFIG_REDIS_URL || 'redis://localhost:6379',
      encryptionKey: process.env.CONFIG_ENCRYPTION_KEY,
      cacheTTL: 300, // 本地缓存 TTL（秒）
      watchEnabled: true,
      ...options
    };
    
    this.redis = null;
    this.localCache = new Map();
    this.configVersions = new Map();
    this.watchers = new Map();
    this.isConnected = false;
  }
  
  async initialize() {
    // 初始化 Redis 连接
    this.redis = new Redis(this.options.redisUrl, {
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false
    });
    
    this.redis.on('ready', () => {
      this.isConnected = true;
      this.emit('connected');
      logger.info('Config center connected to Redis');
    });
    
    this.redis.on('error', (error) => {
      this.isConnected = false;
      logger.error('Config center Redis error', { error: error.message });
      this.emit('error', error);
    });
    
    await this.redis.wait('ready');
    
    // 启动配置监听
    if (this.options.watchEnabled) {
      await this.startWatching();
    }
    
    // 从本地缓存加载（容灾）
    await this.loadLocalCache();
    
    logger.info('Config center initialized');
  }
  
  // 获取配置
  async get(key, defaultValue = null) {
    const cacheKey = this.buildCacheKey(key);
    
    // 优先使用本地缓存
    if (this.localCache.has(cacheKey)) {
      const cached = this.localCache.get(cacheKey);
      if (Date.now() < cached.expiry) {
        return cached.value;
      }
    }
    
    // 从 Redis 读取
    try {
      if (!this.isConnected) {
        logger.warn('Config center disconnected, using cached value', { key });
        return this.localCache.get(cacheKey)?.value ?? defaultValue;
      }
      
      const value = await this.redis.hget('config:values', cacheKey);
      
      if (value === null) {
        return defaultValue;
      }
      
      const config = JSON.parse(value);
      
      // 解密敏感配置
      if (config.encrypted) {
        config.value = this.decrypt(config.value);
      }
      
      // 更新本地缓存
      this.updateLocalCache(cacheKey, config.value);
      
      return config.value;
      
    } catch (error) {
      logger.error('Failed to get config', { key, error: error.message });
      return this.localCache.get(cacheKey)?.value ?? defaultValue;
    }
  }
  
  // 批量获取配置
  async mget(keys) {
    const results = {};
    
    await Promise.all(
      keys.map(async (key) => {
        results[key] = await this.get(key);
      })
    );
    
    return results;
  }
  
  // 设置配置
  async set(key, value, options = {}) {
    const {
      encrypted = false,
      version = null,
      description = '',
      changedBy = 'system'
    } = options;
    
    const cacheKey = this.buildCacheKey(key);
    const timestamp = Date.now();
    const newVersion = version || this.generateVersion();
    
    let configValue = value;
    let configEncrypted = encrypted;
    
    // 自动检测敏感配置
    if (this.isSensitiveKey(key) && !encrypted) {
      configEncrypted = true;
      configValue = this.encrypt(value);
      logger.info('Auto-encrypting sensitive config', { key });
    } else if (encrypted) {
      configValue = this.encrypt(value);
    }
    
    const config = {
      key,
      value: configValue,
      encrypted: configEncrypted,
      version: newVersion,
      description,
      changedBy,
      updatedAt: timestamp,
      createdAt: timestamp
    };
    
    try {
      // 保存配置值
      await this.redis.hset('config:values', cacheKey, JSON.stringify(config));
      
      // 记录版本历史
      await this.redis.lpush(
        `config:history:${cacheKey}`,
        JSON.stringify({
          version: newVersion,
          value: configValue,
          encrypted: configEncrypted,
          changedBy,
          timestamp
        })
      );
      
      // 保留最近 50 个版本
      await this.redis.ltrim(`config:history:${cacheKey}`, 0, 49);
      
      // 发布变更通知
      await this.redis.publish('config:changes', JSON.stringify({
        key: cacheKey,
        version: newVersion,
        timestamp,
        changedBy
      }));
      
      // 更新本地缓存
      this.updateLocalCache(cacheKey, value);
      
      // 记录审计日志
      await this.logAudit('set', key, {
        version: newVersion,
        changedBy,
        encrypted: configEncrypted
      });
      
      logger.info('Config updated', { key, version: newVersion, changedBy });
      
      this.emit('config-changed', { key: cacheKey, value, version: newVersion });
      
      return { success: true, version: newVersion };
      
    } catch (error) {
      logger.error('Failed to set config', { key, error: error.message });
      throw error;
    }
  }
  
  // 删除配置
  async delete(key, options = {}) {
    const { changedBy = 'system' } = options;
    const cacheKey = this.buildCacheKey(key);
    
    try {
      const value = await this.redis.hget('config:values', cacheKey);
      
      await this.redis.hdel('config:values', cacheKey);
      
      // 记录删除历史
      await this.redis.lpush(
        `config:history:${cacheKey}`,
        JSON.stringify({
          action: 'delete',
          previousValue: value ? JSON.parse(value) : null,
          changedBy,
          timestamp: Date.now()
        })
      );
      
      // 发布删除通知
      await this.redis.publish('config:changes', JSON.stringify({
        key: cacheKey,
        action: 'delete',
        timestamp: Date.now()
      }));
      
      // 清除本地缓存
      this.localCache.delete(cacheKey);
      
      await this.logAudit('delete', key, { changedBy });
      
      logger.info('Config deleted', { key, changedBy });
      
      this.emit('config-deleted', { key: cacheKey });
      
      return { success: true };
      
    } catch (error) {
      logger.error('Failed to delete config', { key, error: error.message });
      throw error;
    }
  }
  
  // 回滚配置
  async rollback(key, targetVersion, options = {}) {
    const { changedBy = 'system' } = options;
    const cacheKey = this.buildCacheKey(key);
    
    try {
      // 获取历史版本
      const history = await this.redis.lrange(`config:history:${cacheKey}`, 0, 49);
      
      const targetEntry = history
        .map(h => JSON.parse(h))
        .find(h => h.version === targetVersion);
      
      if (!targetEntry) {
        throw new Error(`Version ${targetVersion} not found`);
      }
      
      // 恢复配置
      await this.set(key, targetEntry.encrypted ? this.decrypt(targetEntry.value) : targetEntry.value, {
        encrypted: targetEntry.encrypted,
        description: `Rollback to version ${targetVersion}`,
        changedBy
      });
      
      await this.logAudit('rollback', key, {
        targetVersion,
        changedBy
      });
      
      logger.info('Config rolled back', { key, targetVersion, changedBy });
      
      return { success: true, version: targetVersion };
      
    } catch (error) {
      logger.error('Failed to rollback config', { key, targetVersion, error: error.message });
      throw error;
    }
  }
  
  // 启动配置变更监听
  async startWatching() {
    const subscriber = new Redis(this.options.redisUrl);
    
    subscriber.subscribe('config:changes', (error) => {
      if (error) {
        logger.error('Failed to subscribe to config changes', { error: error.message });
        return;
      }
      logger.info('Subscribed to config changes');
    });
    
    subscriber.on('message', (channel, message) => {
      if (channel !== 'config:changes') return;
      
      try {
        const change = JSON.parse(message);
        this.handleConfigChange(change);
      } catch (error) {
        logger.error('Failed to handle config change', { error: error.message });
      }
    });
    
    this.watchers.set('redis', subscriber);
  }
  
  // 处理配置变更
  async handleConfigChange(change) {
    const { key, action, version } = change;
    
    logger.info('Config change received', { key, action, version });
    
    // 清除本地缓存
    this.localCache.delete(key);
    
    // 重新加载配置
    if (action !== 'delete') {
      await this.get(key);
    }
    
    // 触发配置更新回调
    this.emit('config-updated', change);
  }
  
  // 注册配置变更监听器
  onConfigChange(keyPattern, callback) {
    this.on('config-updated', (change) => {
      if (this.matchPattern(change.key, keyPattern)) {
        callback(change);
      }
    });
  }
  
  // 本地缓存管理
  updateLocalCache(key, value) {
    this.localCache.set(key, {
      value,
      expiry: Date.now() + this.options.cacheTTL * 1000
    });
  }
  
  async loadLocalCache() {
    try {
      const cacheFile = `/tmp/config-cache-${process.env.SERVICE_NAME || 'default'}.json`;
      const fs = require('fs').promises;
      
      if (require('fs').existsSync(cacheFile)) {
        const data = await fs.readFile(cacheFile, 'utf8');
        const cache = JSON.parse(data);
        
        for (const [key, value] of Object.entries(cache)) {
          this.localCache.set(key, {
            value: value.value,
            expiry: Date.now() + this.options.cacheTTL * 1000
          });
        }
        
        logger.info('Loaded config from local cache', { count: this.localCache.size });
      }
    } catch (error) {
      logger.warn('Failed to load local config cache', { error: error.message });
    }
  }
  
  async saveLocalCache() {
    try {
      const cacheFile = `/tmp/config-cache-${process.env.SERVICE_NAME || 'default'}.json`;
      const fs = require('fs').promises;
      
      const cache = {};
      for (const [key, value] of this.localCache.entries()) {
        cache[key] = value;
      }
      
      await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
      
    } catch (error) {
      logger.warn('Failed to save local config cache', { error: error.message });
    }
  }
  
  // 加密/解密
  encrypt(value) {
    const iv = Crypto.randomBytes(16);
    const cipher = Crypto.createCipheriv(
      'aes-256-gcm',
      Buffer.from(this.options.encryptionKey, 'hex'),
      iv
    );
    
    let encrypted = cipher.update(JSON.stringify(value), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      iv: iv.toString('hex'),
      data: encrypted,
      tag: authTag.toString('hex')
    };
  }
  
  decrypt(encryptedValue) {
    const decipher = Crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(this.options.encryptionKey, 'hex'),
      Buffer.from(encryptedValue.iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(encryptedValue.tag, 'hex'));
    
    let decrypted = decipher.update(encryptedValue.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  }
  
  // 敏感配置检测
  isSensitiveKey(key) {
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /api[_-]?key/i,
      /token/i,
      /credential/i,
      /private[_-]?key/i,
      /access[_-]?key/i
    ];
    
    return sensitivePatterns.some(pattern => pattern.test(key));
  }
  
  // 版本生成
  generateVersion() {
    return `v${Date.now()}-${Crypto.randomBytes(4).toString('hex')}`;
  }
  
  // 缓存键构建
  buildCacheKey(key) {
    const env = process.env.NODE_ENV || 'development';
    const service = process.env.SERVICE_NAME || 'default';
    return `${env}:${service}:${key}`;
  }
  
  // 模式匹配
  matchPattern(str, pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(str);
  }
  
  // 审计日志
  async logAudit(action, key, details) {
    const auditLog = {
      action,
      key,
      ...details,
      timestamp: Date.now(),
      service: process.env.SERVICE_NAME,
      environment: process.env.NODE_ENV
    };
    
    await this.redis.lpush('config:audit', JSON.stringify(auditLog));
    await this.redis.ltrim('config:audit', 0, 9999); // 保留最近 10000 条
    
    logger.info('Config audit logged', auditLog);
  }
  
  // 健康检查
  async healthCheck() {
    try {
      const start = Date.now();
      await this.redis.ping();
      const latency = Date.now() - start;
      
      return {
        status: 'healthy',
        connected: this.isConnected,
        latency,
        cacheSize: this.localCache.size
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        connected: false,
        error: error.message
      };
    }
  }
  
  // 关闭连接
  async close() {
    await this.saveLocalCache();
    
    for (const [name, watcher] of this.watchers.entries()) {
      await watcher.quit();
      logger.info('Config watcher closed', { name });
    }
    
    if (this.redis) {
      await this.redis.quit();
    }
    
    logger.info('Config center closed');
  }
}

module.exports = ConfigCenter;
```

### 2. 配置热更新中间件

```javascript
// backend/shared/configCenter/ConfigReloader.js
class ConfigReloader {
  constructor(configCenter) {
    this.configCenter = configCenter;
    this.callbacks = new Map();
    this.reloading = false;
  }
  
  // 注册配置重载回调
  register(key, callback) {
    if (!this.callbacks.has(key)) {
      this.callbacks.set(key, []);
    }
    this.callbacks.get(key).push(callback);
    
    logger.info('Config reload callback registered', { key });
  }
  
  // 触发配置重载
  async reload(key, newValue) {
    if (this.reloading) {
      logger.warn('Config reload in progress, skipping', { key });
      return;
    }
    
    this.reloading = true;
    
    try {
      const callbacks = this.callbacks.get(key) || [];
      
      logger.info('Reloading config', { key, callbacksCount: callbacks.length });
      
      for (const callback of callbacks) {
        try {
          await callback(newValue, key);
          logger.info('Config reload callback executed', { key });
        } catch (error) {
          logger.error('Config reload callback failed', {
            key,
            error: error.message
          });
        }
      }
      
    } finally {
      this.reloading = false;
    }
  }
  
  // 批量重载
  async reloadAll() {
    const keys = Array.from(this.callbacks.keys());
    
    logger.info('Reloading all configs', { count: keys.length });
    
    for (const key of keys) {
      const value = await this.configCenter.get(key);
      await this.reload(key, value);
    }
  }
}

module.exports = ConfigReloader;
```

### 3. 配置管理 API

```javascript
// gateway/routes/configRoutes.js
const express = require('express');
const router = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const ConfigCenter = require('../../shared/configCenter/ConfigCenter');

const configCenter = new ConfigCenter();

// 获取配置
router.get('/:key', auth, async (req, res) => {
  try {
    const { key } = req.params;
    const value = await configCenter.get(key);
    
    res.json({
      success: true,
      data: { key, value }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 设置配置
router.put('/:key', auth, requireRole('admin'), async (req, res) => {
  try {
    const { key } = req.params;
    const { value, encrypted, description } = req.body;
    
    const result = await configCenter.set(key, value, {
      encrypted,
      description,
      changedBy: req.user.id
    });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 删除配置
router.delete('/:key', auth, requireRole('admin'), async (req, res) => {
  try {
    const { key } = req.params;
    
    await configCenter.delete(key, { changedBy: req.user.id });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取配置历史
router.get('/:key/history', auth, requireRole('admin'), async (req, res) => {
  try {
    const { key } = req.params;
    const { limit = 20 } = req.query;
    
    const history = await configCenter.getHistory(key, parseInt(limit));
    
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 回滚配置
router.post('/:key/rollback', auth, requireRole('admin'), async (req, res) => {
  try {
    const { key } = req.params;
    const { version } = req.body;
    
    const result = await configCenter.rollback(key, version, {
      changedBy: req.user.id
    });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
```

### 4. 配置管理后台

```javascript
// admin-dashboard/pages/ConfigManagement.jsx
import React, { useState, useEffect } from 'react';
import { Table, Button, Modal, Form, Input, Switch, message, Tag } from 'antd';
import { ReloadOutlined, HistoryOutlined, DeleteOutlined } from '@ant-design/icons';

export default function ConfigManagement() {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [historyModalVisible, setHistoryModalVisible] = useState(false);
  const [currentConfig, setCurrentConfig] = useState(null);
  const [history, setHistory] = useState([]);
  const [form] = Form.useForm();
  
  useEffect(() => {
    loadConfigs();
  }, []);
  
  const loadConfigs = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/configs');
      const data = await response.json();
      setConfigs(data.data || []);
    } catch (error) {
      message.error('Failed to load configs');
    } finally {
      setLoading(false);
    }
  };
  
  const handleEdit = (record) => {
    setCurrentConfig(record);
    form.setFieldsValue(record);
    setEditModalVisible(true);
  };
  
  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      
      await fetch(`/api/admin/configs/${currentConfig.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      
      message.success('Config updated successfully');
      setEditModalVisible(false);
      loadConfigs();
      
    } catch (error) {
      message.error('Failed to update config');
    }
  };
  
  const handleDelete = async (key) => {
    Modal.confirm({
      title: 'Confirm Delete',
      content: `Are you sure you want to delete config "${key}"?`,
      onOk: async () => {
        try {
          await fetch(`/api/admin/configs/${key}`, { method: 'DELETE' });
          message.success('Config deleted');
          loadConfigs();
        } catch (error) {
          message.error('Failed to delete config');
        }
      }
    });
  };
  
  const loadHistory = async (key) => {
    try {
      const response = await fetch(`/api/admin/configs/${key}/history`);
      const data = await response.json();
      setHistory(data.data || []);
      setHistoryModalVisible(true);
    } catch (error) {
      message.error('Failed to load history');
    }
  };
  
  const handleRollback = async (key, version) => {
    try {
      await fetch(`/api/admin/configs/${key}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version })
      });
      
      message.success('Config rolled back successfully');
      setHistoryModalVisible(false);
      loadConfigs();
    } catch (error) {
      message.error('Failed to rollback config');
    }
  };
  
  const columns = [
    {
      title: 'Key',
      dataIndex: 'key',
      key: 'key',
      render: (text) => <code>{text}</code>
    },
    {
      title: 'Value',
      dataIndex: 'value',
      key: 'value',
      ellipsis: true,
      render: (text, record) => (
        record.encrypted ? '••••••••' : String(text).substring(0, 50)
      )
    },
    {
      title: 'Encrypted',
      dataIndex: 'encrypted',
      key: 'encrypted',
      render: (encrypted) => (
        <Tag color={encrypted ? 'green' : 'default'}>
          {encrypted ? 'Yes' : 'No'}
        </Tag>
      )
    },
    {
      title: 'Version',
      dataIndex: 'version',
      key: 'version'
    },
    {
      title: 'Updated',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      render: (timestamp) => new Date(timestamp).toLocaleString()
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <div className="flex gap-2">
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => handleEdit(record)}
          >
            Edit
          </Button>
          <Button
            size="small"
            icon={<HistoryOutlined />}
            onClick={() => loadHistory(record.key)}
          >
            History
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.key)}
          >
            Delete
          </Button>
        </div>
      )
    }
  ];
  
  return (
    <div className="p-6">
      <div className="mb-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold">Config Management</h1>
        <Button type="primary" onClick={loadConfigs}>
          Refresh
        </Button>
      </div>
      
      <Table
        dataSource={configs}
        columns={columns}
        loading={loading}
        rowKey="key"
        pagination={{ pageSize: 20 }}
      />
      
      <Modal
        title="Edit Config"
        open={editModalVisible}
        onOk={handleSave}
        onCancel={() => setEditModalVisible(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="key" label="Key">
            <Input disabled />
          </Form.Item>
          <Form.Item name="value" label="Value">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item name="encrypted" label="Encrypt" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
      
      <Modal
        title="Config History"
        open={historyModalVisible}
        onCancel={() => setHistoryModalVisible(false)}
        footer={null}
        width={800}
      >
        <Table
          dataSource={history}
          rowKey="version"
          pagination={false}
          columns={[
            { title: 'Version', dataIndex: 'version', key: 'version' },
            {
              title: 'Changed By',
              dataIndex: 'changedBy',
              key: 'changedBy'
            },
            {
              title: 'Time',
              dataIndex: 'timestamp',
              key: 'timestamp',
              render: (ts) => new Date(ts).toLocaleString()
            },
            {
              title: 'Actions',
              key: 'actions',
              render: (_, record) => (
                <Button
                  size="small"
                  onClick={() => handleRollback(currentConfig?.key, record.version)}
                >
                  Rollback
                </Button>
              )
            }
          ]}
        />
      </Modal>
    </div>
  );
}
```

### 5. 服务集成示例

```javascript
// backend/services/user-service/index.js
const ConfigCenter = require('../../shared/configCenter/ConfigCenter');
const ConfigReloader = require('../../shared/configCenter/ConfigReloader');

// 初始化配置中心
const configCenter = new ConfigCenter();
const configReloader = new ConfigReloader(configCenter);

// 启动时加载配置
async function initializeConfig() {
  await configCenter.initialize();
  
  // 注册配置热更新回调
  configCenter.onConfigChange('jwt:expiry', async (change) => {
    const newExpiry = await configCenter.get('jwt:expiry');
    process.env.JWT_EXPIRY = newExpiry;
    logger.info('JWT expiry updated', { newExpiry });
  });
  
  configCenter.onConfigChange('rateLimit:*', async (change) => {
    const newLimit = await configCenter.get(change.key);
    // 动态调整限流配置
    rateLimiter.updateLimit(change.key, newLimit);
    logger.info('Rate limit updated', { key: change.key, newLimit });
  });
  
  // 注册服务特定配置重载
  configReloader.register('cache:user', async (newValue) => {
    userCache.setTTL(newValue.ttl);
    logger.info('User cache TTL updated', { ttl: newValue.ttl });
  });
  
  logger.info('Config center initialized');
}

// 获取配置值
const jwtExpiry = await configCenter.get('jwt:expiry', '7d');
const maxConnections = await configCenter.get('database:maxConnections', 100);

// 使用配置
app.use((req, res, next) => {
  req.config = {
    jwtExpiry,
    maxConnections
  };
  next();
});

// 优雅关闭
process.on('SIGTERM', async () => {
  await configCenter.close();
  process.exit(0);
});
```

### 6. Kubernetes ConfigMap/Secret 同步

```yaml
# infrastructure/k8s/config-sync-job.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: config-sync
  namespace: minego
spec:
  schedule: "*/5 * * * *"  # 每 5 分钟同步一次
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: config-sync
            image: minego/config-sync:latest
            env:
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: minego-secrets
                  key: config-redis-url
            - name: CONFIG_ENCRYPTION_KEY
              valueFrom:
                secretKeyRef:
                  name: minego-secrets
                  key: config-encryption-key
          restartPolicy: OnFailure
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: minego-config
  namespace: minego
data:
  # 从配置中心同步的配置
  sync-enabled: "true"
  sync-interval: "300"
```

## 验收标准

- [ ] 配置中心核心功能实现（get/set/delete/history/rollback）
- [ ] 动态配置热更新无需重启服务生效
- [ ] 配置变更审计日志完整，支持追溯
- [ ] 敏感配置自动检测与加密存储
- [ ] 本地缓存机制，配置中心故障不影响服务运行
- [ ] 管理后台 UI 完整，支持配置 CRUD、历史查看、回滚
- [ ] 多环境隔离（dev/staging/prod）
- [ ] 细粒度权限控制（RBAC）
- [ ] 性能测试：配置读取 < 10ms（缓存命中），写入 < 50ms
- [ ] 高可用测试：Redis 故障时服务正常运行
- [ ] 单元测试覆盖率 > 80%
- [ ] 文档完善：使用指南、API 文档、运维手册

## 影响范围

- **新增文件**：
  - `backend/shared/configCenter/ConfigCenter.js`
  - `backend/shared/configCenter/ConfigReloader.js`
  - `gateway/routes/configRoutes.js`
  - `admin-dashboard/pages/ConfigManagement.jsx`
  - `infrastructure/k8s/config-sync-job.yaml`

- **修改服务**：
  - 所有微服务需集成 ConfigCenter（可选，逐步迁移）
  - gateway 新增配置管理 API
  - admin-dashboard 新增配置管理页面

- **依赖服务**：
  - Redis（存储配置）
  - PostgreSQL（可选，持久化备份）

## 参考

- [Spring Cloud Config](https://spring.io/projects/spring-cloud-config)
- [Consul KV Store](https://www.consul.io/docs/dynamic-app-config/kv)
- [etcd](https://etcd.io/docs/)
- [Apollo Configuration Center](https://github.com/apolloconfig/apollo)
