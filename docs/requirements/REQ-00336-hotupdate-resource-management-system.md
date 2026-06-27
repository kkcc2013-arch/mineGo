# REQ-00336: 精灵资源动态更新与热修复系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00336 |
| 标题 | 精灵资源动态更新与热修复系统 |
| 类别 | 前端体验/运维 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、gateway、pokemon-service、location-service、backend/jobs、cdn |
| 创建时间 | 2026-06-26 08:00 UTC |

## 需求描述

实现一个精灵资源动态更新与热修复系统，允许在不发布新版本APP的情况下动态更新游戏资源、修复bug、调整数值平衡。该系统支持：

1. **资源热更新**：精灵图片、音效、配置文件等资源的动态更新
2. **脚本热修复**：JavaScript脚本的实时修复与更新
3. **数值动态调整**：精灵属性、技能参数、刷新概率等数值的远程调整
4. **AB测试支持**：灰度发布新功能，支持按用户群体分流
5. **版本管理**：资源版本控制、增量更新、回滚机制
6. **安全验证**：资源签名验证、防篡改机制

### 核心价值

- **快速响应**：紧急bug修复无需应用商店审核，分钟级上线
- **运营灵活**：活动数值调整、精灵刷新率优化实时生效
- **风险控制**：支持灰度发布、快速回滚，降低发布风险
- **用户体验**：减少强制更新，提升用户留存

## 技术方案

### 1. 资源版本管理系统

