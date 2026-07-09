// backend/shared/testUtils/ExternalMockServices.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('../logger');

const logger = createLogger('external-mock-services');

/**
 * 外部依赖 Mock 服务
 * 模拟第三方 API（推送、支付、地图）
 */
class ExternalMockServices {
  constructor(config = {}) {
    this.delayMs = config.delayMs || 50; // 模拟网络延迟
    this.failureRate = config.failureRate || 0; // 失败率（用于测试）
    this.responses = new Map();
    
    // 初始化默认响应
    this.setupDefaultResponses();
  }

  /**
   * 设置默认响应
   */
  setupDefaultResponses() {
    // FCM 推送响应
    this.responses.set('fcm:success', {
      messageId: uuidv4(),
      success: true,
      timestamp: new Date().toISOString()
    });
    
    this.responses.set('fcm:failure', {
      messageId: uuidv4(),
      success: false,
      error: 'InvalidRegistration',
      errorMessage: 'Invalid device token'
    });
    
    // APNs 推送响应
    this.responses.set('apns:success', {
      apnsId: uuidv4(),
      status: 200,
      timestamp: new Date().toISOString()
    });
    
    // 支付宝支付响应
    this.responses.set('alipay:success', {
      tradeNo: `ALIPAY_${Date.now()}`,
      outTradeNo: uuidv4(),
      status: 'TRADE_SUCCESS',
      totalAmount: '100.00',
      buyerId: '2088123456789012'
    });
    
    // 微信支付响应
    this.responses.set('wechat:success', {
      transactionId: `WX_${Date.now()}`,
      outTradeNo: uuidv4(),
      result: 'SUCCESS',
      totalFee: 10000,
      openid: 'oUpF8uMuAJ...'
    });
    
    // Google Maps 响应
    this.responses.set('gmaps:geocode', {
      results: [{
        formatted_address: '1600 Amphitheatre Parkway, Mountain View, CA',
        geometry: {
          location: { lat: 37.4224764, lng: -122.0842499 }
        },
        place_id: 'ChIJ2eUoC...'
      }],
      status: 'OK'
    });
    
    // 静态地图响应
    this.responses.set('gmaps:staticmap', {
      url: 'https://maps.googleapis.com/maps/api/staticmap?center=37.422,-122.084&zoom=15&size=400x400',
      expiresAt: new Date(Date.now() + 3600000).toISOString()
    });
  }

