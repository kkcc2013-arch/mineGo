# REQ-00178：容器镜像生命周期管理与存储优化系统

- **编号**：REQ-00178
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：infrastructure/k8s、.github/workflows、backend/shared/imageManager.js、backend/jobs、所有微服务
- **创建时间**：2026-06-14 02:00
- **依赖需求**：REQ-00042（基础设施安全扫描）

## 1. 背景与问题

### 1.1 现状分析
当前 mineGo 项目使用阿里云容器镜像仓库（registry.cn-shanghai.aliyuncs.com/pmg/*），但存在以下问题：

1. **镜像堆积问题**：每次 CI/CD 构建都会推送新镜像，旧镜像未自动清理，导致：
   - 镜像仓库存储成本持续增长
   - 镜像列表冗长，难以定位特定版本
   - 保留大量无用镜像增加安全风险

2. **镜像拉取效率低**：
   - 当前 `imagePullPolicy: Always`，每次 Pod 重启都重新拉取镜像
   - 未利用节点本地镜像缓存，增加网络带宽成本
   - 大镜像拉取耗时影响服务启动速度

3. **镜像大小未优化**：
   - 无镜像大小监控，无法发现体积异常增长的镜像
   - 未实施镜像层复用策略
   - 生产镜像可能包含不必要的开发依赖

4. **僵尸镜像清理缺失**：
   - 已删除服务的历史镜像仍占用存储
   - 测试/开发分支构建的镜像未及时清理
   - 无镜像使用情况追踪机制

### 1.2 影响评估
- **存储成本**：按当前构建频率（日均 10+ 次），每月新增镜像约 300+，存储成本月增长约 15%
- **网络成本**：不必要的镜像拉取增加带宽消耗，月均约 5-10GB
- **运维效率**：镜像列表混乱，回滚时难以快速定位目标版本

## 2. 目标

建立完整的容器镜像生命周期管理系统，实现：
1. **自动化清理**：定期清理过期、未使用的镜像，存储成本降低 40%+
2. **智能拉取策略**：根据镜像版本和节点缓存状态动态调整拉取策略，减少 60% 不必要拉取
3. **镜像大小监控**：实时监控各服务镜像大小，异常增长自动告警
4. **版本保留策略**：基于语义化版本和部署频率，智能保留关键版本镜像

## 3. 范围

### 3.1 包含
- 镜像生命周期策略配置系统
- 未使用镜像自动清理 Job
- 镜像大小监控与告警
- 镜像拉取策略优化（IfNotPresent + 版本检测）
- 镜像使用情况追踪与报告
- GitHub Actions 镜像清理集成

### 3.2 不包含
- 镜像构建优化（已有 Dockerfile 优化）
- 镜像安全扫描（REQ-00042 已覆盖）
- 多架构镜像管理（暂不需要）

## 4. 详细需求

### 4.1 镜像生命周期策略配置

```javascript
// backend/shared/imageManager.js
const defaultLifecyclePolicy = {
  // 保留策略
  retention: {
    // 最新 N 个版本始终保留
    keepLatest: 5,
    // 已部署版本额外保留天数
    deployedRetentionDays: 30,
    // 带标签的版本保留策略
    taggedRetention: {
      'production-*': 90,  // 生产标签保留 90 天
      'release-*': 60,     // 发布标签保留 60 天
      'dev-*': 7,          // 开发标签保留 7 天
      'test-*': 3          // 测试标签保留 3 天
    }
  },
  // 清理规则
  cleanup: {
    // 未使用镜像保留天数（未被任何 Pod 引用）
    unusedRetentionDays: 14,
    // 僵尸镜像（对应服务已删除）清理周期
    orphanCleanupDays: 30,
    // 清理执行时间（Cron 表达式）
    schedule: '0 3 * * *'  // 每天凌晨 3 点
  },
  // 大小监控
  sizeMonitoring: {
    // 镜像大小阈值（MB）
    warningThresholdMB: 500,
    criticalThresholdMB: 800,
    // 大小增长告警阈值（相比上一版本增长百分比）
    growthAlertThreshold: 30
  }
};
```

### 4.2 镜像清理 Job

```yaml
# infrastructure/k8s/jobs/image-cleanup.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: image-lifecycle-manager
  namespace: pmg
spec:
  schedule: "0 3 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: image-manager-sa
          containers:
          - name: cleaner
            image: registry.cn-shanghai.aliyuncs.com/pmg/image-manager:latest
            command: ["node", "/app/imageCleaner.js"]
            env:
            - name: DRY_RUN
              value: "false"
            - name: RETENTION_CONFIG
              valueFrom:
                configMapKeyRef:
                  name: image-lifecycle-config
                  key: policy.json
```

### 4.3 镜像使用情况追踪

```javascript
// 追踪镜像引用关系
class ImageUsageTracker {
  constructor() {
    this.usageCache = new Map(); // imageDigest -> { pods, services, lastUsed }
  }

  // 扫描集群中所有 Pod 的镜像使用情况
  async scanImageUsage() {
    const pods = await this.k8sApi.listPodForAllNamespaces();
    const usage = new Map();
    
    for (const pod of pods.body.items) {
      for (const container of pod.spec.containers) {
        const image = container.image;
        const digest = await this.getImageDigest(image);
        
        if (!usage.has(digest)) {
          usage.set(digest, {
            image,
            pods: [],
            services: new Set(),
            lastUsed: new Date(0),
            size: await this.getImageSize(digest)
          });
        }
        
        const info = usage.get(digest);
        info.pods.push(`${pod.metadata.namespace}/${pod.metadata.name}`);
        info.services.add(pod.metadata.labels?.app);
        info.lastUsed = new Date(Math.max(info.lastUsed, new Date(pod.metadata.creationTimestamp)));
      }
    }
    
    this.usageCache = usage;
    return usage;
  }

  // 识别未使用镜像
  async findUnusedImages() {
    const usage = await this.scanImageUsage();
    const allImages = await this.registryApi.listImages();
    const unused = [];
    
    for (const image of allImages) {
      if (!usage.has(image.digest)) {
        unused.push({
          ...image,
          unusedDays: Math.floor((Date.now() - new Date(image.pushedAt)) / 86400000)
        });
      }
    }
    
    return unused;
  }
}
```

### 4.4 镜像大小监控

```javascript
// backend/shared/imageSizeMonitor.js
class ImageSizeMonitor {
  constructor() {
    this.metrics = {
      imageSize: new Gauge({
        name: 'pmg_image_size_bytes',
        help: 'Container image size in bytes',
        labelNames: ['service', 'tag', 'digest']
      }),
      imageLayers: new Gauge({
        name: 'pmg_image_layers_count',
        help: 'Number of layers in container image',
        labelNames: ['service', 'tag']
      }),
      imageSizeGrowth: new Gauge({
        name: 'pmg_image_size_growth_percent',
        help: 'Image size growth compared to previous version',
        labelNames: ['service']
      })
    };
  }

  async monitorImageSizes() {
    const services = ['gateway', 'user-service', 'pokemon-service', /* ... */];
    
    for (const service of services) {
      const tags = await this.registryApi.listTags(`pmg/${service}`);
      const latestTag = tags.sort(semver.rcompare)[0];
      
      const manifest = await this.registryApi.getManifest(`pmg/${service}`, latestTag);
      const size = this.calculateImageSize(manifest);
      
      this.metrics.imageSize.set(
        { service, tag: latestTag, digest: manifest.config.digest },
        size
      );
      
      // 检查大小异常
      await this.checkSizeAnomaly(service, latestTag, size);
    }
  }

  async checkSizeAnomaly(service, tag, currentSize) {
    const prevTag = await this.getPreviousTag(service, tag);
    if (!prevTag) return;
    
    const prevSize = await this.getImageSize(service, prevTag);
    const growth = ((currentSize - prevSize) / prevSize) * 100;
    
    this.metrics.imageSizeGrowth.set({ service }, growth);
    
    if (growth > this.config.growthAlertThreshold) {
      await this.alertService.sendAlert({
        level: 'warning',
        title: `镜像大小异常增长: ${service}`,
        message: `${service}:${tag} 大小 ${currentSize}MB，相比上一版本增长 ${growth.toFixed(1)}%`,
        tags: ['image', 'cost', service]
      });
    }
  }
}
```

### 4.5 镜像拉取策略优化

```yaml
# 动态镜像拉取策略
# infrastructure/k8s/base/deployment-with-smart-pull.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pokemon-service
  annotations:
    # 使用智能拉取策略注解
    pmg.k8s.io/image-pull-strategy: "smart"
    # 稳定版本使用 IfNotPresent，开发版本使用 Always
    pmg.k8s.io/stable-pull-policy: "IfNotPresent"
    pmg.k8s.io/dev-pull-policy: "Always"