```javascript
// backend/shared/ResourceVersionManager.js

const crypto = require('crypto');

class ResourceVersionManager {
  constructor(redisClient, dbClient) {
    this.redis = redisClient;
    this.db = dbClient;
    this.resourceTypes = {
      POKEMON_SPRITES: 'sprites',
      AUDIO_FILES: 'audio',
      CONFIG_DATA: 'config',
      SCRIPT_PATCHES: 'scripts',
      LOCALIZATION: 'i18n'
    };
  }

  /**
   * 发布新版本资源
   */
  async publishResourceVersion(resourceType, version, files, options = {}) {
    const {
      targetUsers = 'all', // 'all' | 'gradual' | 'ab_test'
      rolloutPercentage = 100,
      minClientVersion = '1.0.0',
      description = ''
    } = options;

    // 生成资源清单和校验和
    const manifest = await this.generateManifest(files);
    
    // 签名资源
    const signature = this.signManifest(manifest);
    
    // 存储版本信息
    const versionRecord = {
      id: crypto.randomUUID(),
      resource_type: resourceType,
      version: version,
      manifest: manifest,
      signature: signature,
      target_users: targetUsers,
      rollout_percentage: rolloutPercentage,
      min_client_version: minClientVersion,
      description: description,
      status: 'active',
      created_at: new Date(),
      created_by: options.userId
    };

    await this.db.query(`
      INSERT INTO resource_versions 
      (id, resource_type, version, manifest, signature, target_users, 
       rollout_percentage, min_client_version, description, status, created_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      versionRecord.id, versionRecord.resource_type, versionRecord.version,
      JSON.stringify(versionRecord.manifest), versionRecord.signature,
      versionRecord.target_users, versionRecord.rollout_percentage,
      versionRecord.min_client_version, versionRecord.description,
      versionRecord.status, versionRecord.created_at, versionRecord.created_by
    ]);

    // 缓存最新版本信息
    await this.cacheLatestVersion(resourceType, versionRecord);

    // 发布事件通知客户端
    await this.publishUpdateEvent(resourceType, versionRecord);

    return versionRecord;
  }

  /**
   * 生成资源清单
   */
  async generateManifest(files) {
    const manifest = {
      version: Date.now(),
      files: [],
      checksums: {}
    };

    for (const file of files) {
      const fileHash = crypto
        .createHash('sha256')
        .update(file.content)
        .digest('hex');

      manifest.files.push({
        path: file.path,
        size: file.content.length,
        hash: fileHash,
        compressed: file.compressed || false
      });

      manifest.checksums[file.path] = fileHash;
    }

    return manifest;
  }

  /**
   * 签名资源清单
   */
  signManifest(manifest) {
    const manifestString = JSON.stringify(manifest);
    const privateKey = process.env.RESOURCE_SIGNING_KEY;
    
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(manifestString);
    
    return signer.sign(privateKey, 'base64');
  }

  /**
   * 获取客户端可用的资源版本
   */
  async getClientResourceVersion(resourceType, clientVersion, userId) {
    // 获取最新版本
    const latestVersion = await this.getLatestVersion(resourceType);
    
    if (!latestVersion) {
      return null;
    }

    // 检查客户端版本兼容性
    if (!this.isClientCompatible(latestVersion.min_client_version, clientVersion)) {
      // 返回兼容的旧版本
      return await this.getCompatibleVersion(resourceType, clientVersion);
    }

    // 检查灰度发布
    if (latestVersion.target_users === 'gradual') {
      const isInRollout = await this.isUserInRollout(userId, latestVersion);
      if (!isInRollout) {
        return await this.getPreviousVersion(resourceType);
      }
    }

    // AB测试分流
    if (latestVersion.target_users === 'ab_test') {
      const abTestVersion = await this.getABTestVersion(userId, resourceType);
      return abTestVersion || latestVersion;
    }

    return latestVersion;
  }

  /**
   * 灰度发布用户检查
   */
  async isUserInRollout(userId, version) {
    // 使用一致性哈希确保同一用户始终命中同一版本
    const hash = crypto
      .createHash('md5')
      .update(userId + version.id)
      .digest('hex');
    
    const hashValue = parseInt(hash.substring(0, 8), 16);
    const percentage = (hashValue / 0xFFFFFFFF) * 100;
    
    return percentage <= version.rollout_percentage;
  }

  /**
   * 增量更新计算
   */
  async calculateIncrementalUpdate(currentVersion, targetVersion) {
    const currentManifest = await this.getVersionManifest(currentVersion);
    const targetManifest = await this.getVersionManifest(targetVersion);

    const added = [];
    const modified = [];
    const deleted = [];

    // 检测新增和修改的文件
    for (const file of targetManifest.files) {
      const currentFile = currentManifest.files.find(f => f.path === file.path);
      
      if (!currentFile) {
        added.push(file);
      } else if (currentFile.hash !== file.hash) {
        modified.push(file);
      }
    }

    // 检测删除的文件
    for (const file of currentManifest.files) {
      const targetFile = targetManifest.files.find(f => f.path === file.path);
      if (!targetFile) {
        deleted.push(file.path);
      }
    }

    return {
      added,
      modified,
      deleted,
      totalSize: [...added, ...modified].reduce((sum, f) => sum + f.size, 0)
    };
  }

  /**
   * 回滚到指定版本
   */
  async rollback(resourceType, targetVersion) {
    // 停用当前版本
    await this.db.query(`
      UPDATE resource_versions 
      SET status = 'rolled_back', rolled_back_at = $1
      WHERE resource_type = $2 AND status = 'active'
    `, [new Date(), resourceType]);

    // 激活目标版本
    await this.db.query(`
      UPDATE resource_versions 
      SET status = 'active', activated_at = $1
      WHERE resource_type = $2 AND version = $3
    `, [new Date(), resourceType, targetVersion]);

    // 更新缓存
    await this.cacheLatestVersion(resourceType, null);
    
    // 发布回滚通知
    await this.publishRollbackEvent(resourceType, targetVersion);
  }
}

module.exports = ResourceVersionManager;
```

### 2. 热更新管理器（客户端）

```javascript
// frontend/game-client/src/hotupdate/HotUpdateManager.js

