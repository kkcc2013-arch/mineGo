# REQ-00027: 精灵详情页 3D 模型展示与交互

## 概述

本需求为精灵详情页添加 3D 模型展示和交互能力，基于 Three.js 实现，支持：
- 360° 旋转查看精灵
- 触摸/鼠标缩放
- 4 种动作动画（待机、攻击、受击、庆祝）
- 稀有精灵光效和粒子特效
- 自动降级到 2D 图片模式
- 低端设备性能优化

## 文件结构

```
frontend/game-client/
├── src/3d/
│   ├── Pokemon3DViewer.js          # 核心 3D 查看器
│   ├── PokemonDetailViewer.js      # 详情页 UI 组件
│   └── PokemonDetailIntegration.js # 集成示例
├── test-3d-viewer.html             # 测试页面
├── assets/
│   ├── 3d/pokemon/                  # 3D 模型文件 (GLTF)
│   └── images/pokemon/              # 2D 图片降级
└── styles/
    └── a11y.css                     # 无障碍样式（已存在）

backend/tests/unit/
└── pokemon-3d-viewer.test.js       # 单元测试
```

## 快速开始

### 1. 基本使用

```javascript
import { PokemonDetailViewer } from './src/3d/PokemonDetailViewer.js';

// 创建查看器
const viewer = new PokemonDetailViewer({
  containerId: 'pokemon-detail-viewer',
  autoDowngrade: true,  // 自动降级到 2D
  onDowngrade: (e) => {
    console.log('降级原因:', e.reason);
  }
});

// 初始化
viewer.init();

// 显示精灵
await viewer.showPokemon({
  speciesId: 25,        // 精灵种族 ID
  name: '皮卡丘',
  rarity: 4,            // 稀有度 1-5
  variant: 'normal'     // normal 或 shiny
});

// 播放动作
viewer.playAction('attack');
```

### 2. 集成到现有页面

#### 方式一：直接嵌入

```html
<div id="pokemon-detail-viewer"></div>

<script type="module">
import { PokemonDetailViewer } from './src/3d/PokemonDetailViewer.js';

const viewer = new PokemonDetailViewer();
viewer.init();
await viewer.showPokemon({ speciesId: 25, name: '皮卡丘', rarity: 4 });
</script>
```

#### 方式二：弹窗模式

```javascript
import { PokemonDetailModal } from './src/3d/PokemonDetailIntegration.js';

const modal = new PokemonDetailModal();
await modal.show({
  speciesId: 25,
  name: '皮卡丘',
  rarity: 4
});

// 关闭
modal.close();
```

### 3. 测试页面

访问 `/test-3d-viewer.html` 进行功能测试：

```bash
# 本地开发
cd frontend/game-client
python3 -m http.server 8000

# 访问
open http://localhost:8000/test-3d-viewer.html
```

## 功能特性

### 1. 3D 模型展示

- **模型格式**: GLTF 2.0
- **模型路径**: `/assets/3d/pokemon/{speciesId}.gltf`
- **模型大小**: 每个 < 500KB（压缩后）
- **自动居中**: 根据边界盒自动调整位置
- **自动缩放**: 根据模型大小调整相机距离

### 2. 交互控制

| 操作 | 桌面 | 移动端 |
|------|------|--------|
| 旋转 | 鼠标拖拽 | 单指拖拽 |
| 缩放 | 滚轮 | 双指捏合 |
| 动作 | 点击按钮 | 点击按钮 |

### 3. 动作系统

| 动作 | 触发条件 | 循环 | 说明 |
|------|----------|------|------|
| idle | 默认 | 是 | 待机呼吸动画 |
| attack | 点击攻击按钮 | 否 | 攻击动作 |
| hit | 受到伤害 | 否 | 受击反馈 |
| celebrate | 捕捉成功/升级 | 否 | 庆祝动作 |

### 4. 稀有精灵特效

| 稀有度 | 光晕颜色 | 粒子数量 | 特殊效果 |
|--------|----------|----------|----------|
| 1-3 星 | 无 | 0 | - |
| 4 星 | 紫色 | 50 | 光晕脉冲 |
| 5 星 | 金色 | 100 | 光晕脉冲 + 彩虹渐变 |

