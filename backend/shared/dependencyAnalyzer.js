/**
 * Dependency Analyzer - 微服务依赖关系分析器
 * 
 * 功能：
 * - 静态代码分析提取依赖关系（HTTP 调用、Kafka Topic）
 * - 循环依赖检测（Kahn 拓扑排序算法）
 * - 依赖健康度评分
 * - 生成依赖图（GraphViz/Mermaid/JSON 格式）
 * 
 * @module DependencyAnalyzer
 */

const fs = require('fs').promises;
const path = require('path');

class DependencyAnalyzer {
  constructor() {
    this.services = [
      'gateway',
      'user-service',
      'location-service',
      'pokemon-service',
      'catch-service',
      'gym-service',
      'social-service',
      'reward-service',
      'payment-service'
    ];
    
    this.dependencies = [];
    this.serviceDirs = new Map();
    this.eventTopics = new Map();
  }

  /**
   * 分析所有服务的依赖关系
   */
  async analyzeAll() {
    console.log('[DependencyAnalyzer] Starting dependency analysis...');
    
    // 1. 发现服务目录
    await this.discoverServices();
    
    // 2. 分析每个服务的依赖
    for (const service of this.services) {
      await this.analyzeService(service);
    }
    
    // 3. 检测循环依赖
    const cycles = this.detectCycles();
    
    // 4. 计算健康度评分
    const healthScores = this.calculateHealthScores();
    
    console.log(`[DependencyAnalyzer] Analysis complete. Found ${this.dependencies.length} dependencies`);
    
    return {
      services: this.services,
      dependencies: this.dependencies,
      cycles,
      healthScores,
      startupOrder: this.getStartupOrder(),
      analyzedAt: new Date().toISOString()
    };
  }

  /**
   * 发现服务目录
   */
  async discoverServices() {
    const backendPath = path.join(__dirname, '../../services');
    
    for (const service of this.services) {
      const servicePath = path.join(backendPath, service.replace('-service', '-service'));
      try {
        await fs.access(servicePath);
        this.serviceDirs.set(service, servicePath);
      } catch (err) {
        console.warn(`[DependencyAnalyzer] Service directory not found: ${service}`);
      }
    }
    
    console.log(`[DependencyAnalyzer] Found ${this.serviceDirs.size} service directories`);
  }

  /**
   * 分析单个服务的依赖
   */
  async analyzeService(serviceName) {
    const servicePath = this.serviceDirs.get(serviceName);
    if (!servicePath) return;
    
    console.log(`[DependencyAnalyzer] Analyzing ${serviceName}...`);
    
    // 分析源码文件
    const srcPath = path.join(servicePath, 'src');
    await this.analyzeDirectory(srcPath, serviceName);
    
    // 分析配置文件
    await this.analyzeConfig(servicePath, serviceName);
  }

