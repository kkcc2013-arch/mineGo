// backend/tests/unit/api-version.test.js
// REQ-00044: API 版本管理单元测试
'use strict';

const assert = require('assert');
const {
  apiVersionMiddleware,
  registerVersionedRoute,
  requireVersion,
  getVersionInfo,
  checkVersionCompatibility,
  getChangelog,
  extractVersionFromPath,
  API_VERSIONS,
  CURRENT_VERSION,
  SUPPORTED_VERSIONS,
  MIN_SUPPORTED_VERSION,
  MAX_SUPPORTED_VERSION,
} = require('../../gateway/src/middleware/apiVersion');

describe('API Version Middleware', () => {
  
  describe('extractVersionFromPath', () => {
    
    it('should extract version from valid path', () => {
      assert.strictEqual(extractVersionFromPath('/api/v1/users'), 1);
      assert.strictEqual(extractVersionFromPath('/api/v2/catch/nearby'), 2);
      assert.strictEqual(extractVersionFromPath('/api/v2/pokemon/123'), 2);
    });
    
    it('should return null for path without version', () => {
      assert.strictEqual(extractVersionFromPath('/api/users'), null);
      assert.strictEqual(extractVersionFromPath('/users'), null);
      assert.strictEqual(extractVersionFromPath('/'), null);
    });
    
    it('should extract version from various path formats', () => {
      assert.strictEqual(extractVersionFromPath('/api/v1/'), 1);
      assert.strictEqual(extractVersionFromPath('/api/v10/something'), 10);
    });
  });
  
  describe('apiVersionMiddleware', () => {
    
    const mockReq = (path, headers = {}) => ({
      path,
      headers: { ...headers },
      method: 'GET',
    });
    
    const mockRes = () => {
      const headers = {};
      return {
        headers,
        setHeader: (key, value) => { headers[key] = value; },
        status: (code) => ({
          json: (data) => ({ statusCode: code, body: data }),
        }),
      };
    };
    
    it('should set current version for path without version', (done) => {
      const req = mockReq('/api/users');
      const res = mockRes();
      
      apiVersionMiddleware(req, res, () => {
        assert.strictEqual(req.apiVersion, CURRENT_VERSION);
        assert.strictEqual(res.headers['X-API-Version'], CURRENT_VERSION);
        done();
      });
    });
    
    it('should extract version from path', (done) => {
      const req = mockReq('/api/v1/users');
      const res = mockRes();
      
      apiVersionMiddleware(req, res, () => {
        assert.strictEqual(req.apiVersion, 1);
        assert.strictEqual(res.headers['X-API-Version'], 1);
        done();
      });
    });
    
    it('should use header version when specified', (done) => {
      const req = mockReq('/api/users', { 'accept-version': '2' });
      const res = mockRes();
      
      apiVersionMiddleware(req, res, () => {
        assert.strictEqual(req.apiVersion, 2);
        assert.strictEqual(res.headers['X-API-Version'], 2);
        done();
      });
    });
    
    it('should prefer path version over header', (done) => {
      const req = mockReq('/api/v1/users', { 'accept-version': '2' });
      const res = mockRes();
      
      apiVersionMiddleware(req, res, () => {
        assert.strictEqual(req.apiVersion, 1);
        done();
      });
    });
    
    it('should reject unsupported version', () => {
      const req = mockReq('/api/v99/users');
      const res = mockRes();
      
      const result = apiVersionMiddleware(req, res, () => {});
      
      assert.strictEqual(result.statusCode, 400);
      assert.strictEqual(result.body.code, 1010);
      assert.ok(result.body.data.supportedVersions.includes(1));
      assert.ok(result.body.data.supportedVersions.includes(2));
    });
    
    it('should set supported versions header', (done) => {
      const req = mockReq('/api/v1/users');
      const res = mockRes();
      
      apiVersionMiddleware(req, res, () => {
        const versions = res.headers['X-API-Supported-Versions'].split(', ');
        assert.ok(versions.includes('1'));
        assert.ok(versions.includes('2'));
        done();
      });
    });
    
    it('should set versionInfo on request', (done) => {
      const req = mockReq('/api/v2/users');
      const res = mockRes();
      
      apiVersionMiddleware(req, res, () => {
        assert.ok(req.versionInfo);
        assert.strictEqual(req.versionInfo.version, 2);
        assert.strictEqual(req.versionInfo.status, 'active');
        done();
      });
    });
  });
  
  describe('requireVersion', () => {
    
    const createReq = (version) => ({ apiVersion: version });
    const mockRes = () => ({
      status: (code) => ({
        json: (data) => ({ statusCode: code, body: data }),
      }),
    });
    
    it('should pass when version meets requirement', (done) => {
      const req = createReq(2);
      const res = mockRes();
      const middleware = requireVersion(1);
      
      middleware(req, res, () => {
        done();
      });
    });
    
    it('should reject when version is below requirement', () => {
      const req = createReq(1);
      const res = mockRes();
      const middleware = requireVersion(2);
      
      const result = middleware(req, res, () => {});
      
      assert.strictEqual(result.statusCode, 400);
      assert.strictEqual(result.body.code, 1011);
    });
    
    it('should pass when version equals requirement', (done) => {
      const req = createReq(2);
      const res = mockRes();
      const middleware = requireVersion(2);
      
      middleware(req, res, () => {
        done();
      });
    });
  });
  
  describe('getVersionInfo', () => {
    
    it('should return all versions when no version specified', () => {
      const info = getVersionInfo();
      
      assert.strictEqual(info.currentVersion, CURRENT_VERSION);
      assert.deepStrictEqual(info.supportedVersions, SUPPORTED_VERSIONS);
      assert.ok(info.versions);
    });
    
    it('should return specific version info', () => {
      const info = getVersionInfo(2);
      
      assert.strictEqual(info.version, 2);
      assert.strictEqual(info.status, 'active');
      assert.ok(info.released);
      assert.ok(Array.isArray(info.changes));
    });
    
    it('should return null for non-existent version', () => {
      const info = getVersionInfo(99);
      assert.strictEqual(info, null);
    });
  });
  
  describe('checkVersionCompatibility', () => {
    
    it('should return incompatible for unsupported version', () => {
      const result = checkVersionCompatibility(99);
      
      assert.strictEqual(result.compatible, false);
      assert.strictEqual(result.reason, 'unsupported');
    });
    
    it('should return compatible for active version', () => {
      const result = checkVersionCompatibility(2);
      
      assert.strictEqual(result.compatible, true);
      assert.strictEqual(result.deprecated, false);
    });
    
    it('should indicate deprecated version', () => {
      // 临时修改版本状态进行测试
      const originalStatus = API_VERSIONS[1].status;
      API_VERSIONS[1].status = 'deprecated';
      API_VERSIONS[1].deprecated = '2026-12-09T00:00:00Z';
      API_VERSIONS[1].sunset = '2027-06-09T00:00:00Z';
      
      const result = checkVersionCompatibility(1);
      
      assert.strictEqual(result.compatible, true);
      assert.strictEqual(result.deprecated, true);
      assert.strictEqual(result.reason, 'deprecated');
      
      // 恢复原始状态
      API_VERSIONS[1].status = originalStatus;
      API_VERSIONS[1].deprecated = null;
      API_VERSIONS[1].sunset = null;
    });
  });
  
  describe('getChangelog', () => {
    
    it('should return changelog sorted by version descending', () => {
      const changelog = getChangelog();
      
      assert.ok(Array.isArray(changelog));
      assert.ok(changelog.length >= 2);
      
      // 验证排序（降序）
      for (let i = 0; i < changelog.length - 1; i++) {
        assert.ok(changelog[i].version >= changelog[i + 1].version);
      }
    });
    
    it('should include version details', () => {
      const changelog = getChangelog();
      const v2 = changelog.find(c => c.version === 2);
      
      assert.ok(v2);
      assert.ok(v2.released);
      assert.ok(v2.status);
      assert.ok(Array.isArray(v2.changes));
    });
  });
  
  describe('Constants', () => {
    
    it('should have correct current version', () => {
      assert.strictEqual(CURRENT_VERSION, 2);
    });
    
    it('should have supported versions', () => {
      assert.deepStrictEqual(SUPPORTED_VERSIONS, [1, 2]);
    });
    
    it('should have correct version range', () => {
      assert.strictEqual(MIN_SUPPORTED_VERSION, 1);
      assert.strictEqual(MAX_SUPPORTED_VERSION, 2);
    });
    
    it('should have API versions defined', () => {
      assert.ok(API_VERSIONS[1]);
      assert.ok(API_VERSIONS[2]);
    });
  });
  
  describe('registerVersionedRoute', () => {
    
    it('should register routes for each version', () => {
      const routes = [];
      const mockApp = {
        get: (path, handler) => { routes.push({ method: 'get', path, handler }); },
      };
      
      const handlerV1 = () => 'v1';
      const handlerV2 = () => 'v2';
      
      registerVersionedRoute(mockApp, {
        'GET /users': {
          v1: handlerV1,
          v2: handlerV2,
        },
      });
      
      // v1 路径
      assert.ok(routes.some(r => r.path === '/api/v1/users'));
      
      // v2 路径
      assert.ok(routes.some(r => r.path === '/api/v2/users'));
      
      // 当前版本别名
      assert.ok(routes.some(r => r.path === '/api/users'));
    });
    
    it('should skip unsupported versions', () => {
      const routes = [];
      const mockApp = {
        get: (path, handler) => { routes.push({ method: 'get', path, handler }); },
      };
      
      registerVersionedRoute(mockApp, {
        'GET /test': {
          v99: () => 'v99',
        },
      });
      
      assert.strictEqual(routes.length, 0);
    });
  });
});

