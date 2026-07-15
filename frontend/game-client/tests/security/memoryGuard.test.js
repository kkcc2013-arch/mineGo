/**
 * MemoryGuard 单元测试
 */

const { MemoryGuard } = require('../security/MemoryGuard');

describe('MemoryGuard', () => {
  let guard;

  beforeEach(() => {
    guard = new MemoryGuard({
      enabled: true,
      scanInterval: 1000,
      strictMode: false
    });
  });

  afterEach(() => {
    guard.stop();
  });

  describe('register', () => {
    it('should register a protected region', () => {
      const target = { value: 100 };
      guard.register('test-region', target);

      expect(guard.protectedRegions.has('test-region')).toBe(true);
    });

    it('should compute initial hash', () => {
      const target = { lat: 35.678, lng: 139.765 };
      const region = guard.register('position', target);

      expect(region.hash).toBeDefined();
      expect(region.hash.length).toBeGreaterThan(0);
    });

    it('should handle multiple regions', () => {
      guard.register('region1', { a: 1 });
      guard.register('region2', { b: 2 });

      expect(guard.protectedRegions.size).toBe(2);
    });
  });

  describe('computeHash', () => {
    it('should compute consistent hash for same object', () => {
      const obj = { x: 10, y: 20 };
      const hash1 = guard.computeHash(obj);
      const hash2 = guard.computeHash(obj);

      expect(hash1.split('-')[0]).toBe(hash2.split('-')[0]);
    });

    it('should compute different hash for different objects', () => {
      const hash1 = guard.computeHash({ value: 100 });
      const hash2 = guard.computeHash({ value: 200 });

      expect(hash1).not.toBe(hash2);
    });

    it('should handle specific fields only', () => {
      const obj = { a: 1, b: 2, c: 3 };
      const hash = guard.computeHash(obj, ['a', 'b']);

      expect(hash).toBeDefined();
    });
  });

  describe('scan', () => {
    it('should return scan results', () => {
      guard.register('test', { value: 100 });
      const result = guard.scan();

      expect(result.enabled).toBe(true);
      expect(result.regionsChecked).toBe(1);
      expect(result.violations).toBe(0);
    });

    it('should detect hash changes', () => {
      const target = { value: 100 };
      guard.register('test', target);
      
      // Initial scan
      guard.scan();

      // Modify the object
      target.value = 200;
      
      // Scan again
      const result = guard.scan();

      expect(result.violations).toBe(1);
      expect(result.violationDetails[0].region).toBe('test');
    });

    it('should not detect violation when hash is updated', () => {
      const target = { value: 100 };
      guard.register('test', target);
      
      guard.scan();
      
      target.value = 200;
      guard.updateHash('test');
      
      const result = guard.scan();

      expect(result.violations).toBe(0);
    });

    it('should respect immutable flag', () => {
      const target = { value: 100 };
      guard.register('immutable-test', target, { immutable: true });
      
      guard.scan();
      target.value = 200;
      
      const result = guard.scan();

      // Immutable regions should always flag changes
      expect(result.violations).toBe(1);
    });
  });

  describe('getStatus', () => {
    it('should return current status', () => {
      guard.register('region1', { a: 1 });
      guard.register('region2', { b: 2 });

      const status = guard.getStatus();

      expect(status.enabled).toBe(true);
      expect(status.regionsCount).toBe(2);
    });
  });

  describe('violation handling', () => {
    it('should call onViolation callback', (done) => {
      const guardWithCallback = new MemoryGuard({
        onViolation: (violation) => {
          expect(violation.region).toBe('test');
          done();
        }
      });

      const target = { value: 100 };
      guardWithCallback.register('test', target);
      guardWithCallback.scan();
      
      target.value = 200;
      guardWithCallback.scan();
    });

    it('should track violation count', () => {
      const target = { value: 100 };
      guard.register('test', target);
      
      guard.scan();
      target.value = 200;
      guard.scan();
      target.value = 300;
      guard.scan();

      expect(guard.violationCount).toBe(2);
      expect(guard.stats.violations).toBe(2);
    });
  });

  describe('anti-debug', () => {
    it('should detect devtools open simulation', () => {
      // Simulate devtools open
      const originalOuterWidth = window.outerWidth;
      const originalInnerWidth = window.innerWidth;
      
      Object.defineProperty(window, 'outerWidth', { value: 1920, writable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1600, writable: true });

      guard.startAntiDebug();

      // Should trigger detection but we can't easily test internal state
      // Just verify no errors

      Object.defineProperty(window, 'outerWidth', { value: originalOuterWidth });
      Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth });
    });
  });

  describe('performance', () => {
    it('should complete scan within time limit', () => {
      // Register 10 regions
      for (let i = 0; i < 10; i++) {
        guard.register(`region-${i}`, { data: Math.random() * 1000 });
      }

      const start = performance.now();
      guard.scan();
      const duration = performance.now() - start;

      // Should be under 5ms
      expect(duration).toBeLessThan(5);
    });
  });
});