spec:
  template:
    spec:
      containers:
      - name: pokemon-service
        image: registry.cn-shanghai.aliyuncs.com/pmg/pokemon-service:v1.2.3
        # 默认 IfNotPresent，由 Mutating Webhook 根据版本类型动态调整
        imagePullPolicy: IfNotPresent
```

```javascript
// Admission Webhook 动态调整拉取策略
async function mutateImagePullPolicy(admissionRequest) {
  const pod = admissionRequest.object;
  const patches = [];
  
  for (let i = 0; i < pod.spec.containers.length; i++) {
    const container = pod.spec.containers[i];
    const imageTag = container.image.split(':')[1] || 'latest';
    
    // 判断是否为稳定版本
    const isStable = semver.valid(imageTag) && !semver.prerelease(imageTag);
    
    // 动态设置拉取策略
    const pullPolicy = isStable ? 'IfNotPresent' : 'Always';
    
    if (container.imagePullPolicy !== pullPolicy) {
      patches.push({
        op: 'replace',
        path: `/spec/containers/${i}/imagePullPolicy`,
        value: pullPolicy
      });
    }
  }
  
  return { patches };
}
```

### 4.6 GitHub Actions 集成

```yaml
# .github/workflows/image-cleanup.yml
name: Image Lifecycle Management

