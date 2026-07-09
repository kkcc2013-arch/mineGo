// backend/shared/testUtils/__tests__/ExternalMockServices.test.js
'use strict';

const { ExternalMockServices, mockServices } = require('../ExternalMockServices');

describe('ExternalMockServices', () => {
  describe('FCM Push', () => {
    it('should send FCM notification', async () => {
      const result = await mockServices.sendFCM('device_token_123', {
        title: 'Test',
        body: 'Test message'
      });
      
      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });
    
    it('should simulate failure when failure rate is set', async () => {
      mockServices.setFailureRate(1.0);
      
      const result = await mockServices.sendFCM('device_token', { title: 'Test' });
      expect(result.success).toBe(false);
      
      mockServices.setFailureRate(0);
    });
  });
  
  describe('APNs Push', () => {
    it('should send APNs notification', async () => {
      const result = await mockServices.sendAPNs('device_token', { aps: { alert: 'Test' } });
      
      expect(result.status).toBe(200);
      expect(result.apnsId).toBeDefined();
    });
  });
  
  describe('Alipay', () => {
    it('should create alipay order', async () => {
      const result = await mockServices.createAlipayOrder({
        orderId: 'order_123',
        amount: 100
      });
      
      expect(result.success).toBe(true);
      expect(result.status).toBe('TRADE_SUCCESS');
    });
    
    it('should query alipay order', async () => {
      const result = await mockServices.queryAlipayOrder('order_123');
      expect(result.outTradeNo).toBe('order_123');
    });
  });
  
  describe('WeChat Pay', () => {
    it('should create wechat order', async () => {
      const result = await mockServices.createWechatOrder({
        orderId: 'order_456',
        amount: 50
      });
      
      expect(result.success).toBe(true);
      expect(result.result).toBe('SUCCESS');
    });
    
    it('should query wechat order', async () => {
      const result = await mockServices.queryWechatOrder('order_456');
      expect(result.outTradeNo).toBe('order_456');
    });
  });
  
  describe('Apple IAP', () => {
    it('should verify apple receipt', async () => {
      const result = await mockServices.verifyAppleReceipt('receipt_data');
      
      expect(result.status).toBe(0);
      expect(result.receipt).toBeDefined();
      expect(result.environment).toBe('Sandbox');
    });
  });
  
  describe('Google Play', () => {
    it('should verify google purchase', async () => {
      const result = await mockServices.verifyGooglePurchase(
        'com.minego.game',
        'coins_100',
        'purchase_token'
      );
      
      expect(result.purchaseState).toBe(0);
    });
  });
  
  describe('Google Maps', () => {
    it('should geocode address', async () => {
      const result = await mockServices.geocode('1600 Amphitheatre Parkway');
      
      expect(result.status).toBe('OK');
      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
    });
    
    it('should reverse geocode', async () => {
      const result = await mockServices.reverseGeocode(37.422, -122.084);
      
      expect(result.status).toBe('OK');
      expect(result.results[0]).toHaveProperty('formatted_address');
    });
    
    it('should search places', async () => {
      const result = await mockServices.searchPlaces(
        'Pokemon Gym',
        { lat: 37.422, lng: -122.084 },
        1000
      );
      
      expect(result.status).toBe('OK');
      expect(result.results.length).toBe(5);
    });
    
    it('should get static map', async () => {
      const result = await mockServices.getStaticMap(
        { lat: 37.422, lng: -122.084 },
        15,
        '400x400'
      );
      
      expect(result.url).toBeDefined();
      expect(result.url).toContain('37.422');
    });
    
    it('should get distance matrix', async () => {
      const result = await mockServices.getDistanceMatrix(
        [{ lat: 37.422, lng: -122.084 }],
        [{ lat: 37.423, lng: -122.085 }]
      );
      
      expect(result.status).toBe('OK');
      expect(result.rows).toBeDefined();
    });
  });
  
  describe('Other Services', () => {
    it('should send email', async () => {
      const result = await mockServices.sendEmail(
        'test@example.com',
        'Test Subject',
        'Test Body'
      );
      
      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });
    
    it('should send SMS', async () => {
      const result = await mockServices.sendSMS('+1234567890', 'Test message');
      
      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });
    
    it('should upload file', async () => {
      const result = await mockServices.uploadFile({
        name: 'test.jpg',
        size: 1024
      });
      
      expect(result.success).toBe(true);
      expect(result.url).toContain('https://');
    });
  });
  
  describe('Mock Management', () => {
    it('should set custom mock response', () => {
      mockServices.setMockResponse('custom', 'test', { custom: true });
      const result = mockServices.getMockResponse('custom', 'test');
      expect(result.custom).toBe(true);
    });
    
    it('should clear all mocks', () => {
      mockServices.setMockResponse('test', 'key', { data: true });
      mockServices.clear();
      
      const result = mockServices.getMockResponse('test', 'key');
      expect(result).toBeUndefined();
    });
    
    it('should set delay', () => {
      mockServices.setDelay(100);
      expect(mockServices.delayMs).toBe(100);
      
      mockServices.setDelay(0);
    });
    
    it('should set failure rate', () => {
      mockServices.setFailureRate(0.5);
      expect(mockServices.failureRate).toBe(0.5);
      
      mockServices.setFailureRate(0);
    });
  });
  
  describe('Simulate Delay', () => {
    it('should respect delay setting', async () => {
      mockServices.setDelay(50);
      
      const start = Date.now();
      await mockServices.sendEmail('test@example.com', 'Test', 'Test');
      const elapsed = Date.now() - start;
      
      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
      
      mockServices.setDelay(0);
    });
  });
});
