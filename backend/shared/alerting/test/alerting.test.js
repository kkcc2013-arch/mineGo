'use strict';
/**
 * AlertManager Unit Tests
 * REQ-00439: 熔断器事件告警系统集成
 */

const { AlertManager, AlertLevel, initializeAlertManager } = require('../index');
const AlertAggregator = require('../AlertAggregator');
const LogChannel = require('../channels/LogChannel');
const WebhookChannel = require('../channels/WebhookChannel');

describe('AlertManager', () => {
  let alertManager;
  
  beforeEach(() => {
    alertManager = new AlertManager();
  });
  
  describe('constructor', () => {
    it('should initialize with default rules', () => {
      expect(alertManager.rules.size).toBeGreaterThan(0);
      expect(alertManager.rules.has('circuit-breaker-open')).toBe(true);
    });
    
    it('should have empty channels initially', () => {
      expect(alertManager.channels.length).toBe(0);
    });
    
    it('should have empty silences initially', () => {
      expect(alertManager.silences.size).toBe(0);
    });
  });
  
  describe('addChannel', () => {
    it('should add a channel', () => {
      const logChannel = new LogChannel();
      alertManager.addChannel(logChannel);
      
      expect(alertManager.channels.length).toBe(1);
      expect(alertManager.channels[0].name).toBe('log');
    });
  });
  
  describe('setRule', () => {
    it('should set a custom rule', () => {
      alertManager.setRule('custom-event', {
        level: 'warning',
        channels: ['log']
      });
      
      expect(alertManager.rules.has('custom-event')).toBe(true);
    });
  });
  
  describe('setSilence', () => {
    it('should set a silence pattern', () => {
      alertManager.setSilence('social-service', 300000);
      
      expect(alertManager.silences.has('social-service')).toBe(true);
    });
  });
  
  describe('_isSilenced', () => {
    it('should return true for silenced service', () => {
      alertManager.setSilence('social-service', 300000);
      
      const result = alertManager._isSilenced({
        service: 'social-service',
        event: 'circuit-breaker-open'
      });
      
      expect(result).toBe(true);
    });
    
    it('should return false for non-silenced service', () => {
      alertManager.setSilence('social-service', 300000);
      
      const result = alertManager._isSilenced({
        service: 'user-service',
        event: 'circuit-breaker-open'
      });
      
      expect(result).toBe(false);
    });
    
    it('should auto-remove expired silences', (done) => {
      alertManager.setSilence('test-service', 100); // 100ms
      
      setTimeout(() => {
        expect(alertManager.silences.has('test-service')).toBe(false);
        done();
      }, 200);
    });
  });
  
  describe('send', () => {
    it('should queue valid alert', async () => {
      const result = await alertManager.send({
        level: 'critical',
        service: 'user-service',
        event: 'circuit-breaker-open',
        message: '测试告警'
      });
      
      expect(result).toBe(true);
      expect(alertManager.aggregator.size()).toBe(1);
    });
    
    it('should reject alert without required fields', async () => {
      const result = await alertManager.send({
        message: '缺少 service 和 event'
      });
      
      expect(result).toBe(false);
    });
    
    it('should respect silence rules', async () => {
      alertManager.setSilence('social-service', 300000);
      
      const result = await alertManager.send({
        level: 'critical',
        service: 'social-service',
        event: 'circuit-breaker-open',
        message: '应被静默'
      });
      
      expect(result).toBe(true); // Silenced but not an error
      expect(alertManager.aggregator.size()).toBe(0); // Not queued
    });
  });
  
  describe('getHistory', () => {
    it('should return empty array initially', () => {
      expect(alertManager.getHistory().length).toBe(0);
    });
    
    it('should filter by level', () => {
      alertManager._addToHistory({ level: 'critical', message: 'test1' });
      alertManager._addToHistory({ level: 'warning', message: 'test2' });
      
      const history = alertManager.getHistory({ level: 'critical' });
      expect(history.length).toBe(1);
      expect(history[0].level).toBe('critical');
    });
    
    it('should limit results', () => {
      for (let i = 0; i < 10; i++) {
        alertManager._addToHistory({ level: 'info', message: `test${i}` });
      }
      
      const history = alertManager.getHistory({ limit: 5 });
      expect(history.length).toBe(5);
    });
  });
  
  describe('getSilences', () => {
    it('should return active silences', () => {
      alertManager.setSilence('service1', 60000);
      alertManager.setSilence('service2', 60000);
      
      const silences = alertManager.getSilences();
      expect(silences.length).toBe(2);
      expect(silences[0].pattern).toBeDefined();
      expect(silences[0].remainingMs).toBeGreaterThan(0);
    });
    
    it('should exclude expired silences', () => {
      alertManager.setSilence('expired', 50);
      alertManager.setSilence('active', 60000);
      
      setTimeout(() => {
        const silences = alertManager.getSilences();
        expect(silences.find(s => s.pattern === 'expired')).toBeUndefined();
      }, 100);
    });
  });
});