  /**
   * 模拟网络延迟
   */
  async simulateDelay() {
    if (this.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
  }

  /**
   * 模拟失败（根据失败率）
   */
  shouldFail() {
    return Math.random() < this.failureRate;
  }

  // ==================== 推送服务 Mock ====================

  /**
   * FCM 推送 Mock
   */
  async sendFCM(deviceToken, notification, data = {}) {
    await this.simulateDelay();
    
    if (this.shouldFail()) {
      logger.warn('FCM mock failure simulated');
      return this.responses.get('fcm:failure');
    }
    
    logger.info({ deviceToken, title: notification.title }, 'FCM mock sent');
    return {
      ...this.responses.get('fcm:success'),
      deviceToken,
      notification,
      data
    };
  }

  /**
   * APNs 推送 Mock
   */
  async sendAPNs(deviceToken, payload) {
    await this.simulateDelay();
    
    if (this.shouldFail()) {
      logger.warn('APNs mock failure simulated');
      return {
        apnsId: uuidv4(),
        status: 400,
        error: 'BadDeviceToken'
      };
    }
    
    logger.info({ deviceToken }, 'APNs mock sent');
    return {
      ...this.responses.get('apns:success'),
      deviceToken,
      payload
    };
  }

  /**
   * 批量推送 Mock
   */
  async sendBatchPush(messages) {
    await this.simulateDelay();
    
    return messages.map(msg => ({
      ...this.responses.get('fcm:success'),
      token: msg.token,
      success: !this.shouldFail()
    }));
  }

  // ==================== 支付服务 Mock ====================

  /**
   * 支付宝支付 Mock
   */
  async createAlipayOrder(order) {
    await this.simulateDelay();
    
    if (this.shouldFail()) {
      return {
        success: false,
        error: 'SYSTEM_ERROR',
        errorMessage: 'Alipay system error'
      };
    }
    
    const response = this.responses.get('alipay:success');
    logger.info({ orderId: order.orderId }, 'Alipay mock order created');
    
    return {
      success: true,
      ...response,
      outTradeNo: order.orderId,
      totalAmount: order.amount.toString()
    };
  }

  /**
   * 支付宝查询 Mock
   */
  async queryAlipayOrder(outTradeNo) {
    await this.simulateDelay();
    
    return {
      ...this.responses.get('alipay:success'),
      outTradeNo,
      status: this.shouldFail() ? 'TRADE_CLOSED' : 'TRADE_SUCCESS'
    };
  }

  /**
   * 微信支付 Mock
   */
  async createWechatOrder(order) {
    await this.simulateDelay();
    
    if (this.shouldFail()) {
      return {
        success: false,
        error: 'SYSTEMERROR',
        errorMessage: 'WeChat pay system error'
      };
    }
    
    const response = this.responses.get('wechat:success');
    logger.info({ orderId: order.orderId }, 'WeChat mock order created');
    
    return {
      success: true,
      ...response,
      outTradeNo: order.orderId,
      totalFee: Math.floor(order.amount * 100)
    };
  }

  /**
   * 微信支付查询 Mock
   */
  async queryWechatOrder(outTradeNo) {
    await this.simulateDelay();
    
    return {
      ...this.responses.get('wechat:success'),
      outTradeNo,
      result: this.shouldFail() ? 'FAIL' : 'SUCCESS'
    };
  }

  /**
   * Apple IAP Mock
   */
  async verifyAppleReceipt(receiptData) {
    await this.simulateDelay();
    
    return {
      status: this.shouldFail() ? 21002 : 0,
      receipt: {
        bundle_id: 'com.minego.game',
        transaction_id: uuidv4(),
        product_id: 'coins_100',
        purchase_date_ms: Date.now()
      },
      environment: 'Sandbox'
    };
  }

  /**
   * Google Play Billing Mock
   */
  async verifyGooglePurchase(packageName, productId, purchaseToken) {
    await this.simulateDelay();
    
    return {
      kind: 'androidpublisher#productPurchase',
      purchaseState: this.shouldFail() ? 1 : 0,
      consumptionState: 0,
      orderId: `GPA.${uuidv4()}`
    };
  }

  // ==================== 地图服务 Mock ====================

  /**
   * Google Maps 地理编码 Mock
   */
  async geocode(address) {
    await this.simulateDelay();
    
    const response = this.responses.get('gmaps:geocode');
    return {
      ...response,
      input: address,
      results: response.results.map(r => ({
        ...r,
        formatted_address: address
      }))
    };
  }

  /**
   * Google Maps 反向地理编码 Mock
   */
  async reverseGeocode(lat, lng) {
    await this.simulateDelay();
    
    return {
      results: [{
        formatted_address: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
        geometry: { location: { lat, lng } },
        address_components: [
          { long_name: 'Mountain View', short_name: 'Mountain View', types: ['locality'] },
          { long_name: 'CA', short_name: 'CA', types: ['administrative_area_level_1'] }
        ]
      }],
      status: 'OK'
    };
  }

  /**
   * Google Places 搜索 Mock
   */
  async searchPlaces(query, location, radius = 1000) {
    await this.simulateDelay();
    
    return {
      results: Array.from({ length: 5 }, (_, i) => ({
        place_id: `place_${i}_${uuidv4()}`,
        name: `${query} ${i + 1}`,
        vicinity: `${location.lat.toFixed(2)}, ${location.lng.toFixed(2)}`,
        geometry: {
          location: {
            lat: location.lat + (Math.random() - 0.5) * 0.01,
            lng: location.lng + (Math.random() - 0.5) * 0.01
          }
        },
        rating: 3 + Math.random() * 2,
        types: ['establishment', 'point_of_interest']
      })),
      status: 'OK'
    };
  }

  /**
   * 静态地图 Mock
   */
  async getStaticMap(center, zoom, size) {
    await this.simulateDelay();
    
    const response = this.responses.get('gmaps:staticmap');
    return {
      ...response,
      url: `https://maps.googleapis.com/maps/api/staticmap?center=${center.lat},${center.lng}&zoom=${zoom}&size=${size}`
    };
  }

  /**
   * 距离矩阵 Mock
   */
  async getDistanceMatrix(origins, destinations) {
    await this.simulateDelay();
    
    return {
      rows: origins.map(() => ({
        elements: destinations.map(() => ({
          distance: { text: '1.2 km', value: 1200 },
          duration: { text: '5 mins', value: 300 },
          status: 'OK'
        }))
      })),
      status: 'OK'
    };
  }

  // ==================== 其他服务 Mock ====================

  /**
   * 发送邮件 Mock
   */
  async sendEmail(to, subject, body) {
    await this.simulateDelay();
    
    if (this.shouldFail()) {
      return {
        success: false,
        error: 'EMAIL_SEND_FAILED'
      };
    }
    
    logger.info({ to, subject }, 'Email mock sent');
    return {
      success: true,
      messageId: `<${uuidv4()}@minego.example.com>`,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 发送短信 Mock
   */
  async sendSMS(phoneNumber, message) {
    await this.simulateDelay();
    
    if (this.shouldFail()) {
      return {
        success: false,
        error: 'SMS_SEND_FAILED'
      };
    }
    
    logger.info({ phoneNumber }, 'SMS mock sent');
    return {
      success: true,
      messageId: uuidv4(),
      status: 'delivered'
    };
  }

  /**
   * 文件上传 Mock
   */
  async uploadFile(file) {
    await this.simulateDelay();
    
    return {
      success: true,
      url: `https://cdn.minego.example.com/uploads/${uuidv4()}/${file.name}`,
      key: `uploads/${uuidv4()}/${file.name}`,
      size: file.size || 1024
    };
  }

  /**
   * 自定义 Mock
   */
  setMockResponse(service, key, response) {
    this.responses.set(`${service}:${key}`, response);
  }

  /**
   * 获取 Mock 响应
   */
  getMockResponse(service, key) {
    return this.responses.get(`${service}:${key}`);
  }

  /**
   * 清除所有 Mock 响应
   */
  clear() {
    this.responses.clear();
    this.setupDefaultResponses();
  }

  /**
   * 设置失败率（用于测试）
   */
  setFailureRate(rate) {
    this.failureRate = Math.max(0, Math.min(1, rate));
  }

  /**
   * 设置延迟（用于测试）
   */
  setDelay(ms) {
    this.delayMs = ms;
  }
}

// 导出单例
const mockServices = new ExternalMockServices();

module.exports = {
  ExternalMockServices,
  mockServices,
  createMockServices: (config) => new ExternalMockServices(config)
};