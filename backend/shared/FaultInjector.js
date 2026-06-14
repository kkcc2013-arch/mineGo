// backend/shared/FaultInjector.js
'use strict';
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const { execSync, exec } = require('child_process');
const http = require('http');
const https = require('https');

const logger = createLogger('fault-injector');

/**
 * Fault Types
 */
const FAULT_TYPES = {
  NETWORK_DELAY: 'network-delay',
  NETWORK_LOSS: 'network-loss',
  NETWORK_PARTITION: 'network-partition',
  PROCESS_KILL: 'process-kill',
  PROCESS_STRESS: 'process-stress',
  SERVICE_DOWN: 'service-down',
  DATABASE_FAILURE: 'database-failure',
  CACHE_FAILURE: 'cache-failure',
  CPU_STRESS: 'cpu-stress',
  MEMORY_STRESS: 'memory-stress'
};

/**
 * Fault Injector
 * 
 * Injects various types of faults into the system for chaos engineering.
 * Supports network, process, service, database, and cache faults.
 */
class FaultInjector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.k8sEnabled = options.k8sEnabled !== false && this._checkK8s();
    this.dockerEnabled = options.dockerEnabled !== false && this._checkDocker();
    this.chaosMeshEnabled = options.chaosMeshEnabled || false;
    
    // Active injections
    this.injections = new Map();
    this.injectionCounter = 0;
    
    // Service discovery
    this.serviceEndpoints = options.serviceEndpoints || {};
    
    logger.info('FaultInjector initialized', {
      k8s: this.k8sEnabled,
      docker: this.dockerEnabled,
      chaosMesh: this.chaosMeshEnabled
    });
  }

  /**
   * Check if Kubernetes is available
   */
  _checkK8s() {
    try {
      execSync('kubectl version --client', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if Docker is available
   */
  _checkDocker() {
    try {
      execSync('docker --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate unique injection ID
   */
  _generateId() {
    return `inj-${Date.now()}-${++this.injectionCounter}`;
  }

  /**
   * Inject a fault
   * @param {Object} fault - Fault configuration
   * @returns {Promise<Object>}
   */
  async inject(fault) {
    const id = this._generateId();
    
    logger.info('Injecting fault', { id, type: fault.type, target: fault.target });
    
    let injection;
    
    switch (fault.type) {
      case FAULT_TYPES.NETWORK_DELAY:
        injection = await this._injectNetworkDelay(id, fault);
        break;
      case FAULT_TYPES.NETWORK_LOSS:
        injection = await this._injectNetworkLoss(id, fault);
        break;
      case FAULT_TYPES.NETWORK_PARTITION:
        injection = await this._injectNetworkPartition(id, fault);
        break;
      case FAULT_TYPES.PROCESS_KILL:
        injection = await this._injectProcessKill(id, fault);
        break;
      case FAULT_TYPES.PROCESS_STRESS:
        injection = await this._injectProcessStress(id, fault);
        break;
      case FAULT_TYPES.SERVICE_DOWN:
        injection = await this._injectServiceDown(id, fault);
        break;
      case FAULT_TYPES.DATABASE_FAILURE:
        injection = await this._injectDatabaseFailure(id, fault);
        break;
      case FAULT_TYPES.CACHE_FAILURE:
        injection = await this._injectCacheFailure(id, fault);
        break;
      case FAULT_TYPES.CPU_STRESS:
        injection = await this._injectCpuStress(id, fault);
        break;
      case FAULT_TYPES.MEMORY_STRESS:
        injection = await this._injectMemoryStress(id, fault);
        break;
      default:
        throw new Error(`Unknown fault type: ${fault.type}`);
    }
    
    this.injections.set(id, injection);
    this.emit('injected', injection);
    
    return injection;
  }

  /**
   * Recover a fault injection
   * @param {string} injectionId - Injection ID
   */
  async recover(injectionId) {
    const injection = this.injections.get(injectionId);
    if (!injection) {
      throw new Error(`Injection not found: ${injectionId}`);
    }

    logger.info('Recovering fault', { id: injectionId, type: injection.type });

    try {
      switch (injection.type) {
        case FAULT_TYPES.NETWORK_DELAY:
        case FAULT_TYPES.NETWORK_LOSS:
          await this._recoverNetworkFault(injection);
          break;
        case FAULT_TYPES.NETWORK_PARTITION:
          await this._recoverNetworkPartition(injection);
          break;
        case FAULT_TYPES.PROCESS_KILL:
        case FAULT_TYPES.SERVICE_DOWN:
          await this._recoverProcessKill(injection);
          break;
        case FAULT_TYPES.PROCESS_STRESS:
        case FAULT_TYPES.CPU_STRESS:
        case FAULT_TYPES.MEMORY_STRESS:
          await this._recoverProcessStress(injection);
          break;
        case FAULT_TYPES.DATABASE_FAILURE:
          await this._recoverDatabaseFailure(injection);
          break;
        case FAULT_TYPES.CACHE_FAILURE:
          await this._recoverCacheFailure(injection);
          break;
      }

      injection.status = 'recovered';
      injection.recoveredAt = Date.now();
      this.emit('recovered', injection);
      
    } catch (error) {
      injection.status = 'recovery-failed';
      injection.recoveryError = error.message;
      throw error;
    }
  }

  // ==================== Network Faults ====================

  async _injectNetworkDelay(id, fault) {
    const { target, latency = '500ms', jitter = '100ms' } = fault;
    
    if (this.chaosMeshEnabled && this.k8sEnabled) {
      // Use Chaos Mesh
      const yaml = this._generateNetworkChaosYaml(id, target, 'delay', { latency, jitter });
      await this._applyK8sResource(yaml);
    } else if (this.dockerEnabled) {
      // Use tc (traffic control) via Docker
      const containerId = await this._getDockerContainer(target);
      execSync(`docker exec ${containerId} tc qdisc add dev eth0 root netem delay ${latency} ${jitter}`);
    } else {
      // Simulate via middleware flag
      logger.warn('Using simulated network delay');
    }

    return {
      id,
      type: fault.type,
      target,
      params: { latency, jitter },
      status: 'active',
      createdAt: Date.now()
    };
  }

  async _injectNetworkLoss(id, fault) {
    const { target, loss = '10%', correlation = '25%' } = fault;
    
    if (this.chaosMeshEnabled && this.k8sEnabled) {
      const yaml = this._generateNetworkChaosYaml(id, target, 'loss', { loss, correlation });
      await this._applyK8sResource(yaml);
    } else if (this.dockerEnabled) {
      const containerId = await this._getDockerContainer(target);
      execSync(`docker exec ${containerId} tc qdisc add dev eth0 root netem loss ${loss} ${correlation}`);
    }

    return {
      id,
      type: fault.type,
      target,
      params: { loss, correlation },
      status: 'active',
      createdAt: Date.now()
    };
  }

  async _injectNetworkPartition(id, fault) {
    const { source, destination } = fault;
    
    if (this.chaosMeshEnabled && this.k8sEnabled) {
      const yaml = this._generatePartitionChaosYaml(id, source, destination);
      await this._applyK8sResource(yaml);
    }

    return {
      id,
      type: fault.type,
      target: `${source}->${destination}`,
      params: { source, destination },
      status: 'active',
      createdAt: Date.now()
    };
  }

  async _recoverNetworkFault(injection) {
    if (this.chaosMeshEnabled && this.k8sEnabled) {
      execSync(`kubectl delete networkchaos ${injection.id} -n minego --ignore-not-found`);
    } else if (this.dockerEnabled) {
      try {
        const containerId = await this._getDockerContainer(injection.target);
        execSync(`docker exec ${containerId} tc qdisc del dev eth0 root`, { stdio: 'ignore' });
      } catch {}
    }
  }

  async _recoverNetworkPartition(injection) {
    if (this.chaosMeshEnabled && this.k8sEnabled) {
      execSync(`kubectl delete networkchaos ${injection.id} -n minego --ignore-not-found`);
    }
  }

  // ==================== Process Faults ====================

  async _injectProcessKill(id, fault) {
    const { target, signal = 'SIGTERM', gracePeriod = 5000 } = fault;
    
    let pid;
    if (this.k8sEnabled) {
      // Kill pod
      execSync(`kubectl delete pod -l app=${target} -n minego --grace-period=${Math.floor(gracePeriod/1000)} --force`);
    } else if (this.dockerEnabled) {
      const containerId = await this._getDockerContainer(target);
      execSync(`docker kill --signal ${signal} ${containerId}`);
    } else {
      // Simulate
      logger.warn('Simulating process kill');
    }

    return {
      id,
      type: fault.type,
      target,
      params: { signal, gracePeriod },
      status: 'active',
      createdAt: Date.now(),
      originalPid: pid
    };
  }

  async _injectProcessStress(id, fault) {
    const { target, cpu = 50, memory = '256M', duration } = fault;
    
    let stressPid;
    
    if (this.dockerEnabled) {
      const containerId = await this._getDockerContainer(target);
      // Use stress-ng if available
      const stressCmd = `stress-ng --cpu 1 --cpu-load ${cpu} --vm 1 --vm-bytes ${memory} --timeout ${Math.floor(duration/1000)}s &`;
      execSync(`docker exec -d ${containerId} sh -c "${stressCmd}"`);
    } else {
      // Local stress
      const stress = require('child_process').spawn('stress-ng', [
        '--cpu', '1', '--cpu-load', String(cpu),
        '--vm', '1', '--vm-bytes', memory,
        '--timeout', `${Math.floor(duration/1000)}s`
      ], { detached: true });
      stressPid = stress.pid;
    }

    return {
      id,
      type: fault.type,
      target,
      params: { cpu, memory },
      status: 'active',
      createdAt: Date.now(),
      stressPid
    };
  }

  async _injectCpuStress(id, fault) {
    return this._injectProcessStress(id, { ...fault, memory: '0' });
  }

  async _injectMemoryStress(id, fault) {
    return this._injectProcessStress(id, { ...fault, cpu: 0 });
  }

  async _recoverProcessKill(injection) {
    if (this.k8sEnabled) {
      // K8s will auto-restart pods
      logger.info('Waiting for pod restart', { target: injection.target });
      await this._waitForPodReady(injection.target);
    } else if (this.dockerEnabled) {
      // Restart container
      try {
        execSync(`docker start ${injection.target}`);
      } catch {}
    }
  }

  async _recoverProcessStress(injection) {
    if (injection.stressPid) {
      try {
        process.kill(injection.stressPid, 'SIGTERM');
      } catch {}
    }
  }

  // ==================== Service Faults ====================

  async _injectServiceDown(id, fault) {
    const { target, duration } = fault;
    
    if (this.k8sEnabled) {
      // Scale to 0
      execSync(`kubectl scale deployment ${target} -n minego --replicas=0`);
    } else if (this.dockerEnabled) {
      const containerId = await this._getDockerContainer(target);
      execSync(`docker stop ${containerId}`);
    }

    return {
      id,
      type: fault.type,
      target,
      params: { duration },
      status: 'active',
      createdAt: Date.now(),
      originalReplicas: await this._getReplicas(target)
    };
  }

  // ==================== Database Faults ====================

  async _injectDatabaseFailure(id, fault) {
    const { type: failureType = 'timeout', target = 'postgres' } = fault;
    
    let injection;
    
    switch (failureType) {
      case 'timeout':
        // Inject connection timeout via iptables
        if (this.dockerEnabled) {
          const containerId = await this._getDockerContainer(target);
          execSync(`docker exec ${containerId} iptables -A INPUT -p tcp --dport 5432 -j DROP`);
        }
        break;
      case 'error':
        // Return errors via proxy
        logger.warn('Database error injection - using mock');
        break;
      case 'unavailable':
        // Stop database
        if (this.dockerEnabled) {
          execSync(`docker stop ${target}`);
        }
        break;
    }

    return {
      id,
      type: fault.type,
      target,
      params: { failureType },
      status: 'active',
      createdAt: Date.now()
    };
  }

  async _recoverDatabaseFailure(injection) {
    const { target = 'postgres', params } = injection;
    
    switch (params.failureType) {
      case 'timeout':
        if (this.dockerEnabled) {
          try {
            const containerId = await this._getDockerContainer(target);
            execSync(`docker exec ${containerId} iptables -D INPUT -p tcp --dport 5432 -j DROP`, { stdio: 'ignore' });
          } catch {}
        }
        break;
      case 'unavailable':
        if (this.dockerEnabled) {
          execSync(`docker start ${target}`);
        }
        break;
    }
  }

  // ==================== Cache Faults ====================

  async _injectCacheFailure(id, fault) {
    const { target = 'redis', type: failureType = 'unavailable' } = fault;
    
    if (failureType === 'unavailable') {
      if (this.dockerEnabled) {
        execSync(`docker stop ${target}`);
      }
    }

    return {
      id,
      type: fault.type,
      target,
      params: { failureType },
      status: 'active',
      createdAt: Date.now()
    };
  }

  async _recoverCacheFailure(injection) {
    const { target = 'redis', params } = injection;
    
    if (params.failureType === 'unavailable') {
      if (this.dockerEnabled) {
        execSync(`docker start ${target}`);
      }
    }
  }

  // ==================== Helpers ====================

  _generateNetworkChaosYaml(id, target, action, params) {
    const spec = {
      apiVersion: 'chaos-mesh.org/v1alpha1',
      kind: 'NetworkChaos',
      metadata: { name: id, namespace: 'minego' },
      spec: {
        action,
        mode: 'one',
        selector: {
          namespaces: ['minego'],
          labelSelectors: { app: target }
        },
        duration: '5m'
      }
    };

    if (action === 'delay') {
      spec.spec.delay = { latency: params.latency, jitter: params.jitter };
    } else if (action === 'loss') {
      spec.spec.loss = { loss: params.loss, correlation: params.correlation };
    }

    return this._toYaml(spec);
  }

  _generatePartitionChaosYaml(id, source, destination) {
    const spec = {
      apiVersion: 'chaos-mesh.org/v1alpha1',
      kind: 'NetworkChaos',
      metadata: { name: id, namespace: 'minego' },
      spec: {
        action: 'partition',
        mode: 'one',
        selector: {
          namespaces: ['minego'],
          labelSelectors: { app: source }
        },
        direction: 'to',
        target: {
          selector: {
            namespaces: ['minego'],
            labelSelectors: { app: destination }
          }
        },
        duration: '5m'
      }
    };

    return this._toYaml(spec);
  }

  _toYaml(obj, indent = 0) {
    // Simple YAML serializer
    const spaces = '  '.repeat(indent);
    let yaml = '';
    
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;
      
      if (typeof value === 'object' && !Array.isArray(value)) {
        yaml += `${spaces}${key}:\n${this._toYaml(value, indent + 1)}`;
      } else if (Array.isArray(value)) {
        yaml += `${spaces}${key}:\n`;
        for (const item of value) {
          if (typeof item === 'object') {
            yaml += `${spaces}  -\n${this._toYaml(item, indent + 2)}`;
          } else {
            yaml += `${spaces}  - ${item}\n`;
          }
        }
      } else {
        yaml += `${spaces}${key}: ${value}\n`;
      }
    }
    
    return yaml;
  }

  async _applyK8sResource(yaml) {
    const fs = require('fs');
    const tmpFile = `/tmp/chaos-${Date.now()}.yaml`;
    fs.writeFileSync(tmpFile, yaml);
    execSync(`kubectl apply -f ${tmpFile}`);
    fs.unlinkSync(tmpFile);
  }

  async _getDockerContainer(serviceName) {
    const output = execSync(`docker ps -q -f name=${serviceName}`).toString().trim();
    if (!output) {
      throw new Error(`Container not found: ${serviceName}`);
    }
    return output.split('\n')[0];
  }

  async _getReplicas(serviceName) {
    if (this.k8sEnabled) {
      try {
        const output = execSync(`kubectl get deployment ${serviceName} -n minego -o jsonpath='{.spec.replicas}'`).toString();
        return parseInt(output) || 1;
      } catch {
        return 1;
      }
    }
    return 1;
  }

  async _waitForPodReady(serviceName, timeout = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const output = execSync(
          `kubectl get pods -l app=${serviceName} -n minego -o jsonpath='{.items[*].status.conditions[?(@.type=="Ready")].status}'`
        ).toString();
        if (output.includes('True')) {
          return true;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`Pod ${serviceName} did not become ready in time`);
  }

  /**
   * Get all active injections
   */
  getActiveInjections() {
    return Array.from(this.injections.values()).filter(i => i.status === 'active');
  }

  /**
   * Get supported fault types
   */
  getSupportedFaultTypes() {
    return Object.values(FAULT_TYPES);
  }
}

module.exports = FaultInjector;
module.exports.FAULT_TYPES = FAULT_TYPES;
