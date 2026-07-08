/**
 * Elasticsearch 输出适配器
 * 输出日志到 Elasticsearch，支持批量索引和索引自动管理
 */
'use strict';

const ILogOutputAdapter = require('./ILogOutputAdapter');
const { Client } = require('@elastic/elasticsearch');

class ElasticsearchAdapter extends ILogOutputAdapter {
  constructor() {
    super('elasticsearch');
    this.client = null;
    this.connected = false;
    this.batchBuffer = [];
    this.batchTimer = null;
    this.indexPattern = null;
  }

  async initialize(config) {
    await super.initialize(config);
    
    if (!config.node) {
      throw new Error('ElasticsearchAdapter requires "node" configuration');
    }
    
    this.indexPattern = config.index || 'minego-logs';
    this.batchSize = config.batchSize || 200;
    this.batchTimeout = config.batchTimeout || 5000;
    
    this.client = new Client({
      node: config.node,
      auth: config.auth ? {
        username: config.auth.username,
        password: config.auth.password
      } : undefined,
      maxRetries: config.retry?.maxRetries || 5,
      requestTimeout: config.requestTimeout || 30000
    });
    
    try {
      await this.client.ping();
      this.connected = true;
      this.healthStatus = 'healthy';
      
      // 启动批处理定时器
      this.batchTimer = setInterval(
        () => this.sendBatch().catch(err => console.error(`[ElasticsearchAdapter] Batch send error:`, err)),
        this.batchTimeout
      );
      
    } catch (error) {
      this.healthStatus = 'error';
      throw error;
    }
  }

  getIndexName() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${this.indexPattern}-${year}.${month}.${day}`;
  }

  async write(logEntry) {
    if (!this.initialized || !this.connected) {
      throw new Error('ElasticsearchAdapter not initialized or not connected');
    }
    
    this.batchBuffer.push(logEntry);
    
    if (this.batchBuffer.length >= this.batchSize) {
      await this.sendBatch();
    }
  }

  async writeBatch(logEntries) {
    for (const entry of logEntries) {
      this.batchBuffer.push(entry);
    }
    
    if (this.batchBuffer.length >= this.batchSize) {
      await this.sendBatch();
    }
  }

  async sendBatch() {
    if (this.batchBuffer.length === 0) return;
    
    const entries = [...this.batchBuffer];
    this.batchBuffer = [];
    
    if (!this.connected) {
      this.batchBuffer.unshift(...entries);
      await this.reconnect();
      return;
    }
    
    const index = this.getIndexName();
    const body = [];
    
    for (const entry of entries) {
      const formatted = this.formatEntry(entry);
      body.push({ index: { _index: index } });
      body.push(formatted);
    }
    
    try {
      await this.client.bulk({ body });
    } catch (error) {
      this.batchBuffer.unshift(...entries);
      this.healthStatus = 'error';
      throw error;
    }
  }

  async reconnect() {
    if (this.client) {
      try {
        await this.client.ping();
        this.connected = true;
        this.healthStatus = 'healthy';
      } catch (error) {
        this.connected = false;
        console.error(`[ElasticsearchAdapter] Reconnect failed:`, error);
      }
    }
  }

  async flush() {
    await this.sendBatch();
  }

  async close() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    
    await super.close();
    await this.sendBatch();
    
    if (this.client) {
      await this.client.close();
      this.connected = false;
    }
    
    this.healthStatus = 'closed';
  }

  async healthCheck() {
    const base = await super.healthCheck();
    
    let esStatus = 'unknown';
    let clusterHealth = null;
    
    try {
      if (this.connected) {
        clusterHealth = await this.client.cluster.health();
        esStatus = clusterHealth.body.status === 'green' ? 'healthy' : 
                   clusterHealth.body.status === 'yellow' ? 'degraded' : 'unhealthy';
      }
    } catch {
      esStatus = 'unhealthy';
      this.connected = false;
    }
    
    return {
      ...base,
      status: this.connected && esStatus !== 'unhealthy' ? 'healthy' : 'unhealthy',
      details: {
        connected: this.connected,
        node: this.config.node,
        indexPattern: this.indexPattern,
        currentIndex: this.getIndexName(),
        batchBuffered: this.batchBuffer.length,
        clusterStatus: clusterHealth?.body?.status || 'unknown'
      }
    };
  }
}

module.exports = ElasticsearchAdapter;