/**
 * 天气服务单元测试
 * 测试 OpenWeatherMap API 集成、缓存策略、降级逻辑
 */

const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// Mock dependencies
const mockAxios = {
  get: sinon.stub()
};

const mockRedis = {
  getJSON: sinon.stub(),
  setJSON: sinon.stub()
};

const mockLogger = {
  debug: sinon.stub(),
  info: sinon.stub(),
  warn: sinon.stub(),
  error: sinon.stub()
};

const mockMetrics = {
  register: {
    getSingleMetric: sinon.stub().returns(null),
    contentType: 'text/plain'
  },
  client: {
    Counter: sinon.stub().returns({ inc: sinon.stub() })
  }
};

// Load module with mocks
const weatherService = proxyquire('../../../backend/shared/weatherService', {
  'axios': mockAxios,
  './redis': mockRedis,
  './logger': {
    createLogger: () => mockLogger
  },
  './metrics': mockMetrics
});

describe('Weather Service', () => {
  beforeEach(() => {
    // Reset all stubs
    sinon.resetHistory();
    mockAxios.get.reset();
    mockRedis.getJSON.reset();
    mockRedis.setJSON.reset();
    
    // Set API key for tests
    process.env.OPENWEATHERMAP_API_KEY = 'test_api_key';
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getWeather()', () => {
    it('should return cached weather data when available', async () => {
      const cachedData = {
        weather: 'SUNNY',
        temperature: 25,
        humidity: 60,
        description: '晴朗',
        icon: '01d',
        weatherCode: 800,
        location: 'Beijing',
        updatedAt: new Date().toISOString()
      };

      mockRedis.getJSON.resolves(cachedData);

      const result = await weatherService.getWeather(39.9042, 116.4074);

      assert.strictEqual(result.weather, 'SUNNY');
      assert.strictEqual(result.temperature, 25);
      assert.ok(mockRedis.getJSON.calledOnce);
      assert.ok(mockAxios.get.notCalled);
    });

    it('should fetch weather from API when cache miss', async () => {
      mockRedis.getJSON.resolves(null);
      
      const apiResponse = {
        data: {
          weather: [{ id: 800, description: '晴朗', icon: '01d' }],
          main: { temp: 25, humidity: 60 },
          wind: { speed: 3.5 },
          name: 'Beijing'
        }
      };
      
      mockAxios.get.resolves(apiResponse);
      mockRedis.setJSON.resolves();

      const result = await weatherService.getWeather(39.9042, 116.4074);

      assert.strictEqual(result.weather, 'SUNNY');
      assert.strictEqual(result.temperature, 25);
      assert.strictEqual(result.humidity, 60);
      assert.strictEqual(result.location, 'Beijing');
      assert.strictEqual(result.fallback, false);
      
      assert.ok(mockAxios.get.calledOnce);
      assert.ok(mockRedis.setJSON.calledOnce);
    });

    it('should map OpenWeatherMap codes correctly', async () => {
      const testCases = [
        { code: 800, expected: 'SUNNY', description: 'Clear sky' },
        { code: 801, expected: 'CLOUDY', description: 'Few clouds' },
        { code: 500, expected: 'RAINY', description: 'Light rain' },
        { code: 600, expected: 'SNOWY', description: 'Light snow' },
        { code: 955, expected: 'WINDY', description: 'Fresh breeze' },
        { code: 741, expected: 'FOGGY', description: 'Fog' },
        { code: 211, expected: 'RAINY', description: 'Thunderstorm' }
      ];

      for (const testCase of testCases) {
        mockRedis.getJSON.resolves(null);
        mockAxios.get.resolves({
          data: {
            weather: [{ id: testCase.code, description: testCase.description, icon: '01d' }],
            main: { temp: 20, humidity: 50 },
            wind: { speed: 5 },
            name: 'Test'
          }
        });

        const result = await weatherService.getWeather(0, 0);
        assert.strictEqual(result.weather, testCase.expected);
        
        sinon.resetHistory();
        mockRedis.getJSON.reset();
        mockAxios.get.reset();
      }
    });

    it('should fallback to time-based simulation on API error', async () => {
      mockRedis.getJSON.resolves(null);
      mockAxios.get.rejects(new Error('Network error'));

      const result = await weatherService.getWeather(39.9042, 116.4074);

      assert.strictEqual(result.fallback, true);
      assert.ok(result.description.includes('模拟数据'));
      assert.ok(['SUNNY', 'CLOUDY', 'FOGGY', 'SNOWY'].includes(result.weather));
    });

    it('should fallback when API key is not configured', async () => {
      delete process.env.OPENWEATHERMAP_API_KEY;
      
      mockRedis.getJSON.resolves(null);

      const result = await weatherService.getWeather(39.9042, 116.4074);

      assert.strictEqual(result.fallback, true);
      assert.ok(mockAxios.get.notCalled);
      
      process.env.OPENWEATHERMAP_API_KEY = 'test_api_key';
    });

    it('should cache weather data for 15 minutes', async () => {
      mockRedis.getJSON.resolves(null);
      mockAxios.get.resolves({
        data: {
          weather: [{ id: 800, description: 'Clear', icon: '01d' }],
          main: { temp: 20, humidity: 50 },
          wind: { speed: 5 },
          name: 'Test'
        }
      });
      mockRedis.setJSON.resolves();

      await weatherService.getWeather(39.90, 116.40);

      assert.ok(mockRedis.setJSON.calledOnce);
      
      const cacheCall = mockRedis.setJSON.getCall(0);
      assert.ok(cacheCall.args[0].includes('weather:'));
      assert.strictEqual(cacheCall.args[2], 900); // 15 minutes TTL
    });

    it('should round coordinates to 2 decimal places for cache key', async () => {
      mockRedis.getJSON.resolves(null);
      mockAxios.get.resolves({
        data: {
          weather: [{ id: 800, description: 'Clear', icon: '01d' }],
          main: { temp: 20, humidity: 50 },
          wind: { speed: 5 },
          name: 'Test'
        }
      });

      await weatherService.getWeather(39.904213, 116.407426);

      const cacheCall = mockRedis.getJSON.getCall(0);
      assert.ok(cacheCall.args[0] === 'weather:39.90:116.41');
    });
  });

  describe('getFallbackWeather()', () => {
    it('should return FOGGY at night (before 6 AM)', () => {
      const hour = 3;
      const clock = sinon.useFakeTimers(new Date(2026, 0, 1, hour, 0, 0));
      
      const result = weatherService.getFallbackWeather(0, 0);
      
      assert.strictEqual(result.weather, 'FOGGY');
      assert.strictEqual(result.fallback, true);
      
      clock.restore();
    });

    it('should return FOGGY at night (after 8 PM)', () => {
      const hour = 22;
      const clock = sinon.useFakeTimers(new Date(2026, 0, 1, hour, 0, 0));
      
      const result = weatherService.getFallbackWeather(0, 0);
      
      assert.strictEqual(result.weather, 'FOGGY');
      
      clock.restore();
    });

    it('should return SUNNY during midday (11-15)', () => {
      const hour = 13;
      const clock = sinon.useFakeTimers(new Date(2026, 5, 15, hour, 0, 0)); // June
      
      const result = weatherService.getFallbackWeather(0, 0);
      
      assert.strictEqual(result.weather, 'SUNNY');
      assert.strictEqual(result.temperature, 32); // Summer temp
      
      clock.restore();
    });

    it('should return CLOUDY during other hours', () => {
      const hour = 9;
      const clock = sinon.useFakeTimers(new Date(2026, 0, 1, hour, 0, 0));
      
      const result = weatherService.getFallbackWeather(0, 0);
      
      assert.strictEqual(result.weather, 'CLOUDY');
      
      clock.restore();
    });

    it('should adjust temperature for winter months', () => {
      const hour = 13;
      const month = 11; // December
      const clock = sinon.useFakeTimers(new Date(2026, month, 1, hour, 0, 0));
      
      const result = weatherService.getFallbackWeather(0, 0);
      
      assert.ok(result.temperature < 10);
      
      clock.restore();
    });

    it('should return SNOWY in winter during midday', () => {
      const hour = 13;
      const month = 0; // January
      const clock = sinon.useFakeTimers(new Date(2026, month, 15, hour, 0, 0));
      
      const result = weatherService.getFallbackWeather(0, 0);
      
      assert.strictEqual(result.weather, 'SNOWY');
      
      clock.restore();
    });
  });

  describe('getBoostedTypes()', () => {
    it('should return correct boosted types for each weather', () => {
      const testCases = [
        { weather: 'SUNNY', expected: ['FIRE', 'GRASS', 'GROUND'] },
        { weather: 'RAINY', expected: ['WATER', 'ELECTRIC', 'BUG'] },
        { weather: 'CLOUDY', expected: ['NORMAL', 'POISON', 'FAIRY'] },
        { weather: 'SNOWY', expected: ['ICE', 'STEEL'] },
        { weather: 'WINDY', expected: ['DRAGON', 'FLYING', 'PSYCHIC'] },
        { weather: 'FOGGY', expected: ['GHOST', 'DARK'] }
      ];

      for (const testCase of testCases) {
        const result = weatherService.getBoostedTypes(testCase.weather);
        assert.deepStrictEqual(result, testCase.expected);
      }
    });

    it('should return empty array for unknown weather', () => {
      const result = weatherService.getBoostedTypes('UNKNOWN');
      assert.deepStrictEqual(result, []);
    });
  });

  describe('getTypeNameZh()', () => {
    it('should return Chinese name for known types', () => {
      const testCases = [
        { type: 'FIRE', expected: '火' },
        { type: 'WATER', expected: '水' },
        { type: 'GRASS', expected: '草' },
        { type: 'ELECTRIC', expected: '电' },
        { type: 'DRAGON', expected: '龙' }
      ];

      for (const testCase of testCases) {
        const result = weatherService.getTypeNameZh(testCase.type);
        assert.strictEqual(result, testCase.expected);
      }
    });

    it('should return original type for unknown types', () => {
      const result = weatherService.getTypeNameZh('UNKNOWN_TYPE');
      assert.strictEqual(result, 'UNKNOWN_TYPE');
    });
  });

  describe('isWeatherBoosted()', () => {
    it('should return true for boosted types', () => {
      assert.strictEqual(weatherService.isWeatherBoosted('FIRE', 'SUNNY'), true);
      assert.strictEqual(weatherService.isWeatherBoosted('WATER', 'RAINY'), true);
      assert.strictEqual(weatherService.isWeatherBoosted('ICE', 'SNOWY'), true);
    });

    it('should return false for non-boosted types', () => {
      assert.strictEqual(weatherService.isWeatherBoosted('WATER', 'SUNNY'), false);
      assert.strictEqual(weatherService.isWeatherBoosted('FIRE', 'RAINY'), false);
    });

    it('should return false for unknown weather', () => {
      assert.strictEqual(weatherService.isWeatherBoosted('FIRE', 'UNKNOWN'), false);
    });
  });

  describe('Error handling', () => {
    it('should handle invalid lat/lng parameters', async () => {
      try {
        await weatherService.getWeather('invalid', 'params');
        assert.fail('Should have thrown an error');
      } catch (err) {
        assert.ok(err.message.includes('Invalid'));
      }
    });

    it('should handle cache read errors gracefully', async () => {
      mockRedis.getJSON.rejects(new Error('Redis connection error'));
      mockAxios.get.resolves({
        data: {
          weather: [{ id: 800, description: 'Clear', icon: '01d' }],
          main: { temp: 20, humidity: 50 },
          wind: { speed: 5 },
          name: 'Test'
        }
      });

      const result = await weatherService.getWeather(39.90, 116.40);
      
      assert.strictEqual(result.weather, 'SUNNY');
      assert.ok(mockAxios.get.calledOnce);
    });

    it('should handle API timeout', async () => {
      mockRedis.getJSON.resolves(null);
      mockAxios.get.rejects({ code: 'ECONNABORTED', message: 'Timeout' });

      const result = await weatherService.getWeather(39.90, 116.40);
      
      assert.strictEqual(result.fallback, true);
    });
  });
});