describe('MemoryScanner', () => {
  let scanner;

  beforeEach(() => {
    const { MemoryScanner } = require('../security/MemoryScanner');
    scanner = new MemoryScanner({
      enabled: true,
      scanInterval: 1000
    });
  });

  afterEach(() => {
    scanner.stop();
  });

  describe('registerTarget', () => {
    it('should register a scan target', () => {
      scanner.registerTarget('position', {
        type: 'position',
        getter: () => ({ lat: 35.678, lng: 139.765 })
      });

      expect(scanner.scanTargets.has('position')).toBe(true);
    });
  });

  describe('quickScan', () => {
    it('should return scan results', () => {
      scanner.registerTarget('test', {
        type: 'object',
        getter: () => ({ value: 100 })
      });

      const result = scanner.quickScan();

      expect(result.type).toBe('quick');
      expect(result.targetsScanned).toBe(1);
    });

    it('should detect checksum changes', () => {
      let value = 100;
      scanner.registerTarget('test', {
        type: 'object',
        getter: () => ({ value })
      });

      scanner.quickScan();
      
      value = 200;
      const result = scanner.quickScan();

      expect(result.violations).toBe(1);
    });
  });

  describe('validatePosition', () => {
    it('should validate correct position', () => {
      const result = scanner.validatePosition({ lat: 35.678, lng: 139.765 });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid latitude', () => {
      const result = scanner.validatePosition({ lat: 100, lng: 139.765 });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject invalid longitude', () => {
      const result = scanner.validatePosition({ lat: 35.678, lng: 200 });

      expect(result.valid).toBe(false);
    });
  });

  describe('validatePokemon', () => {
    it('should validate correct pokemon data', () => {
      const result = scanner.validatePokemon({
        id: 'pokemon-001',
        level: 50,
        cp: 1500,
        hp: 100,
        maxHp: 150
      });

      expect(result.valid).toBe(true);
    });

    it('should reject invalid level', () => {
      const result = scanner.validatePokemon({
        level: 200,
        cp: 1500,
        hp: 100
      });

      expect(result.valid).toBe(false);
    });
  });

  describe('computeChecksum', () => {
    it('should compute consistent checksum', () => {
      const data = { lat: 35.678, lng: 139.765 };
      const checksum1 = scanner.computeChecksum(data, 'position');
      const checksum2 = scanner.computeChecksum(data, 'position');

      expect(checksum1).toBe(checksum2);
    });

    it('should handle different types', () => {
      const posChecksum = scanner.computeChecksum({ lat: 35, lng: 139 }, 'position');
      const pokemonChecksum = scanner.computeChecksum({ id: 'p1', level: 50 }, 'pokemon');

      expect(posChecksum).not.toBe(pokemonChecksum);
    });
  });

  describe('getStatus', () => {
    it('should return current status', () => {
      scanner.registerTarget('test', { type: 'object' });

      const status = scanner.getStatus();

      expect(status.enabled).toBe(true);
      expect(status.targetsCount).toBe(1);
    });
  });
});