describe('DeprecationTracker', () => {
  
  const { DeprecationTracker, getDeprecationTracker } = require('../../shared/deprecationTracker');
  
  describe('DeprecationTracker class', () => {
    
    it('should create instance with default options', () => {
      const tracker = new DeprecationTracker();
      
      assert.ok(tracker.deprecatedEndpoints);
      assert.ok(tracker.usageStats);
      assert.strictEqual(tracker.initialized, false);
    });
    
    it('should mark endpoint as deprecated', () => {
      const tracker = new DeprecationTracker();
      
      tracker.deprecate('/api/v1/test', {
        reason: 'API 更新',
        replacement: '/api/v2/test',
      });
      
      const record = tracker.getEndpoint('/api/v1/test');
      
      assert.ok(record);
      assert.strictEqual(record.reason, 'API 更新');
      assert.strictEqual(record.replacement, '/api/v2/test');
      assert.ok(record.deprecatedAt);
      assert.ok(record.sunsetAt);
    });
    
    it('should track usage', () => {
      const tracker = new DeprecationTracker();
      
      tracker.deprecate('/api/v1/test');
      tracker.trackUsage('/api/v1/test', 'client-1');
      tracker.trackUsage('/api/v1/test', 'client-1');
      tracker.trackUsage('/api/v1/test', 'client-2');
      
      const stats = tracker.getUsageStats('/api/v1/test');
      
      assert.strictEqual(stats['client-1'], 2);
      assert.strictEqual(stats['client-2'], 1);
    });
    
    it('should return all deprecated endpoints', () => {
      const tracker = new DeprecationTracker();
      
      tracker.deprecate('/api/v1/test1');
      tracker.deprecate('/api/v1/test2');
      
      const all = tracker.getAllDeprecated();
      
      assert.strictEqual(all.length, 2);
    });
    
    it('should check sunset status', () => {
      const tracker = new DeprecationTracker();
      
      // 已下线
      tracker.deprecate('/api/v1/expired', {
        sunsetAt: new Date(Date.now() - 1000).toISOString(),
      });
      
      // 未下线
      tracker.deprecate('/api/v1/active', {
        sunsetAt: new Date(Date.now() + 1000000).toISOString(),
      });
      
      const toSunset = tracker.checkSunset();
      
      assert.strictEqual(toSunset.length, 1);
      assert.strictEqual(toSunset[0].endpoint, '/api/v1/expired');
    });
    
    it('should return upcoming sunsets', () => {
      const tracker = new DeprecationTracker();
      
      // 15 天后下线
      tracker.deprecate('/api/v1/soon', {
        sunsetAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      });
      
      // 100 天后下线
      tracker.deprecate('/api/v1/later', {
        sunsetAt: new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString(),
      });
      
      const upcoming = tracker.getUpcomingSunsets(30);
      
      assert.strictEqual(upcoming.length, 1);
      assert.strictEqual(upcoming[0].endpoint, '/api/v1/soon');
    });
    
    it('should remove endpoint', () => {
      const tracker = new DeprecationTracker();
      
      tracker.deprecate('/api/v1/test');
      tracker.removeEndpoint('/api/v1/test');
      
      const record = tracker.getEndpoint('/api/v1/test');
      assert.strictEqual(record, undefined);
    });
  });
  
  describe('getDeprecationTracker singleton', () => {
    
    it('should return same instance', () => {
      const tracker1 = getDeprecationTracker();
      const tracker2 = getDeprecationTracker();
      
      assert.strictEqual(tracker1, tracker2);
    });
  });
});

// 运行测试
if (require.main === module) {
  const Mocha = require('mocha');
  const mocha = new Mocha();
  mocha.addFile(__filename);
  mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}

module.exports = {};
