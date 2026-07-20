      };
      
      const result = await service.verifySignature(request);
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('INVALID_KEY_VERSION');
    });
  });

  describe('requiresSignature', () => {
    test('should require signature for sensitive endpoints', () => {
      expect(service.requiresSignature('POST', '/v1/pokemon/catch')).toBe(true);
      expect(service.requiresSignature('POST', '/v1/trade/confirm')).toBe(true);
      expect(service.requiresSignature('POST', '/v1/payment/initialize')).toBe(true);
      expect(service.requiresSignature('DELETE', '/v1/pokemon/12345')).toBe(true);
    });

    test('should not require signature for non-sensitive endpoints', () => {
      expect(service.requiresSignature('GET', '/v1/pokemon/inventory')).toBe(false);
      expect(service.requiresSignature('GET', '/v1/health')).toBe(false);
      expect(service.requiresSignature('POST', '/v1/auth/login')).toBe(false);
    });

    test('should match wildcard patterns', () => {
      expect(service.requiresSignature('DELETE', '/v1/pokemon/abc123')).toBe(true);
      expect(service.requiresSignature('DELETE', '/v1/pokemon/xyz789')).toBe(true);
    });
  });

  describe('rotateKey', () => {
    test('should rotate key successfully', async () => {
      const newKey = crypto.randomBytes(32).toString('hex');
      const newVersion = await service.rotateKey(newKey);
      
      expect(newVersion).toMatch(/^v\d+$/);
      expect(service.getActiveKey('current')).toBe(newKey);
      expect(service.getActiveKey(newVersion)).toBe(newKey);
    });

    test('should keep old key as backup', async () => {
      const oldKey = service.getActiveKey('current');
      const newKey = crypto.randomBytes(32).toString('hex');
      
      await service.rotateKey(newKey);
      
      // 新密钥应该是当前密钥
      expect(service.getActiveKey('current')).toBe(newKey);
      
      // 旧密钥应该还在密钥库中
      const stats = service.getStats();
      expect(stats.keyVersions.length).toBeGreaterThan(1);
    });

    test('should emit key_rotated event', async () => {
      const eventHandler = jest.fn();
      service.on('key_rotated', eventHandler);
      
      const newKey = crypto.randomBytes(32).toString('hex');
      await service.rotateKey(newKey);
      
      expect(eventHandler).toHaveBeenCalled();
      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          newVersion: expect.any(String),
          timestamp: expect.any(String)
        })
      );
    });
  });

  describe('addSensitiveEndpoint', () => {
    test('should add sensitive endpoint', () => {
      service.addSensitiveEndpoint('POST', '/v1/custom/action');
      
      expect(service.requiresSignature('POST', '/v1/custom/action')).toBe(true);
    });
  });

  describe('removeSensitiveEndpoint', () => {
    test('should remove sensitive endpoint', () => {
      service.addSensitiveEndpoint('POST', '/v1/custom/action');
      service.removeSensitiveEndpoint('POST', '/v1/custom/action');
      
      expect(service.requiresSignature('POST', '/v1/custom/action')).toBe(false);
    });
  });

  describe('getStats', () => {
    test('should return service statistics', () => {
      const stats = service.getStats();
      
      expect(stats).toHaveProperty('keyVersions');
      expect(stats).toHaveProperty('nonceCacheSize');
      expect(stats).toHaveProperty('sensitiveEndpoints');
      expect(stats).toHaveProperty('keyCreatedAt');
      expect(stats).toHaveProperty('maxTimestampDrift');
      expect(stats).toHaveProperty('nonceExpiry');
    });
  });

  describe('cleanupExpiredNonces', () => {
    test('should clean up expired nonces', (done) => {
      const method = 'POST';
      const path = '/v1/pokemon/catch';
      const body = { pokemonId: '12345' };
      
      // 添加一个 nonce
      service.generateSignature(method, path, body);
      
      const initialSize = service.nonceCache.size;
      expect(initialSize).toBeGreaterThan(0);
      
      // 手动清理过期 nonce（设置过期时间为 1ms）
      service.nonceExpiry = 1;
      setTimeout(() => {
        service.cleanupExpiredNonces();
        const finalSize = service.nonceCache.size;
        
        expect(finalSize).toBeLessThan(initialSize);
        done();
      }, 10);
    });
  });
});