### 5. 性能降级

自动检测以下情况并降级到 2D：
- 不支持 WebGL
- 低端 GPU（Intel 集成显卡，非 Iris/Arc）
- 模型加载失败
- 渲染性能过低

降级后：
- 显示 2D 静态图片
- 禁用动作按钮
- 显示 2D/3D 切换按钮

## 技术实现

### 核心类：Pokemon3DViewer

```javascript
class Pokemon3DViewer {
  constructor(container, options = {})
  
  // 加载模型
  async loadModel(speciesId, variant = 'normal')
  
  // 播放动作
  playAction(actionName)
  
  // 设置稀有特效
  setRarityEffect(rarity)
  
  // 启用/禁用交互
  setInteractive(enabled)
  
  // 降级到 2D
  downgradeTo2D()
  
  // 销毁
  dispose()
  
  // 获取性能信息
  getPerformanceInfo()
}
```

### 配置选项

```javascript
{
  containerId: 'pokemon-detail-viewer',
  imageBaseUrl: '/assets/images/pokemon',
  modelBaseUrl: '/assets/3d/pokemon',
  autoDowngrade: true,
  onDowngrade: (event) => {}
}
```

### 性能优化

1. **渲染优化**
   - 限制像素比 `Math.min(devicePixelRatio, 2)`
   - 阴影贴图 1024x1024
   - 对象池管理

2. **内存优化**
   - 单模型内存 < 50MB
   - 及时释放资源
   - 纹理压缩

3. **加载优化**
   - 模型按需加载
   - 加载进度反馈
   - 失败自动降级

## 测试

### 单元测试

```bash
cd backend
npm test -- tests/unit/pokemon-3d-viewer.test.js
```

测试覆盖：
- ✅ 初始化功能
- ✅ WebGL 检测
- ✅ 模型加载
- ✅ 动作控制
- ✅ 稀有特效
- ✅ 交互控制
- ✅ 降级功能
- ✅ 资源清理

### 验收标准

- [x] Three.js 成功集成
- [x] 支持 360° 旋转
- [x] 支持双指/滚轮缩放
- [x] 支持 4 种动作动画
- [x] 稀有精灵特效
- [x] 自动降级 2D
- [x] 手动切换 2D/3D
- [x] 模型加载失败降级
- [x] 内存占用 < 50MB

## 注意事项

### 1. 3D 模型资源

当前实现使用占位几何体，实际部署需要：
- 准备真实 3D 模型文件
- 模型格式：GLTF 2.0
- 包含动画剪辑
- 文件大小 < 500KB

### 2. CDN 依赖

测试页面使用 CDN 加载 Three.js：

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
  }
}
</script>
```

生产环境建议：
- 使用构建工具打包
- 或使用本地 Three.js 库

### 3. 浏览器兼容性

| 浏览器 | 最低版本 | 备注 |
|--------|----------|------|
| Chrome | 70+ | 推荐 |
| Firefox | 65+ | 支持 |
| Safari | 12+ | 支持 |
| Edge | 79+ | 支持 |
| IE | - | 不支持 |

### 4. 移动端优化

- 触摸事件优化
- 帧率监控
- 低端设备降级
- 省电模式支持

## 相关资源

- [Three.js 文档](https://threejs.org/docs/)
- [GLTF 格式规范](https://github.com/KhronosGroup/glTF)
- [OrbitControls 文档](https://threejs.org/docs/#examples/en/controls/OrbitControls)
- [WebGL 兼容性检测](https://get.webgl.org/)

## 下一步

- [ ] 添加真实 3D 模型
- [ ] 实现更多动作动画
- [ ] 添加 AR 模式支持
- [ ] 优化低端设备性能
- [ ] 添加模型缓存策略

## 变更日志

### v1.0.0 (2026-06-05)
- ✅ 初始实现
- ✅ Three.js 集成
- ✅ 基础交互功能
- ✅ 动作系统
- ✅ 稀有特效
- ✅ 降级机制
- ✅ 单元测试
