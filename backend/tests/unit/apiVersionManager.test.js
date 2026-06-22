/**
 * REQ-00044: API 版本管理单元测试
 */

'use strict';

const { 
  APIVersionManager, 
  apiVersionMiddleware,
  extractVersionFromPath,
  CURRENT_VERSION,
  SUPPORTED_VERSIONS
} = require('../apiVersionManager');

describe('APIVersionManager', () => {
  let manager;

  beforeEach(() => {
    manager = new APIVersionManager();
  });

  describe('getVersionInfo', () => {
    test('should return version info for valid version', () => {
      const info = manager.getVersionInfo(1);
      expect(info).toBeDefined();
      expect(info.released).toBe('2026-06-01');
    });

    test('should return null for invalid version', () => {
      const info = manager.getVersionInfo(999);
      expect(info).toBeNull();
    });
  });

  describe('getAllVersions', () => {
    test('should return all versions with status', () => {
      const versions = manager.getAllVersions();
      expect(versions.length).toBeGreaterThan(0);
      expect(versions[0]).toHaveProperty('version');
      expect(versions[0]).toHaveProperty('isCurrent');
      expect(versions[0]).toHaveProperty('isDeprecated');
    });
  });

  describe('isSupported', () => {
    test('should return true for supported versions', () => {
      expect(manager.isSupported(1)).toBe(true);
      expect(manager.isSupported(2)).toBe(true);
    });

    test('should return false for unsupported versions', () => {
      expect(manager.isSupported(999)).toBe(false);
    });
  });

  describe('isDeprecated', () => {
    test('should return false for non-deprecated versions', () => {
      expect(manager.isDeprecated(1)).toBe(false);
      expect(manager.isDeprecated(2)).toBe(false);
    });
  });

  describe('deprecateVersion', () => {
    test('should mark version as deprecated', () => {
      const info = manager.deprecateVersion(1);
      expect(info.deprecated).not.toBeNull();
      expect(info.sunset).not.toBeNull();
      expect(manager.isDeprecated(1)).toBe(true);
    });

    test('should calculate sunset date correctly', () => {
      const info = manager.deprecateVersion(1, { deprecationPeriod: 90 });
      const deprecatedDate = new Date(info.deprecated);
      const sunsetDate = new Date(info.sunset);
      const daysDiff = (sunsetDate - deprecatedDate) / (1000 * 60 * 60 * 24);
      expect(daysDiff).toBe(90);
    });

    test('should throw for unknown version', () => {
      expect(() => manager.deprecateVersion(999)).toThrow('Unknown API version');
    });
  });

  describe('recordUsage', () => {
    test('should record version usage', () => {
      manager.recordUsage(1, '/users');
      manager.recordUsage(1, '/users');
      manager.recordUsage(2, '/catch/nearby');
      
      const stats = manager.getUsageStats();
      expect(stats['1'].total).toBe(2);
      expect(stats['1'].endpoints['/users']).toBe(2);
      expect(stats['2'].total).toBe(1);
    });
  });

  describe('canSafelySunset', () => {
    test('should return true when usage is below threshold', () => {
      // 大量使用 v2，少量使用 v1
      for (let i = 0; i < 100; i++) {
        manager.recordUsage(2, '/users');
      }
      manager.recordUsage(1, '/users');
      
      expect(manager.canSafelySunset(1)).toBe(true);
    });

    test('should return false when usage is above threshold', () => {
      // 使用量相当
      for (let i = 0; i < 50; i++) {
        manager.recordUsage(1, '/users');
        manager.recordUsage(2, '/users');
      }
      
      expect(manager.canSafelySunset(1)).toBe(false);
    });
  });

  describe('getDeprecationWarning', () => {
    test('should return null for non-deprecated version', () => {
      const warning = manager.getDeprecationWarning(1);
      expect(warning).toBeNull();
    });

    test('should return warning for deprecated version', () => {
      manager.deprecateVersion(1);
      const warning = manager.getDeprecationWarning(1);
      
      expect(warning).toBeDefined();
      expect(warning.version).toBe(1);
      expect(warning.daysRemaining).toBeGreaterThan(0);
      expect(warning.message).toContain('已废弃');
    });
  });

  describe('addChange', () => {
    test('should add change to version', () => {
      manager.addChange(2, {
        type: 'added',
        path: '/api/v2/test',
        description: 'Test endpoint'
      });
      
      const info = manager.getVersionInfo(2);
      const lastChange = info.changes[info.changes.length - 1];
      expect(lastChange.path).toBe('/api/v2/test');
      expect(lastChange.date).toBeDefined();
    });
  });

  describe('generateChangelog', () => {
    test('should generate changelog between versions', () => {
      const changelog = manager.generateChangelog(1, 2);
      expect(changelog.length).toBeGreaterThan(0);
      expect(changelog[0].version).toBe(2);
      expect(changelog[0].changes).toBeDefined();
    });
  });
});