on:
  schedule:
    - cron: '0 3 * * *'  # 每天凌晨 3 点
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run mode'
        default: 'true'
        type: boolean

jobs:
  cleanup-unused-images:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    
    - name: Configure Aliyun CLI
      uses: aliyun/configure-aliyun-cli@v1
      with:
        access-key-id: ${{ secrets.ALIYUN_ACCESS_KEY_ID }}
        access-key-secret: ${{ secrets.ALIYUN_ACCESS_KEY_SECRET }}
        region: cn-shanghai
    
    - name: Analyze Image Usage
      id: analyze
      run: |
        node scripts/analyzeImageUsage.js \
          --registry registry.cn-shanghai.aliyuncs.com \
          --namespace pmg \
          --output usage-report.json
    
    - name: Cleanup Unused Images
      if: github.event.inputs.dry_run != 'true'
      run: |
        node scripts/cleanupImages.js \
          --config config/imageLifecycle.json \
          --report usage-report.json
    
    - name: Generate Report
      run: |
        echo "## 镜像清理报告" >> $GITHUB_STEP_SUMMARY
        echo "" >> $GITHUB_STEP_SUMMARY
        cat usage-report.md >> $GITHUB_STEP_SUMMARY
    
    - name: Notify on Large Cleanup
      if: steps.analyze.outputs.cleaned_count > 10
      uses: slack/webhook@v1
      with:
        payload: |
          {
            "text": "镜像清理完成",
            "blocks": [{
              "type": "section",
              "text": {
                "type": "mrkdwn",
                "text": "清理了 ${{ steps.analyze.outputs.cleaned_count }} 个镜像，节省存储 ${{ steps.analyze.outputs.saved_mb }}MB"
              }
            }]
          }
```

### 4.7 API 接口

```javascript
// gateway/src/routes/imageLifecycle.js
router.get('/api/admin/images', async (req, res) => {
  const usage = await imageManager.getAllImagesWithUsage();
  res.json(usage);
});

router.get('/api/admin/images/:service/stats', async (req, res) => {
  const stats = await imageManager.getServiceImageStats(req.params.service);
  res.json(stats);
});

router.post('/api/admin/images/cleanup', async (req, res) => {
  const { dryRun = true, services } = req.body;
  const result = await imageManager.runCleanup({ dryRun, services });
  res.json(result);
});

router.get('/api/admin/images/recommendations', async (req, res) => {
  const recommendations = await imageManager.getOptimizationRecommendations();
  res.json(recommendations);
});
```

## 5. 验收标准（可测试）

- [ ] 部署镜像清理 CronJob，每日自动执行清理任务
- [ ] 未使用超过 14 天的镜像自动标记为待清理
- [ ] 清理前后生成详细报告，包含清理数量、节省存储空间
- [ ] 镜像大小超过 500MB 触发 Warning 告警，超过 800MB 触发 Critical 告警
- [ ] 镜像大小相比上一版本增长超过 30% 触发告警
- [ ] 稳定版本镜像使用 IfNotPresent 拉取策略，开发版本使用 Always
- [ ] 保留策略生效：最新 5 个版本、生产标签 90 天、开发标签 7 天
- [ ] 管理后台可查看所有镜像使用情况和优化建议
- [ ] GitHub Actions 集成完成，支持手动触发和定时执行
- [ ] 清理操作支持 Dry Run 模式，预览清理结果

## 6. 工作量估算

**L（Large）**

理由：
- 需要实现镜像生命周期管理核心逻辑
- 需要对接阿里云容器镜像 API
- 需要实现 K8s Admission Webhook
- 需要集成监控告警系统
- 需要编写 GitHub Actions 工作流
- 预计工作量：3-5 天

## 7. 优先级理由

**P1 理由**：
1. **成本影响显著**：镜像存储是持续成本，优化后可节省 40%+ 存储费用
2. **运维效率提升**：自动化清理减少人工干预，镜像列表清晰便于运维
3. **安全性增强**：及时清理旧镜像减少潜在攻击面
4. **依赖已满足**：REQ-00042 已实现镜像安全扫描，本需求可复用部分基础设施
5. **无阻塞依赖**：不依赖其他待实现需求，可立即开始