describe('AlertAggregator', () => {
  let aggregator;
  
  beforeEach(() => {
    aggregator = new AlertAggregator(1000); // 1 second window
  });
  
  describe('add', () => {
    it('should add alert to buffer', () => {
      aggregator.add({
        level: 'critical',
        event: 'circuit-breaker-open',
        service: 'user-service'
      });
      
      expect(aggregator.size()).toBe(1);
    });
    
    it('should group alerts by level and event', () => {
      aggregator.add({ level: 'critical', event: 'event1', service: 's1' });
      aggregator.add({ level: 'critical', event: 'event1', service: 's2' });
      aggregator.add({ level: 'warning', event: 'event2', service: 's3' });
      
      expect(aggregator.size()).toBe(3);
      expect(aggregator.buffer.size).toBe(2); // Two different key groups
    });
  });
  
  describe('flush', () => {
    it('should return empty array when no alerts', () => {
      expect(aggregator.flush().length).toBe(0);
    });
    
    it('should flush alerts after window passes', (done) => {
      aggregator.add({ level: 'critical', event: 'test', service: 's1' });
      
      setTimeout(() => {
        const alerts = aggregator.flush();
        expect(alerts.length).toBe(1);
        expect(aggregator.size()).toBe(0);
        done();
      }, 1100);
    });
    
    it('should flush when threshold reached', () => {
      for (let i = 0; i < 5; i++) {
        aggregator.add({ level: 'critical', event: 'test', service: `s${i}` });
      }
      
      // Force flush by triggering internal check
      const alerts = aggregator.flush();
      expect(alerts.length).toBe(5);
    });
  });
  
  describe('forceFlush', () => {
    it('should flush all alerts regardless of window', () => {
      aggregator.add({ level: 'critical', event: 'test', service: 's1' });
      
      const alerts = aggregator.forceFlush();
      expect(alerts.length).toBe(1);
      expect(aggregator.size()).toBe(0);
    });
  });
  
  describe('clear', () => {
    it('should clear buffer', () => {
      aggregator.add({ level: 'info', event: 'test', service: 's1' });
      aggregator.clear();
      
      expect(aggregator.size()).toBe(0);
    });
  });
});

describe('LogChannel', () => {
  let logChannel;
  
  beforeEach(() => {
    logChannel = new LogChannel();
  });
  
  describe('send', () => {
    it('should send alert to log', async () => {
      const result = await logChannel.send({
        level: 'critical',
        message: '测试日志告警',
        event: 'test'
      });
      
      expect(result).toBe(true);
    });
    
    it('should handle all levels', async () => {
      const levels = ['critical', 'warning', 'info'];
      
      for (const level of levels) {
        const result = await logChannel.send({
          level,
          message: `Level: ${level}`,
          event: 'test'
        });
        
        expect(result).toBe(true);
      }
    });
  });
  
  describe('isEnabled', () => {
    it('should be enabled by default', () => {
      expect(logChannel.isEnabled()).toBe(true);
    });
    
    it('should toggle enabled state', () => {
      logChannel.disable();
      expect(logChannel.isEnabled()).toBe(false);
      
      logChannel.enable();
      expect(logChannel.isEnabled()).toBe(true);
    });
  });
});

describe('WebhookChannel', () => {
  describe('constructor', () => {
    it('should initialize with default headers', () => {
      const channel = new WebhookChannel('http://example.com/webhook');
      
      expect(channel.name).toBe('webhook');
      expect(channel.headers['Content-Type']).toBe('application/json');
    });
    
    it('should add authorization header when apiKey provided', () => {
      const channel = new WebhookChannel('http://example.com', { apiKey: 'test-key' });
      
      expect(channel.headers['Authorization']).toBe('Bearer test-key');
    });
  });
  
  describe('isEnabled', () => {
    it('should be enabled when URL provided', () => {
      const channel = new WebhookChannel('http://example.com');
      expect(channel.isEnabled()).toBe(true);
    });
    
    it('should be disabled when no URL', () => {
      const channel = new WebhookChannel(null);
      expect(channel.isEnabled()).toBe(false);
    });
  });
  
  describe('_formatPayload', () => {
    it('should format alert for webhook', () => {
      const channel = new WebhookChannel('http://example.com');
      
      const payload = channel._formatPayload({
        level: 'critical',
        event: 'circuit-breaker-open',
        message: 'Service unavailable',
        services: ['user-service'],
        timestamp: new Date().toISOString()
      });
      
      expect(payload.alert_type).toBe('critical');
      expect(payload.severity).toBe('P1');
      expect(payload.source).toBe('mineGo-circuit-breaker');
    });
  });
});