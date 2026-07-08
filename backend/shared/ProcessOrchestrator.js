'use strict';

/**
 * ProcessOrchestrator - 服务编排引擎核心
 * REQ-00499: 事件驱动服务编排与分布式状态机引擎
 * 
 * 功能：
 * - 启动和管理流程实例
 * - 流程定义加载与版本管理
 * - 流程状态追踪与历史记录
 * - 补偿事务触发
 */

const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const DistributedStateMachine = require('./DistributedStateMachine');
const CompensationManager = require('./CompensationManager');
const { getEventBus } = require('./EventBus');
const { getRedis } = require('./redis');
const fs = require('fs').promises;
const path = require('path');

const logger = createLogger('process-orchestrator');

/**
 * 流程状态常量
 */
const ProcessStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  STEP_WAITING: 'step-waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  COMPENSATING: 'compensating',
  COMPENSATED: 'compensated'
};

/**
 * 流程实例
 */
class ProcessInstance {
  constructor(data) {
    this.instanceId = data.instanceId;
    this.processType = data.processType;
    this.version = data.version;
    this.status = data.status || ProcessStatus.PENDING;
    this.currentStep = data.currentStep;
    this.input = data.input || {};
    this.output = data.output || {};
    this.error = data.error || null;
    this.startedAt = data.startedAt;
    this.completedAt = data.completedAt;
    this.createdAt = data.createdAt || Date.now();
    this.updatedAt = data.updatedAt || Date.now();
    this.traceId = data.traceId;
    this.context = data.context || {};
  }

  toJSON() {
    return {
      instanceId: this.instanceId,
      processType: this.processType,
      version: this.version,
      status: this.status,
      currentStep: this.currentStep,
      input: this.input,
      output: this.output,
      error: this.error,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      traceId: this.traceId,
      context: this.context
    };
  }

  static fromJSON(json) {
    if (typeof json === 'string') {
      json = JSON.parse(json);
    }
    return new ProcessInstance(json);
  }
}

/**
 * 流程定义
 */
class ProcessDefinition {
  constructor(config) {
    this.processType = config.processType;
    this.version = config.version;
    this.description = config.description;
    this.states = config.states || [];
    this.timeout = config.timeout || 60000;
    this.retryPolicy = config.retryPolicy || { maxRetries: 3, backoff: 'exponential' };
    this.initialState = this._findInitialState();
    this.finalStates = this._findFinalStates();
  }

  _findInitialState() {
    for (const state of this.states) {
      const hasIncoming = this.states.some(s => 
        s.transitions && s.transitions.some(t => t.to === state.name)
      );
      if (!hasIncoming) return state.name;
    }
    return this.states[0]?.name;
  }

  _findFinalStates() {
    return this.states.filter(s => s.final).map(s => s.name);
  }

  getState(name) {
    return this.states.find(s => s.name === name);
  }

  getTransition(stateName, eventName) {
    const state = this.getState(stateName);
    if (!state || !state.transitions) return null;
    return state.transitions.find(t => t.event === eventName);
  }

  validate() {
    if (!this.processType) throw new Error('processType is required');
    if (!this.states || this.states.length === 0) throw new Error('states are required');
    if (!this.initialState) throw new Error('No initial state found');
    if (this.finalStates.length === 0) throw new Error('No final states found');
    return true;
  }
}

/**
 * 流程编排器
 */