class HotUpdateManager {
  constructor() {
    this.currentVersions = new Map();
    this.pendingUpdates = [];
    this.updateInProgress = false;
    this.resourceCache = new Map();
    
    // 资源类型
    this.resourceTypes = {
      SPRITES: 'sprites',
      AUDIO: 'audio',
      CONFIG: 'config',
      SCRIPTS: 'scripts',
      I18N: 'i18n'
    };

    // 更新策略
    this.updateStrategy = {
      AUTO: 'auto',           // 自动下载安装
      PROMPT: 'prompt',       // 提示用户
      WIFI_ONLY: 'wifi_only', // 仅WiFi下载
      MANUAL: 'manual'        // 手动触发
    };

    this.config = {
      checkInterval: 30 * 60 * 1000, // 30分钟检查一次
      maxRetryAttempts: 3,
      downloadTimeout: 60000,
      verifyChecksum: true
    };

    this.init();
  }

  async init() {
    // 加载本地资源版本
    await this.loadLocalVersions();
    
    // 启动定期检查
    this.startPeriodicCheck();
    
    // 监听网络状态
    this.setupNetworkListener();
  }

  /**
   * 检查资源更新
   */
  async checkForUpdates() {
    try {
      const clientVersion = await this.getClientVersion();
      const userId = await this.getUserId();

      const response = await fetch('/api/hotupdate/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Version': clientVersion,
          'X-User-ID': userId
        },
        body: JSON.stringify({
          current_versions: Object.fromEntries(this.currentVersions)
        })
      });

      if (!response.ok) {
        throw new Error('Failed to check updates');
      }

      const updateInfo = await response.json();

      if (updateInfo.has_updates) {
        await this.handleUpdateAvailable(updateInfo);
      }