  /**
   * 递归分析目录中的文件
   */
  async analyzeDirectory(dirPath, serviceName) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          await this.analyzeDirectory(fullPath, serviceName);
        } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts'))) {
          await this.analyzeFile(fullPath, serviceName);
        }
      }
    } catch (err) {
      // 目录不存在，忽略
    }
  }

  /**
   * 分析单个文件的依赖
   */
  async analyzeFile(filePath, serviceName) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      
      // 1. 检测 HTTP 客户端调用
      this.extractHTTPCalls(content, serviceName, filePath);
      
      // 2. 检测事件发布
      this.extractEventPublish(content, serviceName, filePath);
      
      // 3. 检测事件订阅
      this.extractEventSubscribe(content, serviceName, filePath);
      
      // 4. 检测服务代理配置
      this.extractProxyConfig(content, serviceName, filePath);
    } catch (err) {
      console.warn(`[DependencyAnalyzer] Failed to read file: ${filePath}`);
    }
  }

  /**
   * 提取 HTTP 调用
   */
  extractHTTPCalls(content, serviceName, filePath) {
    // 匹配 axios.get('http://user-service:8081/api/users')
    const axiosPattern = /axios\.(get|post|put|delete|patch)\s*\(\s*['"`](https?:\/\/([^/:]+))/g;
    let match;
    
    while ((match = axiosPattern.exec(content)) !== null) {
      const targetService = this.normalizeServiceName(match[3]);
      if (targetService && targetService !== serviceName) {
        this.addDependency(serviceName, targetService, 'sync_http', filePath);
      }
    }
    
    // 匹配 fetch('http://user-service:8081/api/users')
    const fetchPattern = /fetch\s*\(\s*['"`](https?:\/\/([^/:]+))/g;
    while ((match = fetchPattern.exec(content)) !== null) {
      const targetService = this.normalizeServiceName(match[2]);
      if (targetService && targetService !== serviceName) {
        this.addDependency(serviceName, targetService, 'sync_http', filePath);
      }
    }
    
    // 匹配环境变量形式: process.env.USER_SERVICE_URL
    const envPattern = /process\.env\.([A-Z_]+_SERVICE_URL)/g;
    while ((match = envPattern.exec(content)) !== null) {
      const envVar = match[1];
      const targetService = this.envToServiceName(envVar);
      if (targetService && targetService !== serviceName) {
        this.addDependency(serviceName, targetService, 'sync_http', filePath);
      }
    }
  }

  /**
   * 提取事件发布
   */
  extractEventPublish(content, serviceName, filePath) {
    // 匹配 eventBus.publish('pokemon.caught', data)
    const publishPattern = /eventBus\.publish\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    
    while ((match = publishPattern.exec(content)) !== null) {
      const topic = match[1];
      this.addEventTopic(topic, serviceName, 'publisher');
      this.trackEventDependency(serviceName, topic, 'async_event_pub', filePath);
    }
    
    // 匹配 kafkaProducer.send({ topic: 'pokemon.caught' })
    const kafkaPattern = /kafkaProducer\.send\s*\(\s*\{\s*topic:\s*['"`]([^'"`]+)['"`]/g;
    while ((match = kafkaPattern.exec(content)) !== null) {
      const topic = match[1];
      this.addEventTopic(topic, serviceName, 'publisher');
      this.trackEventDependency(serviceName, topic, 'async_event_pub', filePath);
    }
  }

  /**
   * 提取事件订阅
   */
  extractEventSubscribe(content, serviceName, filePath) {
    // 匹配 eventBus.subscribe('pokemon.caught', handler)
    const subscribePattern = /eventBus\.subscribe\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    
    while ((match = subscribePattern.exec(content)) !== null) {
      const topic = match[1];
      this.addEventTopic(topic, serviceName, 'subscriber');
      this.trackEventDependency(serviceName, topic, 'async_event_sub', filePath);
    }
    
    // 匹配 kafkaConsumer.subscribe({ topic: 'pokemon.caught' })
    const kafkaPattern = /kafkaConsumer\.subscribe\s*\(\s*\{\s*topic:\s*['"`]([^'"`]+)['"`]/g;
    while ((match = kafkaPattern.exec(content)) !== null) {
      const topic = match[1];
      this.addEventTopic(topic, serviceName, 'subscriber');
      this.trackEventDependency(serviceName, topic, 'async_event_sub', filePath);
    }
  }

  /**
   * 提取代理配置
   */
  extractProxyConfig(content, serviceName, filePath) {
    if (serviceName !== 'gateway') return;
    
    // 匹配 app.use('/api/users', proxy({ target: SERVICES.user }))
    const proxyPattern = /app\.use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*proxy\s*\(\s*\{\s*target:\s*SERVICES\.([a-z]+)/g;
    let match;
    
    while ((match = proxyPattern.exec(content)) !== null) {
      const apiPath = match[1];
      const targetKey = match[2];
      const targetService = this.gatewayKeyToService(targetKey);
      if (targetService && targetService !== serviceName) {
        this.addDependency(serviceName, targetService, 'sync_http', filePath);
      }
    }
  }

  /**
   * 分析配置文件
   */
  async analyzeConfig(servicePath, serviceName) {
    // 分析 package.json
    try {
      const packagePath = path.join(servicePath, 'package.json');
      const content = await fs.readFile(packagePath, 'utf8');
      const pkg = JSON.parse(content);
      
      // 检查是否有对其他服务的依赖（通常是 monorepo 内部依赖）
      if (pkg.dependencies) {
        for (const dep of Object.keys(pkg.dependencies)) {
          if (dep.startsWith('@minego/') && dep !== '@minego/shared') {
            const targetService = dep.replace('@minego/', '');
            this.addDependency(serviceName, targetService, 'package_dep', packagePath);
          }
        }
      }
    } catch (err) {
      // package.json 不存在，忽略
    }
  }

  /**
   * 添加依赖关系
   */
  addDependency(from, to, type, filePath) {
    // 检查是否已存在
    const existing = this.dependencies.find(
      d => d.from === from && d.to === to && d.type === type
    );
    
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      if (!existing.files.includes(filePath)) {
        existing.files.push(filePath);
      }
    } else {
      this.dependencies.push({
        from,
        to,
        type,
        count: 1,
        files: [filePath]
      });
    }
  }

  /**
   * 添加事件主题
   */
  addEventTopic(topic, serviceName, role) {
    if (!this.eventTopics.has(topic)) {
      this.eventTopics.set(topic, { publishers: [], subscribers: [] });
    }
    
    const topicInfo = this.eventTopics.get(topic);
    if (role === 'publisher' && !topicInfo.publishers.includes(serviceName)) {
      topicInfo.publishers.push(serviceName);
    } else if (role === 'subscriber' && !topicInfo.subscribers.includes(serviceName)) {
      topicInfo.subscribers.push(serviceName);
    }
  }

  /**
   * 跟踪事件依赖
   */
  trackEventDependency(serviceName, topic, type, filePath) {
    // 事件依赖会在发布者和订阅者之间建立间接依赖
    // 这里只记录事件关系，不直接建立服务间依赖
  }

  /**
   * 规范化服务名称
   */
  normalizeServiceName(name) {
    // 移除端口号
    name = name.split(':')[0];
    
    // 转换为标准格式
    const mapping = {
      'user': 'user-service',
      'user-service': 'user-service',
      'location': 'location-service',
      'location-service': 'location-service',
      'pokemon': 'pokemon-service',
      'pokemon-service': 'pokemon-service',
      'catch': 'catch-service',
      'catch-service': 'catch-service',
      'gym': 'gym-service',
      'gym-service': 'gym-service',
      'social': 'social-service',
      'social-service': 'social-service',
      'reward': 'reward-service',
      'reward-service': 'reward-service',
      'payment': 'payment-service',
      'payment-service': 'payment-service',
      'gateway': 'gateway'
    };
    
    return mapping[name.toLowerCase()] || null;
  }

  /**
   * 环境变量转服务名
   */
  envToServiceName(envVar) {
    const mapping = {
      'USER_SERVICE_URL': 'user-service',
      'LOCATION_SERVICE_URL': 'location-service',
      'POKEMON_SERVICE_URL': 'pokemon-service',
      'CATCH_SERVICE_URL': 'catch-service',
      'GYM_SERVICE_URL': 'gym-service',
      'SOCIAL_SERVICE_URL': 'social-service',
      'REWARD_SERVICE_URL': 'reward-service',
      'PAYMENT_SERVICE_URL': 'payment-service'
    };
    
    return mapping[envVar] || null;
  }

  /**
   * Gateway 键转服务名
   */
  gatewayKeyToService(key) {
    const mapping = {
      'user': 'user-service',
      'location': 'location-service',
      'pokemon': 'pokemon-service',
      'catch': 'catch-service',
      'gym': 'gym-service',
      'social': 'social-service',
      'reward': 'reward-service',
      'payment': 'payment-service'
    };
    
    return mapping[key] || null;
  }

  /**
   * 检测循环依赖
   */
  detectCycles() {
    const cycles = [];
    const visited = new Set();
    const recursionStack = new Set();
    const path = [];
    
    // 构建邻接表
    const graph = new Map();
    for (const service of this.services) {
      graph.set(service, []);
    }
    
    for (const dep of this.dependencies) {
      if (dep.type === 'sync_http' || dep.type === 'package_dep') {
        graph.get(dep.from)?.push(dep.to);
      }
    }
    
    // DFS 检测环
    const dfs = (node) => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);
      
      const neighbors = graph.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          const cycle = dfs(neighbor);
          if (cycle) return cycle;
        } else if (recursionStack.has(neighbor)) {
          // 找到环
          const cycleStart = path.indexOf(neighbor);
          return path.slice(cycleStart).concat(neighbor);
        }
      }
      
      recursionStack.delete(node);
      path.pop();
      return null;
    };
    
    // 从每个未访问的节点开始
    for (const service of this.services) {
      if (!visited.has(service)) {
        const cycle = dfs(service);
        if (cycle) {
          cycles.push(cycle);
        }
      }
    }
    
    return cycles;
  }

  /**
   * 计算健康度评分
   */
  calculateHealthScores() {
    const scores = new Map();
    
    for (const service of this.services) {
      const deps = this.dependencies.filter(d => d.from === service);
      const incoming = this.dependencies.filter(d => d.to === service);
      
      // 健康度评分因素
      let score = 100;
      
      // 出度过多扣分（单个服务依赖太多其他服务）
      if (deps.length > 5) score -= (deps.length - 5) * 5;
      
      // 入度过多扣分（被太多服务依赖，是热点服务）
      if (incoming.length > 7) score -= (incoming.length - 7) * 3;
      
      // 循环依赖严重扣分
      const cycles = this.detectCycles();
      const inCycle = cycles.some(cycle => cycle.includes(service));
      if (inCycle) score -= 20;
      
      scores.set(service, Math.max(0, Math.min(100, score)));
    }
    
    return scores;
  }

  /**
   * 获取启动顺序（拓扑排序）
   */
  getStartupOrder() {
    // Kahn 算法
    const inDegree = new Map();
    const graph = new Map();
    
    // 初始化
    for (const service of this.services) {
      inDegree.set(service, 0);
      graph.set(service, []);
    }
    
    // 构建图
    for (const dep of this.dependencies) {
      if (dep.type === 'sync_http' || dep.type === 'package_dep') {
        graph.get(dep.from)?.push(dep.to);
        inDegree.set(dep.to, (inDegree.get(dep.to) || 0) + 1);
      }
    }
    
    // 找到所有入度为 0 的节点
    const queue = [];
    for (const [service, degree] of inDegree) {
      if (degree === 0) {
        queue.push(service);
      }
    }
    
    // 拓扑排序
    const sorted = [];
    while (queue.length > 0) {
      const node = queue.shift();
      sorted.push(node);
      
      const neighbors = graph.get(node) || [];
      for (const neighbor of neighbors) {
        inDegree.set(neighbor, inDegree.get(neighbor) - 1);
        if (inDegree.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }
    
    // 如果排序结果不等于所有服务，说明有环
    if (sorted.length < this.services.length) {
      console.warn('[DependencyAnalyzer] Cycles detected, startup order may be incomplete');
      // 将未排序的服务追加到末尾
      const remaining = this.services.filter(s => !sorted.includes(s));
      sorted.push(...remaining);
    }
    
    return sorted.reverse(); // 反转，让被依赖的服务先启动
  }

  /**
   * 生成 Mermaid 格式依赖图
   */
  generateMermaidGraph() {
    const lines = ['graph TD'];
    
    // 添加节点定义
    const nodeStyles = {
      'gateway': 'fill:#4A90E2',
      'user-service': 'fill:#50C878',
      'location-service': 'fill:#FFB347',
      'pokemon-service': 'fill:#FF6B6B',
      'catch-service': 'fill:#4ECDC4',
      'gym-service': 'fill:#95E1D3',
      'social-service': 'fill:#F38181',
      'reward-service': 'fill:#AA96DA',
      'payment-service': 'fill:#FCBAD3'
    };
    
    for (const service of this.services) {
      const nodeId = service.replace('-service', '').toUpperCase();
      const style = nodeStyles[service] || 'fill:#CCCCCC';
      lines.push(`  ${nodeId}[${service}]`);
      lines.push(`  style ${nodeId} ${style}`);
    }
    
    lines.push('');
    
    // 添加边
    for (const dep of this.dependencies) {
      if (dep.type === 'sync_http' || dep.type === 'package_dep') {
        const fromId = dep.from.replace('-service', '').toUpperCase();
        const toId = dep.to.replace('-service', '').toUpperCase();
        const label = dep.type === 'sync_http' ? 'HTTP' : 'Event';
        lines.push(`  ${fromId} -->|${label}| ${toId}`);
      }
    }
    
    return lines.join('\n');
  }

  /**
   * 生成 GraphViz DOT 格式
   */
  generateDotGraph() {
    const lines = [
      'digraph Dependencies {',
      '  rankdir=TB;',
      '  node [shape=box, style="rounded,filled", fontname="Arial"];',
      '  edge [fontname="Arial"];',
      ''
    ];
    
    // 节点样式
    const nodeStyles = {
      'gateway': '#4A90E2',
      'user-service': '#50C878',
      'location-service': '#FFB347',
      'pokemon-service': '#FF6B6B',
      'catch-service': '#4ECDC4',
      'gym-service': '#95E1D3',
      'social-service': '#F38181',
      'reward-service': '#AA96DA',
      'payment-service': '#FCBAD3'
    };
    
    for (const service of this.services) {
      const color = nodeStyles[service] || '#CCCCCC';
      lines.push(`  "${service}" [fillcolor="${color}"];`);
    }
    
    lines.push('');
    
    // 边
    for (const dep of this.dependencies) {
      if (dep.type === 'sync_http' || dep.type === 'package_dep') {
        const label = dep.type === 'sync_http' ? 'HTTP' : 'Event';
        lines.push(`  "${dep.from}" -> "${dep.to}" [label="${label}"];`);
      }
    }
    
    lines.push('}');
    
    return lines.join('\n');
  }

  /**
   * 获取单个服务的依赖详情
   */
  getServiceDependencies(serviceName) {
    const upstream = this.dependencies
      .filter(d => d.to === serviceName)
      .map(d => d.from);
    
    const downstream = this.dependencies
      .filter(d => d.from === serviceName)
      .map(d => d.to);
    
    const eventsPublished = [];
    const eventsSubscribed = [];
    
    for (const [topic, info] of this.eventTopics) {
      if (info.publishers.includes(serviceName)) {
        eventsPublished.push(topic);
      }
      if (info.subscribers.includes(serviceName)) {
        eventsSubscribed.push(topic);
      }
    }
    
    const healthScores = this.calculateHealthScores();
    
    return {
      service: serviceName,
      dependencies: {
        upstream: [...new Set(upstream)],
        downstream: [...new Set(downstream)],
        events_published: eventsPublished,
        events_subscribed: eventsSubscribed
      },
      health_score: healthScores.get(serviceName) || 0,
      last_analyzed: new Date().toISOString()
    };
  }

  /**
   * 分析服务故障影响范围
   */
  analyzeImpact(serviceName) {
    const affected = new Set();
    const queue = [serviceName];
    
    while (queue.length > 0) {
      const current = queue.shift();
      
      // 找到依赖当前服务的所有服务
      const dependents = this.dependencies
        .filter(d => d.to === current && !affected.has(d.from))
        .map(d => d.from);
      
      for (const dep of dependents) {
        affected.add(dep);
        queue.push(dep);
      }
    }
    
    return {
      failed_service: serviceName,
      affected_services: [...affected],
      impact_score: affected.size * 10,
      recommendation: affected.size > 3 
        ? 'Critical: This service is a core dependency'
        : affected.size > 0 
          ? 'Warning: Multiple services affected'
          : 'OK: Limited impact'
    };
  }
}

module.exports = { DependencyAnalyzer };
