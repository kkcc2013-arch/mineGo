/**
 * 标准输出适配器
 * 输出日志到控制台
 */
'use strict';

const ILogOutputAdapter = require('./ILogOutputAdapter');
const pino = require('pino');

class StdoutAdapter extends ILogOutputAdapter {
  constructor() {
    super('stdout');
    this.pino = null;
  }

  async initialize(config) {
    await super.initialize(config);
    
    const isProduction = process.env.NODE_ENV === 'production';
    const prettyPrint = config.prettyPrint !== false && !isProduction;
    
    this.pino = pino({
      level: config.level || process.env.LOG_LEVEL || 'info',
      base: { service: config.service || 'app' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => {
          const { hostname, ...rest } = bindings;
          return rest;
        }
      },
      transport: prettyPrint ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid'
        }
      } : undefined,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token'],
        censor: '[REDACTED]'
      }
    });
    
    this.healthStatus = 'healthy';
  }

  async write(logEntry) {
    if (!this.initialized) {
      throw new Error('StdoutAdapter not initialized');
    }
    
    const level = logEntry.level || 'info';
    const formatted = this.formatEntry(logEntry);
    
    if (this.pino[level]) {
      this.pino[level](formatted, formatted.message);
    } else {
      this.pino.info(formatted, formatted.message);
    }
  }

  async writeBatch(logEntries) {
    for (const entry of logEntries) {
      await this.write(entry);
    }
  }

  async close() {
    await super.close();
    if (this.pino) {
      this.pino.flush();
      this.pino = null;
    }
    this.healthStatus = 'closed';
  }

  async healthCheck() {
    const base = await super.healthCheck();
    return {
      ...base,
      status: this.initialized && this.pino ? 'healthy' : 'unhealthy',
      details: {
        hasPino: !!this.pino
      }
    };
  }
}

module.exports = StdoutAdapter;