      return updateInfo;

    } catch (error) {
      console.error('Hot update check failed:', error);
      return { has_updates: false, error: error.message };
    }
  }

  /**
   * 处理可用更新
   */
  async handleUpdateAvailable(updateInfo) {
    const {
      resource_type,
      version,
      manifest,
      signature,
      update_strategy,
      critical
    } = updateInfo;

    // 验证签名
    if (this.config.verifyChecksum && !await this.verifySignature(manifest, signature)) {
      console.error('Update signature verification failed');
      return false;
    }

    // 根据更新策略处理
    switch (update_strategy) {
      case this.updateStrategy.AUTO:
        await this.downloadAndApplyUpdate(updateInfo);
        break;

      case this.updateStrategy.PROMPT:
        await this.promptUserForUpdate(updateInfo);
        break;

      case this.updateStrategy.WIFI_ONLY:
        if (this.isWiFiConnected()) {
          await this.downloadAndApplyUpdate(updateInfo);
        } else {
          this.pendingUpdates.push(updateInfo);
        }
        break;

      case this.updateStrategy.MANUAL:
        this.pendingUpdates.push(updateInfo);
        break;
    }

    // 关键更新立即处理
    if (critical) {
      await this.downloadAndApplyUpdate(updateInfo);
    }

    return true;
  }

  /**
   * 下载并应用更新
   */
  async downloadAndApplyUpdate(updateInfo) {
    if (this.updateInProgress) {
      console.log('Update already in progress');
      return false;
    }

    this.updateInProgress = true;

    try {
      const { resource_type, version, manifest, incremental } = updateInfo;

      // 计算需要下载的文件
      const filesToDownload = incremental 
        ? await this.calculateIncrementalFiles(resource_type, manifest)
        : manifest.files;

      // 下载资源文件
      const downloadedFiles = await this.downloadResourceFiles(
        resource_type,
        filesToDownload,
        (progress) => {
          this.emitProgress(resource_type, progress);
        }
      );

      // 验证下载的文件
      await this.verifyDownloadedFiles(downloadedFiles, manifest);

      // 应用更新
      await this.applyUpdate(resource_type, version, downloadedFiles);

      // 更新本地版本信息
      this.currentVersions.set(resource_type, version);
      await this.saveLocalVersions();

      // 清理旧资源
      await this.cleanupOldResources(resource_type, version);

      // 发送更新完成通知
      this.emitUpdateComplete(resource_type, version);

      return true;

    } catch (error) {
      console.error('Update failed:', error);
      await this.handleUpdateError(error);
      return false;

    } finally {
      this.updateInProgress = false;
    }
  }

  /**
   * 下载资源文件
   */
  async downloadResourceFiles(resourceType, files, onProgress) {
    const downloadedFiles = [];
    let totalSize = files.reduce((sum, f) => sum + f.size, 0);
    let downloadedSize = 0;

    for (const file of files) {
      const startTime = Date.now();

      const response = await fetch(file.url, {
        headers: {
          'X-Resource-Type': resourceType,
          'X-File-Path': file.path
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to download ${file.path}`);
      }

      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();

      // 验证文件完整性
      const hash = await this.calculateHash(arrayBuffer);
      if (hash !== file.hash) {
        throw new Error(`File integrity check failed: ${file.path}`);
      }

      downloadedFiles.push({
        path: file.path,
        data: arrayBuffer,
        hash: hash,
        size: arrayBuffer.byteLength
      });

      downloadedSize += arrayBuffer.byteLength;
      
      onProgress({
        file: file.path,
        progress: (downloadedSize / totalSize) * 100,
        speed: this.calculateDownloadSpeed(downloadedSize, startTime)
      });
    }

    return downloadedFiles;
  }

  /**
   * 应用更新
   */
  async applyUpdate(resourceType, version, files) {
    switch (resourceType) {
      case this.resourceTypes.SPRITES:
        await this.applySpriteUpdate(files);
        break;

      case this.resourceTypes.AUDIO:
        await this.applyAudioUpdate(files);
        break;

      case this.resourceTypes.CONFIG:
        await this.applyConfigUpdate(files);
        break;

      case this.resourceTypes.SCRIPTS:
        await this.applyScriptUpdate(files);
        break;

      case this.resourceTypes.I18N:
        await this.applyI18nUpdate(files);
        break;

      default:
        console.warn(`Unknown resource type: ${resourceType}`);
    }
  }

  /**
   * 应用脚本热更新
   */
  async applyScriptUpdate(files) {
    for (const file of files) {
      try {
        // 创建 Blob URL
        const blob = new Blob([file.data], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);

        // 动态加载脚本
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => {
          console.log(`Script updated: ${file.path}`);
          URL.revokeObjectURL(url);
        };
        script.onerror = (error) => {
          console.error(`Failed to load script: ${file.path}`, error);
          URL.revokeObjectURL(url);
        };

        document.head.appendChild(script);

        // 存储到 IndexedDB 用于离线
        await this.storeResourceInIndexedDB('scripts', file.path, file.data);

      } catch (error) {
        console.error(`Failed to apply script update: ${file.path}`, error);
      }
    }
  }

  /**
   * 应用配置更新
   */
  async applyConfigUpdate(files) {
    for (const file of files) {
      try {
        const configData = JSON.parse(new TextDecoder().decode(file.data));
        
        // 合并或替换配置
        const currentConfig = await this.loadConfig(file.path);
        const mergedConfig = this.mergeConfig(currentConfig, configData);
        
        // 存储配置
        await this.storeConfig(file.path, mergedConfig);
        
        // 通知配置更新
        window.dispatchEvent(new CustomEvent('configUpdated', {
          detail: { path: file.path, config: mergedConfig }
        }));

      } catch (error) {
        console.error(`Failed to apply config update: ${file.path}`, error);
      }
    }
  }

  /**
   * 验证签名
   */
  async verifySignature(manifest, signature) {
    try {
      const publicKey = await this.getPublicKey();
      const verifier = crypto.createVerify('RSA-SHA256');
      
      verifier.update(JSON.stringify(manifest));
      
      return verifier.verify(publicKey, signature, 'base64');
    } catch (error) {
      console.error('Signature verification error:', error);
      return false;
    }
  }

  /**
   * 回滚到上一个版本
   */
  async rollback(resourceType) {
    const previousVersion = await this.getPreviousVersion(resourceType);
    
    if (!previousVersion) {
      console.warn('No previous version to rollback to');
      return false;
    }

    // 恢复旧版本资源
    const resources = await this.loadVersionResources(resourceType, previousVersion);
    await this.applyUpdate(resourceType, previousVersion, resources);

    this.currentVersions.set(resourceType, previousVersion);
    await this.saveLocalVersions();

    this.emitRollbackComplete(resourceType, previousVersion);
    
    return true;
  }

  /**
   * 启动定期检查
   */
  startPeriodicCheck() {
    setInterval(async () => {
      if (!this.updateInProgress) {
        await this.checkForUpdates();
      }
    }, this.config.checkInterval);
  }

  /**
   * 监听网络状态
   */
  setupNetworkListener() {
    // WiFi连接后检查待处理更新
    window.addEventListener('online', async () => {
      if (this.isWiFiConnected() && this.pendingUpdates.length > 0) {
        for (const update of this.pendingUpdates) {
          await this.downloadAndApplyUpdate(update);
        }
        this.pendingUpdates = [];
      }
    });
  }

  /**
   * 事件发射
   */
  emitProgress(resourceType, progress) {
    window.dispatchEvent(new CustomEvent('hotUpdateProgress', {
      detail: { resourceType, progress }
    }));
  }

  emitUpdateComplete(resourceType, version) {
    window.dispatchEvent(new CustomEvent('hotUpdateComplete', {
      detail: { resourceType, version }
    }));
  }

  emitRollbackComplete(resourceType, version) {
    window.dispatchEvent(new CustomEvent('hotUpdateRollback', {
      detail: { resourceType, version }
    }));
  }
}

module.exports = HotUpdateManager;
```

### 3. 热更新API路由

```javascript
// backend/gateway/src/routes/hotupdate.js

const express = require('express');
const router = express.Router();
const ResourceVersionManager = require('../../shared/ResourceVersionManager');
const { authenticate } = require('../../shared/middleware/auth');

const versionManager = new ResourceVersionManager(
  require('../../shared/redis').getClient(),
  require('../../shared/db').getClient()
);

/**
 * 检查资源更新
 * POST /api/hotupdate/check
 */
router.post('/check', authenticate, async (req, res) => {
  try {
    const { current_versions } = req.body;
    const clientVersion = req.headers['x-client-version'];
    const userId = req.user.id;

    const updates = [];

    // 检查各类型资源更新
    const resourceTypes = ['sprites', 'audio', 'config', 'scripts', 'i18n'];

    for (const type of resourceTypes) {
      const latestVersion = await versionManager.getClientResourceVersion(
        type,
        clientVersion,
        userId
      );

      if (latestVersion && latestVersion.version !== current_versions[type]) {
        // 计算增量更新
        const incremental = await versionManager.calculateIncrementalUpdate(
          current_versions[type],
          latestVersion.version
        );

        updates.push({
          resource_type: type,
          version: latestVersion.version,
          manifest: latestVersion.manifest,
          signature: latestVersion.signature,
          incremental: incremental,
          update_strategy: latestVersion.target_users === 'gradual' ? 'prompt' : 'auto',
          critical: latestVersion.critical || false,
          description: latestVersion.description
        });
      }
    }

    res.json({
      has_updates: updates.length > 0,
      updates: updates
    });

  } catch (error) {
    console.error('Hot update check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 下载资源文件
 * GET /api/hotupdate/download/:resourceType/:filePath
 */
router.get('/download/:resourceType/*', authenticate, async (req, res) => {
  try {
    const { resourceType } = req.params;
    const filePath = req.params[0];
    const version = req.query.version;

    // 验证请求
    const versionInfo = await versionManager.getVersionInfo(resourceType, version);
    if (!versionInfo) {
      return res.status(404).json({ error: 'Version not found' });
    }

    // 获取文件
    const fileData = await versionManager.getResourceFile(resourceType, version, filePath);
    
    if (!fileData) {
      return res.status(404).json({ error: 'File not found' });
    }

    // 设置响应头
    res.setHeader('Content-Type', getContentType(filePath));
    res.setHeader('X-File-Hash', fileData.hash);
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    res.send(fileData.data);

  } catch (error) {
    console.error('Resource download error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 管理员：发布资源更新
 * POST /api/hotupdate/publish
 */
router.post('/publish', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      resource_type,
      version,
      files,
      target_users,
      rollout_percentage,
      min_client_version,
      description
    } = req.body;

    const result = await versionManager.publishResourceVersion(
      resource_type,
      version,
      files,
      {
        targetUsers: target_users,
        rolloutPercentage: rollout_percentage,
        minClientVersion: min_client_version,
        description: description,
        userId: req.user.id
      }
    );

    res.json({
      success: true,
      version_id: result.id,
      version: result.version
    });

  } catch (error) {
    console.error('Publish resource error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 管理员：回滚资源版本
 * POST /api/hotupdate/rollback
 */
router.post('/rollback', authenticate, requireAdmin, async (req, res) => {
  try {
    const { resource_type, target_version } = req.body;

    await versionManager.rollback(resource_type, target_version);

    res.json({
      success: true,
      message: `Rolled back ${resource_type} to version ${target_version}`
    });

  } catch (error) {
    console.error('Rollback error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 管理员：获取版本历史
 * GET /api/hotupdate/versions/:resourceType
 */
router.get('/versions/:resourceType', authenticate, requireAdmin, async (req, res) => {
  try {
    const { resourceType } = req.params;
    const limit = parseInt(req.query.limit) || 20;

    const versions = await versionManager.getVersionHistory(resourceType, limit);

    res.json({
      resource_type: resourceType,
      versions: versions
    });

  } catch (error) {
    console.error('Get version history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 管理员：更新灰度发布比例
 * PATCH /api/hotupdate/rollout
 */
router.patch('/rollout', authenticate, requireAdmin, async (req, res) => {
  try {
    const { resource_type, version, rollout_percentage } = req.body;

    await versionManager.updateRolloutPercentage(
      resource_type,
      version,
      rollout_percentage
    );

    res.json({
      success: true,
      message: `Updated rollout percentage to ${rollout_percentage}%`
    });

  } catch (error) {
    console.error('Update rollout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 获取公钥（用于验证签名）
 * GET /api/hotupdate/public-key
 */
router.get('/public-key', async (req, res) => {
  try {
    const publicKey = await versionManager.getPublicKey();
    res.json({ public_key: publicKey });
  } catch (error) {
    console.error('Get public key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function getContentType(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const contentTypes = {
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'mp3': 'audio/mpeg',
    'ogg': 'audio/ogg',
    'wav': 'audio/wav'
  };
  return contentTypes[ext] || 'application/octet-stream';
}

async function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = router;
```

### 4. 数据库迁移

```javascript
// database/migrations/20260626080000_create_resource_versions.js

exports.up = async (pgm) => {
  // 资源版本表
  pgm.createTable('resource_versions', {
    id: { type: 'uuid', primaryKey: true },
    resource_type: { type: 'varchar(50)', notNull: true },
    version: { type: 'varchar(100)', notNull: true },
    manifest: { type: 'jsonb', notNull: true },
    signature: { type: 'text', notNull: true },
    target_users: { type: 'varchar(20)', notNull: true, default: 'all' },
    rollout_percentage: { type: 'integer', notNull: true, default: 100 },
    min_client_version: { type: 'varchar(20)', notNull: true, default: '1.0.0' },
    description: { type: 'text' },
    status: { 
      type: 'varchar(20)', 
      notNull: true, 
      default: 'active',
      check: "status IN ('active', 'inactive', 'rolled_back')"
    },
    critical: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('now()') },
    created_by: { type: 'uuid', references: 'users' },
    activated_at: { type: 'timestamp' },
    rolled_back_at: { type: 'timestamp' }
  });

  // 索引
  pgm.createIndex('resource_versions', ['resource_type', 'status']);
  pgm.createIndex('resource_versions', ['resource_type', 'version']);
  pgm.createIndex('resource_versions', 'created_at');

  // 资源文件存储表
  pgm.createTable('resource_files', {
    id: { type: 'uuid', primaryKey: true },
    version_id: { 
      type: 'uuid', 
      notNull: true, 
      references: 'resource_versions',
      onDelete: 'CASCADE'
    },
    file_path: { type: 'varchar(500)', notNull: true },
    file_data: { type: 'bytea', notNull: true },
    file_hash: { type: 'varchar(64)', notNull: true },
    file_size: { type: 'integer', notNull: true },
    compressed: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('resource_files', ['version_id', 'file_path']);
  pgm.createIndex('resource_files', 'file_hash');

  // 灰度发布记录表
  pgm.createTable('resource_rollout_records', {
    id: { type: 'uuid', primaryKey: true },
    version_id: { 
      type: 'uuid', 
      notNull: true, 
      references: 'resource_versions',
      onDelete: 'CASCADE'
    },
    user_id: { type: 'uuid', references: 'users' },
    status: { 
      type: 'varchar(20)', 
      notNull: true,
      check: "status IN ('pending', 'downloaded', 'applied', 'failed')"
    },
    downloaded_at: { type: 'timestamp' },
    applied_at: { type: 'timestamp' },
    error_message: { type: 'text' },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('resource_rollout_records', ['version_id', 'user_id']);
  pgm.createIndex('resource_rollout_records', ['status', 'created_at']);

  // AB测试分组表
  pgm.createTable('resource_ab_test_groups', {
    id: { type: 'uuid', primaryKey: true },
    version_id: { 
      type: 'uuid', 
      notNull: true, 
      references: 'resource_versions',
      onDelete: 'CASCADE'
    },
    group_name: { type: 'varchar(50)', notNull: true },
    group_percentage: { type: 'integer', notNull: true },
    config_overrides: { type: 'jsonb' },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('resource_ab_test_groups', ['version_id', 'group_name']);

  // 用户AB测试分组分配表
  pgm.createTable('user_ab_test_assignments', {
    id: { type: 'uuid', primaryKey: true },
    user_id: { type: 'uuid', notNull: true, references: 'users' },
    ab_test_id: { type: 'uuid', notNull: true, references: 'resource_ab_test_groups' },
    assigned_at: { type: 'timestamp', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('user_ab_test_assignments', ['user_id', 'ab_test_id'], { unique: true });
};

exports.down = async (pgm) => {
  pgm.dropTable('user_ab_test_assignments');
  pgm.dropTable('resource_ab_test_groups');
  pgm.dropTable('resource_rollout_records');
  pgm.dropTable('resource_files');
  pgm.dropTable('resource_versions');
};
```

### 5. 热更新任务调度器

```javascript
// backend/jobs/resourceUpdateJob.js

const cron = require('node-cron');
const ResourceVersionManager = require('../shared/ResourceVersionManager');

class ResourceUpdateJob {
  constructor() {
    this.versionManager = new ResourceVersionManager();
  }

  start() {
    // 每小时清理过期资源版本
    cron.schedule('0 * * * *', async () => {
      await this.cleanupOldVersions();
    });

    // 每6小时生成资源使用报告
    cron.schedule('0 */6 * * *', async () => {
      await this.generateResourceReport();
    });

    // 每天凌晨2点备份当前活跃版本
    cron.schedule('0 2 * * *', async () => {
      await this.backupActiveVersions();
    });
  }

  async cleanupOldVersions() {
    console.log('Starting cleanup of old resource versions...');
    
    const resourceTypes = ['sprites', 'audio', 'config', 'scripts', 'i18n'];
    
    for (const type of resourceTypes) {
      // 保留最近10个版本，删除更旧的版本
      const oldVersions = await this.versionManager.getOldVersions(type, 10);
      
      for (const version of oldVersions) {
        await this.versionManager.deleteVersion(version.id);
        console.log(`Deleted old version: ${type} v${version.version}`);
      }
    }
  }

  async generateResourceReport() {
    console.log('Generating resource usage report...');
    
    const report = await this.versionManager.generateUsageReport();
    
    // 发送报告到监控系统
    await this.sendToMonitoring(report);
    
    console.log('Resource report generated');
  }

  async backupActiveVersions() {
    console.log('Backing up active resource versions...');
    
    const resourceTypes = ['sprites', 'audio', 'config', 'scripts', 'i18n'];
    
    for (const type of resourceTypes) {
      const activeVersion = await this.versionManager.getActiveVersion(type);
      
      if (activeVersion) {
        await this.versionManager.backupVersion(activeVersion.id);
        console.log(`Backed up ${type} v${activeVersion.version}`);
      }
    }
  }
}

module.exports = ResourceUpdateJob;
```

## 验收标准

- [ ] 管理员可通过API发布资源新版本，支持多类型资源（精灵图片、音效、配置、脚本、国际化）
- [ ] 客户端启动时自动检查资源更新，支持增量更新和全量更新
- [ ] 资源下载支持进度回调、断点续传、失败重试
- [ ] 所有资源更新经过签名验证，防止篡改
- [ ] 支持灰度发布，可控制发布百分比，使用一致性哈希确保用户分组稳定
- [ ] 支持AB测试，可按用户群体分配不同版本资源
- [ ] 脚本热更新可动态加载新代码，无需重启应用
- [ ] 配置更新实时生效，可动态调整精灵数值、刷新概率等
- [ ] 支持一键回滚到任意历史版本，回滚时间 < 30秒
- [ ] 管理后台提供版本管理界面，显示版本历史、发布状态、灰度进度
- [ ] 定期清理旧版本资源，释放存储空间
- [ ] 资源更新成功率监控，告警阈值可配置
- [ ] 完整的审计日志，记录所有发布、回滚操作

## 影响范围

- **新增文件**：
  - `backend/shared/ResourceVersionManager.js` - 资源版本管理核心
  - `backend/gateway/src/routes/hotupdate.js` - 热更新API路由
  - `frontend/game-client/src/hotupdate/HotUpdateManager.js` - 客户端热更新管理
  - `backend/jobs/resourceUpdateJob.js` - 资源更新任务调度
  - `database/migrations/20260626080000_create_resource_versions.js` - 数据库迁移

- **修改文件**：
  - `backend/gateway/src/index.js` - 注册热更新路由
  - `frontend/game-client/src/index.js` - 初始化热更新管理器
  - `admin-dashboard/src/pages/ResourceManagement.js` - 管理后台新增资源管理页面

- **依赖服务**：
  - PostgreSQL - 存储资源版本元数据
  - Redis - 缓存版本信息、用户分组
  - CDN - 资源文件分发
  - Kafka - 发布资源更新事件

## 参考

- [React Native CodePush 热更新方案](https://github.com/microsoft/react-native-code-push)
- [微信小程序热更新机制](https://developers.weixin.qq.com/miniprogram/framework/runtime/update-mechanism.html)
- [OTA Update Best Practices](https://docs.microsoft.com/en-us/azure/iot-hub/iot-hub-ota-best-practices)
- [Content Delivery Network Security](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)