describe('extractVersionFromPath', () => {
  test('should extract version from v1 path', () => {
    expect(extractVersionFromPath('/api/v1/users')).toBe(1);
  });

  test('should extract version from v2 path', () => {
    expect(extractVersionFromPath('/api/v2/catch/nearby')).toBe(2);
  });

  test('should return null for unversioned path', () => {
    expect(extractVersionFromPath('/api/users')).toBeNull();
  });

  test('should return null for invalid path', () => {
    expect(extractVersionFromPath('/users')).toBeNull();
  });
});

describe('apiVersionMiddleware', () => {
  let middleware;
  let mockReq;
  let mockRes;
  let mockNext;

  beforeEach(() => {
    middleware = apiVersionMiddleware();
    mockReq = {
      path: '/api/v1/users',
      headers: {}
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      once: jest.fn()
    };
    mockNext = jest.fn();
  });

  test('should set apiVersion on request', () => {
    middleware(mockReq, mockRes, mockNext);
    expect(mockReq.apiVersion).toBe(1);
    expect(mockNext).toHaveBeenCalled();
  });

  test('should use header version if no path version', () => {
    mockReq.path = '/api/users';
    mockReq.headers['accept-version'] = '2';
    
    middleware(mockReq, mockRes, mockNext);
    expect(mockReq.apiVersion).toBe(2);
  });

  test('should use default version if no version specified', () => {
    mockReq.path = '/api/users';
    
    middleware(mockReq, mockRes, mockNext);
    expect(mockReq.apiVersion).toBe(CURRENT_VERSION);
  });

  test('should return 400 for unsupported version', () => {
    mockReq.path = '/api/v999/users';
    
    middleware(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 1044
    }));
    expect(mockNext).not.toHaveBeenCalled();
  });

  test('should set response headers', () => {
    middleware(mockReq, mockRes, mockNext);
    expect(mockRes.setHeader).toHaveBeenCalledWith('API-Version', '1');
  });
});

describe('VersionedRoutes', () => {
  const { VersionedRoutes } = require('../apiVersionManager');
  let mockApp;
  let versionedRoutes;

  beforeEach(() => {
    mockApp = {
      use: jest.fn()
    };
    versionedRoutes = new VersionedRoutes(mockApp);
  });

  test('should register versioned route', () => {
    const mockRouter = {};
    versionedRoutes.register(1, '/users', mockRouter);
    
    expect(mockApp.use).toHaveBeenCalledWith('/api/v1/users', mockRouter);
  });

  test('should support chaining', () => {
    const result = versionedRoutes.register(1, '/users', {});
    expect(result).toBe(versionedRoutes);
  });

  test('should track registered routes', () => {
    versionedRoutes.register(1, '/users', {});
    versionedRoutes.register(2, '/users', {});
    
    const routes = versionedRoutes.getRegisteredRoutes();
    expect(routes.length).toBe(2);
  });
});

describe('createVersionAdapter', () => {
  const { createVersionAdapter } = require('../apiVersionManager');

  test('should adapt response for version', () => {
    const adapters = {
      1: (data) => ({ ...data, version: 1 }),
      2: (data) => ({ ...data, version: 2 })
    };
    
    const middleware = createVersionAdapter(adapters);
    const mockReq = { apiVersion: 2 };
    const mockRes = {
      json: jest.fn()
    };
    const mockNext = jest.fn();
    
    middleware(mockReq, mockRes, mockNext);
    
    // 模拟调用 json
    mockRes.json({ data: 'test' });
    
    expect(mockRes.json).toHaveBeenCalledWith({ data: 'test', version: 2 });
  });
});

describe('requireMinVersion', () => {
  const { requireMinVersion } = require('../apiVersionManager');

  test('should pass for version >= minVersion', () => {
    const middleware = requireMinVersion(2);
    const mockReq = { apiVersion: 2 };
    const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const mockNext = jest.fn();
    
    middleware(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();
  });

  test('should reject for version < minVersion', () => {
    const middleware = requireMinVersion(2);
    const mockReq = { apiVersion: 1 };
    const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const mockNext = jest.fn();
    
    middleware(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockNext).not.toHaveBeenCalled();
  });
});
