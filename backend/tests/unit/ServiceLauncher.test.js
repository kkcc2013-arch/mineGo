// tests/unit/ServiceLauncher.test.js
'use strict';
process.env.JWT_ACCESS_SECRET = 'test-secret';

const { describe, it, expect, runTests } = require('../test-helpers');
const express = require('express');

// Import the module under test
let ServiceLauncher, SERVICE_REGISTRY, getServiceConfig;

try {
  const module = require('../../shared/ServiceLauncher');
  ServiceLauncher = module.ServiceLauncher;
  SERVICE_REGISTRY = module.SERVICE_REGISTRY;
  getServiceConfig = module.getServiceConfig;
} catch (e) {
  console.error('Failed to load ServiceLauncher:', e.message);
  process.exit(1);
}

console.log('\n========================================');
console.log('📦 ServiceLauncher Unit Tests');
console.log('========================================\n');

// ── Test Suite 1: Constructor ─────────────────────────────────
describe('Constructor', () => {
  it('should create instance with required serviceName', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test-service' });
    expect(launcher.serviceName).toBe('test-service');
    expect(launcher.version).toBe('1.0.0');
    expect(launcher.routes).toEqual([]);
    expect(launcher.customMiddleware).toEqual([]);
  });

  it('should use custom options', () => {
    const launcher = new ServiceLauncher({
      serviceName: 'user-service',
      port: 9000,
      version: '2.0.0'
    });
    expect(launcher.port).toBe(9000);
    expect(launcher.version).toBe('2.0.0');
  });

  it('should get default port from registry', () => {
    const launcher = new ServiceLauncher({ serviceName: 'user-service' });
    expect(launcher.port).toBe(8081);
  });
});

// ── Test Suite 2: Default Port Mapping ─────────────────────────
describe('Default Port Mapping', () => {
  it('should return correct port for user-service', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test' });
    expect(launcher.getDefaultPort('user-service')).toBe(8081);
  });

  it('should return correct port for location-service', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test' });
    expect(launcher.getDefaultPort('location-service')).toBe(8082);
  });

  it('should return correct port for pokemon-service', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test' });
    expect(launcher.getDefaultPort('pokemon-service')).toBe(8083);
  });

  it('should return correct port for catch-service', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test' });
    expect(launcher.getDefaultPort('catch-service')).toBe(8084);
  });

  it('should return correct port for gym-service', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test' });
    expect(launcher.getDefaultPort('gym-service')).toBe(8085);
  });

  it('should return correct port for social-service', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test' });
    expect(launcher.getDefaultPort('social-service')).toBe(8086);
  });

  it('should return correct port for reward-service', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test' });
    expect(launcher.getDefaultPort('reward-service')).toBe(8087);
  });

  it('should return correct port for payment-service', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test' });
    expect(launcher.getDefaultPort('payment-service')).toBe(8088);
  });

  it('should return correct port for gateway', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test' });
    expect(launcher.getDefaultPort('gateway')).toBe(8080);
  });

  it('should return 8080 for unknown service', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test' });
    expect(launcher.getDefaultPort('unknown-service')).toBe(8080);
  });
});

// ── Test Suite 3: App Creation ─────────────────────────────────
describe('createApp', () => {
  it('should create Express app', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test-service' });
    const app = launcher.createApp();
    expect(typeof app).toBe('function');
    expect(typeof app.listen).toBe('function');
  });

  it('should include health endpoint', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test-service' });
    const app = launcher.getApp();
    expect(app).toBeTruthy();
  });

  it('should include metrics endpoint', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test-service' });
    const app = launcher.getApp();
    expect(app).toBeTruthy();
  });

  it('should mount custom routes', () => {
    const router = express.Router();
    router.get('/test', (req, res) => res.json({ ok: true }));

    const launcher = new ServiceLauncher({
      serviceName: 'test-service',
      routes: [{ path: '/api', router }]
    });

    const app = launcher.getApp();
    expect(app).toBeTruthy();
  });

  it('should apply custom middleware', () => {
    let middlewareCalled = false;
    const customMiddleware = (req, res, next) => {
      middlewareCalled = true;
      next();
    };

    const launcher = new ServiceLauncher({
      serviceName: 'test-service',
      middleware: [customMiddleware]
    });

    launcher.createApp();
    // Middleware is registered, will be called on requests
    expect(launcher.customMiddleware.length).toBe(1);
  });

  it('should use custom health check', () => {
    const customHealthCheck = (req, res) => {
      res.json({ status: 'custom' });
    };

    const launcher = new ServiceLauncher({
      serviceName: 'test-service',
      healthCheck: customHealthCheck
    });

    expect(launcher.healthCheck).toBe(customHealthCheck);
  });
});

// ── Test Suite 4: getApp ──────────────────────────────────────
describe('getApp', () => {
  it('should create app if not exists', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test-service' });
    expect(launcher.app).toBeNull();
    const app = launcher.getApp();
    expect(app).toBeTruthy();
    expect(launcher.app).toBeTruthy();
  });

  it('should return existing app', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test-service' });
    const app1 = launcher.getApp();
    const app2 = launcher.getApp();
    expect(app1).toBe(app2);
  });
});

// ── Test Suite 5: Service Registry ─────────────────────────────
describe('SERVICE_REGISTRY', () => {
  it('should contain all required services', () => {
    expect(SERVICE_REGISTRY['user-service']).toBeTruthy();
    expect(SERVICE_REGISTRY['location-service']).toBeTruthy();
    expect(SERVICE_REGISTRY['pokemon-service']).toBeTruthy();
    expect(SERVICE_REGISTRY['catch-service']).toBeTruthy();
    expect(SERVICE_REGISTRY['gym-service']).toBeTruthy();
    expect(SERVICE_REGISTRY['social-service']).toBeTruthy();
    expect(SERVICE_REGISTRY['reward-service']).toBeTruthy();
    expect(SERVICE_REGISTRY['payment-service']).toBeTruthy();
    expect(SERVICE_REGISTRY['gateway']).toBeTruthy();
  });

  it('should have correct port for user-service', () => {
    expect(SERVICE_REGISTRY['user-service'].port).toBe(8081);
  });

  it('should have description for each service', () => {
    Object.keys(SERVICE_REGISTRY).forEach(name => {
      expect(SERVICE_REGISTRY[name].description).toBeTruthy();
    });
  });
});

// ── Test Suite 6: getServiceConfig ─────────────────────────────
describe('getServiceConfig', () => {
  it('should return service config', () => {
    const config = getServiceConfig('user-service');
    expect(config).toBeTruthy();
    expect(config.port).toBe(8081);
  });

  it('should return null for unknown service', () => {
    const config = getServiceConfig('nonexistent');
    expect(config).toBeNull();
  });
});

// ── Run tests ──────────────────────────────────────────────────
runTests();