class ProcessOrchestrator extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      redisKeyPrefix: 'process:',
      definitionsPath: config.definitionsPath || path.join(__dirname, 'processes'),
      ...config
    };
    
    this.redis = config.redisClient || getRedis();
    this.stateMachine = new DistributedStateMachine(this.redis, this.config);
    this.compensationManager = new CompensationManager(this.redis, this.config);
    this.eventBus = getEventBus({ clientId: 'process-orchestrator' });
    
    // 流程定义缓存
    this.definitions = new Map();
    this.definitionVersions = new Map();
    
    // 活跃流程实例
    this.activeInstances = new Map();
    
    // Prometheus 指标
    this.metrics = {
      processesStarted: 0,
      processesCompleted: 0,
      processesFailed: 0,
      processesCancelled: 0,
      stepExecutions: 0,
      compensationExecutions: 0
    };
  }

  /**
   * 初始化：加载流程定义，连接 EventBus
   */
  async initialize() {
    await this.eventBus.connect();
    await this._loadDefinitions();
    await this._subscribeToEvents();
    
    logger.info('ProcessOrchestrator initialized', {
      definitionsCount: this.definitions.size,
      versionsCount: this.definitionVersions.size
    });
    
    return this;
  }

  /**
   * 加载流程定义
   */
  async _loadDefinitions() {
    try {
      const files = await fs.readdir(this.config.definitionsPath);
      
      for (const file of files) {
        if (!file.endsWith('.yaml') && !file.endsWith('.json')) continue;
        
        const filePath = path.join(this.config.definitionsPath, file);
        const content = await fs.readFile(filePath, 'utf8');
        
        let definition;
        if (file.endsWith('.yaml')) {
          const yaml = require('yaml');
          definition = yaml.parse(content);
        } else {
          definition = JSON.parse(content);
        }
        
        await this.registerProcessDefinition(definition);
      }
      
      logger.info('Process definitions loaded', { count: this.definitions.size });
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.warn('Definitions directory not found, creating...', { 
          path: this.config.definitionsPath 
        });
        await fs.mkdir(this.config.definitionsPath, { recursive: true });
      } else {
        logger.error('Failed to load definitions', { err });
      }
    }
  }

  /**
   * 注册流程定义
   */
  async registerProcessDefinition(config) {
    const definition = new ProcessDefinition(config);
    definition.validate();
    
    const key = `${definition.processType}:${definition.version}`;
    this.definitions.set(key, definition);
    
    // 记录版本
    if (!this.definitionVersions.has(definition.processType)) {
      this.definitionVersions.set(definition.processType, []);
    }
    const versions = this.definitionVersions.get(definition.processType);
    if (!versions.includes(definition.version)) {
      versions.push(definition.version);
      versions.sort();
    }
    
    logger.info('Process definition registered', {
      processType: definition.processType,
      version: definition.version,
      statesCount: definition.states.length
    });
    
    return definition;
  }

  /**
   * 获取流程定义
   */
  getDefinition(processType, version = null) {
    if (version) {
      return this.definitions.get(`${processType}:${version}`);
    }
    
    // 返回最新版本
    const versions = this.definitionVersions.get(processType);
    if (!versions || versions.length === 0) return null;
    
    const latestVersion = versions[versions.length - 1];
    return this.definitions.get(`${processType}:${latestVersion}`);
  }

  /**
   * 订阅流程事件
   */
  async _subscribeToEvents() {
    // 订阅所有流程相关事件
    const eventPatterns = [
      'catch.*',
      'pokemon.*',
      'reward.*',
      'social.*',
      'payment.*',
      'gym.*',
      'process.step.*'
    ];
    
    for (const pattern of eventPatterns) {
      await this.eventBus.subscribe(pattern, async (event, context) => {
        await this._handleEvent(event, context);
      }, { groupId: 'process-orchestrator' });
    }
  }

  /**
   * 处理事件
   */
  async _handleEvent(event, context) {
    const { instanceId, stepName } = event;
    
    if (!instanceId) return;
    
    try {
      const instance = await this.getProcessInstance(instanceId);
      if (!instance) {
        logger.warn('Process instance not found', { instanceId });
        return;
      }
      
      const definition = this.getDefinition(instance.processType, instance.version);
      if (!definition) {
        logger.error('Process definition not found', { 
          processType: instance.processType, 
          version: instance.version 
        });
        return;
      }
      
      // 处理步骤完成事件
      if (event.eventType === 'step.completed') {
        await this._handleStepCompletion(instance, definition, event);
      }
      
      // 处理步骤失败事件
      if (event.eventType === 'step.failed') {
        await this._handleStepFailure(instance, definition, event);
      }
      
    } catch (err) {
      logger.error('Event handling failed', { err, instanceId, event });
    }
  }

  /**
   * 启动流程实例
   */
  async startProcess(processType, input, options = {}) {
    const version = options.version || null;
    const definition = this.getDefinition(processType, version);
    
    if (!definition) {
      throw new Error(`Process definition not found: ${processType}`);
    }
    
    // 生成实例 ID
    const instanceId = this._generateInstanceId(processType);
    const traceId = options.traceId || instanceId;
    
    // 创建流程实例
    const instance = new ProcessInstance({
      instanceId,
      processType,
      version: definition.version,
      status: ProcessStatus.PENDING,
      currentStep: definition.initialState,
      input,
      startedAt: Date.now(),
      traceId,
      context: options.context || {}
    });
    
    // 持久化到 Redis
    await this._saveInstance(instance);
    
    // 初始化状态机
    await this.stateMachine.transition(
      instanceId, 
      null, 
      ProcessStatus.RUNNING,
      { traceId }
    );
    
    // 记录步骤开始
    await this._recordStep(instanceId, definition.initialState, 'started');
    
    // 更新实例状态
    instance.status = ProcessStatus.RUNNING;
    this.activeInstances.set(instanceId, instance);
    
    // 执行第一步
    await this._executeStep(instance, definition, definition.initialState);
    
    // 发布流程启动事件
    await this.eventBus.publish('process.started', {
      instanceId,
      processType,
      version: definition.version,
      traceId,
      input
    });
    
    this.metrics.processesStarted++;
    this.emit('process:started', instance);
    
    logger.info('Process started', {
      instanceId,
      processType,
      version: definition.version,
      traceId
    });
    
    return instance;
  }

  /**
   * 执行步骤
   */
  async _executeStep(instance, definition, stepName) {
    const state = definition.getState(stepName);
    if (!state) {
      logger.error('State not found', { stepName });
      return;
    }
    
    if (!state.step) {
      // 无执行动作的状态，直接过渡
      await this._tryTransition(instance, definition, stepName);
      return;
    }
    
    const { service, action, input: stepInput } = state.step;
    
    // 构建步骤输入
    const stepData = this._buildStepInput(instance, stepInput);
    
    // 发布步骤执行事件（由目标服务订阅执行）
    const stepEvent = {
      instanceId: instance.instanceId,
      stepName,
      service,
      action,
      input: stepData,
      traceId: instance.traceId,
      timeout: state.timeout || 10000,
      eventType: 'step.execute'
    };
    
    await this.eventBus.publish(`${service}.execute`, stepEvent);
    
    // 记录补偿信息
    if (state.compensation) {
      await this.compensationManager.recordCompensationStep(
        instance.instanceId,
        stepName,
        state.compensation
      );
    }
    
    // 设置超时
    if (state.timeout) {
      await this.stateMachine.setTimeout(
        instance.instanceId,
        state.timeout,
        stepName
      );
    }
    
    this.metrics.stepExecutions++;
    
    logger.debug('Step execution requested', {
      instanceId: instance.instanceId,
      stepName,
      service,
      action
    });
  }

  /**
   * 构建步骤输入
   */
  _buildStepInput(instance, inputFields) {
    if (!inputFields) return {};
    
    const result = {};
    for (const field of inputFields) {
      if (instance.input[field]) {
        result[field] = instance.input[field];
      } else if (instance.context[field]) {
        result[field] = instance.context[field];
      } else if (instance.output[field]) {
        result[field] = instance.output[field];
      }
    }
    return result;
  }

  /**
   * 处理步骤完成
   */
  async _handleStepCompletion(instance, definition, event) {
    const { stepName, output } = event;
    
    // 记录步骤完成
    await this._recordStep(instance.instanceId, stepName, 'completed', output);
    
    // 更新实例输出
    instance.output = { ...instance.output, ...output };
    instance.context = { ...instance.context, ...output };
    await this._saveInstance(instance);
    
    // 尝试状态转换
    await this._tryTransition(instance, definition, stepName);
    
    logger.debug('Step completed', { 
      instanceId: instance.instanceId, 
      stepName 
    });
  }

  /**
   * 处理步骤失败
   */
  async _handleStepFailure(instance, definition, event) {
    const { stepName, error } = event;
    
    // 记录步骤失败
    await this._recordStep(instance.instanceId, stepName, 'failed', null, error);
    
    // 更新实例错误
    instance.error = error;
    instance.status = ProcessStatus.FAILED;
    await this._saveInstance(instance);
    
    // 触发补偿
    if (definition.getState(stepName)?.compensation) {
      await this._triggerCompensation(instance);
    } else {
      await this._finalizeProcess(instance, ProcessStatus.FAILED);
    }
    
    this.metrics.processesFailed++;
    
    logger.error('Step failed, compensation triggered', { 
      instanceId: instance.instanceId, 
      stepName, 
      error 
    });
  }

  /**
   * 尝试状态转换
   */
  async _tryTransition(instance, definition, currentStep) {
    const state = definition.getState(currentStep);
    
    if (state?.final) {
      // 到达终态
      await this._finalizeProcess(instance, ProcessStatus.COMPLETED);
      return;
    }
    
    // 查找可能的转换（基于输出中的事件或自动转换）
    const transitions = state?.transitions || [];
    
    for (const transition of transitions) {
      // 检查是否满足转换条件
      if (this._checkTransitionCondition(instance, transition)) {
        await this._performTransition(instance, definition, transition);
        return;
      }
    }
  }

  /**
   * 检查转换条件
   */
  _checkTransitionCondition(instance, transition) {
    if (transition.condition) {
      // 评估条件表达式
      return this._evaluateCondition(instance, transition.condition);
    }
    
    // 无条件转换
    if (!transition.event) return true;
    
    // 检查事件是否已触发
    return instance.context[`event:${transition.event}`] === true;
  }

  /**
   * 评估条件表达式
   */
  _evaluateCondition(instance, condition) {
    // 简化版条件评估
    if (typeof condition === 'string') {
      // 支持 "output.field == value" 格式
      const match = condition.match(/(\w+)\.(\w+)\s*(==|!=|>=|<=)\s*(.+)/);
      if (match) {
        const [, source, field, op, value] = match;
        const actualValue = instance[source]?.[field];
        const expectedValue = JSON.parse(value);
        
        switch (op) {
          case '==': return actualValue === expectedValue;
          case '!=': return actualValue !== expectedValue;
          case '>=': return actualValue >= expectedValue;
          case '<=': return actualValue <= expectedValue;
        }
      }
    }
    return true;
  }

  /**
   * 执行状态转换
   */
  async _performTransition(instance, definition, transition) {
    const newState = definition.getState(transition.to);
    
    // 状态机转换
    await this.stateMachine.transition(
      instance.instanceId,
      instance.currentStep,
      transition.to,
      { transition }
    );
    
    // 更新实例
    instance.currentStep = transition.to;
    instance.updatedAt = Date.now();
    await this._saveInstance(instance);
    
    // 记录步骤开始
    await this._recordStep(instance.instanceId, transition.to, 'started');
    
    // 发布转换事件
    await this.eventBus.publish('process.transition', {
      instanceId: instance.instanceId,
      from: instance.currentStep,
      to: transition.to,
      traceId: instance.traceId
    });
    
    // 执行新步骤
    await this._executeStep(instance, definition, transition.to);
  }

  /**
   * 触发补偿事务
   */
  async _triggerCompensation(instance) {
    instance.status = ProcessStatus.COMPENSATING;
    await this._saveInstance(instance);
    
    await this.stateMachine.transition(
      instance.instanceId,
      instance.currentStep,
      ProcessStatus.COMPENSATING,
      { reason: 'step-failure' }
    );
    
    // 执行补偿
    const result = await this.compensationManager.executeCompensation(
      instance.instanceId,
      instance.context
    );
    
    if (result.success) {
      await this._finalizeProcess(instance, ProcessStatus.COMPENSATED);
    } else {
      await this._finalizeProcess(instance, ProcessStatus.FAILED);
    }
    
    this.metrics.compensationExecutions++;
    
    logger.warn('Compensation executed', {
      instanceId: instance.instanceId,
      success: result.success
    });
  }

  /**
   * 完成流程
   */
  async _finalizeProcess(instance, status) {
    instance.status = status;
    instance.completedAt = Date.now();
    await this._saveInstance(instance);
    
    // 清理活跃实例
    this.activeInstances.delete(instance.instanceId);
    
    // 发布完成事件
    await this.eventBus.publish('process.completed', {
      instanceId: instance.instanceId,
      processType: instance.processType,
      status,
      traceId: instance.traceId,
      output: instance.output,
      error: instance.error
    });
    
    if (status === ProcessStatus.COMPLETED) {
      this.metrics.processesCompleted++;
      this.emit('process:completed', instance);
    }
    
    logger.info('Process finalized', {
      instanceId: instance.instanceId,
      status,
      duration: instance.completedAt - instance.startedAt
    });
  }

  /**
   * 取消流程
   */
  async cancelProcess(instanceId, reason) {
    const instance = await this.getProcessInstance(instanceId);
    if (!instance) {
      throw new Error('Process instance not found');
    }
    
    if (instance.status === ProcessStatus.COMPLETED || 
        instance.status === ProcessStatus.COMPENSATED) {
      throw new Error('Process already finalized');
    }
    
    // 触发补偿
    await this._triggerCompensation(instance);
    
    this.metrics.processesCancelled++;
    this.emit('process:cancelled', instance, reason);
    
    logger.info('Process cancelled', { instanceId, reason });
    
    return instance;
  }

  /**
   * 获取流程实例
   */
  async getProcessInstance(instanceId) {
    // 先查缓存
    const cached = this.activeInstances.get(instanceId);
    if (cached) return cached;
    
    // 从 Redis 获取
    const key = `${this.config.redisKeyPrefix}${instanceId}:data`;
    const data = await this.redis.get(key);
    
    if (!data) return null;
    
    return ProcessInstance.fromJSON(data);
  }

  /**
   * 保存流程实例
   */
  async _saveInstance(instance) {
    const key = `${this.config.redisKeyPrefix}${instance.instanceId}:data`;
    await this.redis.set(key, JSON.stringify(instance.toJSON()), 'EX', 86400);
    instance.updatedAt = Date.now();
  }

  /**
   * 记录步骤执行
   */
  async _recordStep(instanceId, stepName, status, output = null, error = null) {
    const key = `${this.config.redisKeyPrefix}${instanceId}:steps`;
    const stepRecord = {
      stepName,
      status,
      output,
      error,
      timestamp: Date.now()
    };
    
    await this.redis.rpush(key, JSON.stringify(stepRecord));
  }

  /**
   * 获取流程执行历史
   */
  async getProcessHistory(instanceId) {
    const key = `${this.config.redisKeyPrefix}${instanceId}:steps`;
    const steps = await this.redis.lrange(key, 0, -1);
    
    return steps.map(s => JSON.parse(s));
  }

  /**
   * 生成实例 ID
   */
  _generateInstanceId(processType) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `${processType}-${timestamp}-${random}`;
  }

  /**
   * 升级流程版本
   */
  async upgradeProcessVersion(processType, newVersion, definition) {
    await this.registerProcessDefinition({
      processType,
      version: newVersion,
      ...definition
    });
    
    logger.info('Process version upgraded', {
      processType,
      newVersion,
      previousVersions: this.definitionVersions.get(processType)
    });
  }

  /**
   * 获取指标
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeInstances: this.activeInstances.size,
      definitionsCount: this.definitions.size,
      processTypes: Array.from(this.definitionVersions.keys())
    };
  }

  /**
   * Prometheus 指标格式
   */
  getPrometheusMetrics() {
    const m = this.metrics;
    return `
# HELP process_started_total Total processes started
# TYPE process_started_total counter
process_started_total ${m.processesStarted}

# HELP process_completed_total Total processes completed
# TYPE process_completed_total counter
process_completed_total{status="completed"} ${m.processesCompleted}
process_completed_total{status="failed"} ${m.processesFailed}
process_completed_total{status="cancelled"} ${m.processesCancelled}

# HELP process_step_executions_total Total step executions
# TYPE process_step_executions_total counter
process_step_executions_total ${m.stepExecutions}

# HELP process_compensation_total Total compensations executed
# TYPE process_compensation_total counter
process_compensation_total ${m.compensationExecutions}

# HELP process_active_instances Current active instances
# TYPE process_active_instances gauge
process_active_instances ${this.activeInstances.size}
`;
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    const eventBusHealth = await this.eventBus.healthCheck();
    
    return {
      healthy: eventBusHealth.healthy && this.definitions.size > 0,
      definitions: this.definitions.size,
      processTypes: Array.from(this.definitionVersions.keys()),
      activeInstances: this.activeInstances.size,
      eventBus: eventBusHealth
    };
  }

  /**
   * 关闭
   */
  async shutdown() {
    // 等待活跃实例完成（可选）
    const activeCount = this.activeInstances.size;
    if (activeCount > 0) {
      logger.warn('Shutting down with active instances', { count: activeCount });
    }
    
    await this.eventBus.disconnect();
    logger.info('ProcessOrchestrator shutdown complete');
  }
}

// 单例
let orchestratorInstance = null;

function getProcessOrchestrator(config) {
  if (!orchestratorInstance) {
    orchestratorInstance = new ProcessOrchestrator(config);
  }
  return orchestratorInstance;
}

module.exports = {
  ProcessOrchestrator,
  ProcessInstance,
  ProcessDefinition,
  ProcessStatus,
  getProcessOrchestrator
};