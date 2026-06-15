# REQ-00224: 国际化货币格式化与区域支付本地化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00224 |
| 标题 | 国际化货币格式化与区域支付本地化系统 |
| 类别 | 国际化/本地化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | payment-service、user-service、gateway、game-client、backend/shared |
| 创建时间 | 2026-06-15 17:00 |

## 需求描述

为支持全球化运营，实现完整的货币格式化与区域支付本地化系统：

1. **货币显示本地化**：根据用户区域设置，自动格式化货币显示（符号位置、小数分隔符、千位分隔符）
2. **支付方式本地化**：不同地区支持不同的主流支付方式（Alipay、WeChat Pay、PayPal、Stripe、Apple Pay、Google Pay 等）
3. **价格区域化**：支持不同地区的差异化定价策略
4. **货币转换透明化**：实时汇率转换与费用透明展示

### 核心目标
- 支持 50+ 国家/地区的货币格式化
- 集成 15+ 主流支付渠道
- 实现动态区域定价策略
- 提供透明的汇率转换信息

## 技术方案

### 1. 货币格式化服务

```javascript
// backend/shared/currencyFormatter.js

const CURRENCY_CONFIG = {
  'USD': { symbol: '$', position: 'before', decimals: 2, thousands: ',', decimal: '.' },
  'EUR': { symbol: '€', position: 'before', decimals: 2, thousands: '.', decimal: ',' },
  'JPY': { symbol: '¥', position: 'before', decimals: 0, thousands: ',', decimal: '.' },
  'CNY': { symbol: '¥', position: 'before', decimals: 2, thousands: ',', decimal: '.' },
  'GBP': { symbol: '£', position: 'before', decimals: 2, thousands: ',', decimal: '.' },
  'KRW': { symbol: '₩', position: 'before', decimals: 0, thousands: ',', decimal: '.' },
  'INR': { symbol: '₹', position: 'before', decimals: 2, thousands: ',', decimal: '.' },
  'BRL': { symbol: 'R$', position: 'before', decimals: 2, thousands: '.', decimal: ',' },
  // ... 更多货币配置
};

class CurrencyFormatter {
  /**
   * 格式化货币显示
   * @param {number} amount - 金额（最小单位，如分）
   * @param {string} currency - 货币代码
   * @param {string} locale - 区域设置
   * @param {Object} options - 格式化选项
   */
  format(amount, currency, locale = 'en-US', options = {}) {
    const config = CURRENCY_CONFIG[currency] || CURRENCY_CONFIG['USD'];
    const value = amount / Math.pow(10, config.decimals);
    
    // 使用 Intl.NumberFormat 进行本地化
    const formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: config.decimals,
      maximumFractionDigits: config.decimals,
    });
    
    return formatter.format(value);
  }

  /**
   * 解析本地化货币字符串
   */
  parse(formattedString, currency) {
    const config = CURRENCY_CONFIG[currency];
    // 移除符号和分隔符
    const cleaned = formattedString
      .replace(config.symbol, '')
      .replace(new RegExp(`\\${config.thousands}`, 'g'), '')
      .replace(config.decimal, '.')
      .trim();
    
    return Math.round(parseFloat(cleaned) * Math.pow(10, config.decimals));
  }

  /**
   * 获取货币符号
   */
  getSymbol(currency) {
    return CURRENCY_CONFIG[currency]?.symbol || currency;
  }
}

module.exports = new CurrencyFormatter();
```

### 2. 区域支付方式配置

```javascript
// backend/shared/regionalPaymentConfig.js

const REGIONAL_PAYMENT_METHODS = {
  'CN': {
    primary: ['alipay', 'wechat_pay'],
    secondary: ['unionpay'],
    currency: 'CNY',
    taxRate: 0.0,
    pricingMultiplier: 1.0,
  },
  'US': {
    primary: ['stripe', 'paypal', 'apple_pay', 'google_pay'],
    secondary: ['credit_card'],
    currency: 'USD',
    taxRate: 0.0, // 州税动态计算
    pricingMultiplier: 1.0,
  },
  'JP': {
    primary: ['stripe', 'apple_pay', 'google_pay', 'line_pay'],
    secondary: ['credit_card'],
    currency: 'JPY',
    taxRate: 0.10,
    pricingMultiplier: 1.1,
  },
  'EU': {
    primary: ['stripe', 'paypal', 'apple_pay', 'google_pay'],
    secondary: ['sepa', 'credit_card'],
    currency: 'EUR',
    taxRate: 0.0, // VAT 动态计算
    pricingMultiplier: 1.0,
  },
  'KR': {
    primary: ['kakao_pay', 'naver_pay', 'toss'],
    secondary: ['credit_card'],
    currency: 'KRW',
    taxRate: 0.10,
    pricingMultiplier: 1.0,
  },
  'BR': {
    primary: ['mercado_pago', 'pix'],
    secondary: ['credit_card'],
    currency: 'BRL',
    taxRate: 0.0,
    pricingMultiplier: 1.2,
  },
  'IN': {
    primary: ['razorpay', 'paytm', 'upi'],
    secondary: ['credit_card'],
    currency: 'INR',
    taxRate: 0.18,
    pricingMultiplier: 0.8,
  },
};

class RegionalPaymentConfig {
  /**
   * 获取用户区域的支付配置
   */
  getConfig(countryCode) {
    return REGIONAL_PAYMENT_METHODS[countryCode] || REGIONAL_PAYMENT_METHODS['US'];
  }

  /**
   * 获取可用的支付方式列表
   */
  getAvailableMethods(countryCode) {
    const config = this.getConfig(countryCode);
    return [...config.primary, ...config.secondary];
  }

  /**
   * 计算区域化价格
   */
  calculateRegionalPrice(basePriceUSD, countryCode) {
    const config = this.getConfig(countryCode);
    const exchangeRate = this.getExchangeRate(config.currency);
    
    // 基础价格 × 汇率 × 区域系数
    const regionalPrice = basePriceUSD * exchangeRate * config.pricingMultiplier;
    
    return {
      originalPrice: basePriceUSD,
      regionalPrice: Math.round(regionalPrice * 100), // 转为最小单位
      currency: config.currency,
      exchangeRate: exchangeRate,
      multiplier: config.pricingMultiplier,
    };
  }

  /**
   * 获取实时汇率（从缓存或外部API）
   */
  async getExchangeRate(targetCurrency) {
    // 优先从缓存获取
    const cached = await cache.get(`exchange_rate:${targetCurrency}`);
    if (cached) return parseFloat(cached);

    // 调用外部汇率API
    const response = await fetch(`https://api.exchangerate-api.com/v4/latest/USD`);
    const data = await response.json();
    const rate = data.rates[targetCurrency];
    
    // 缓存1小时
    await cache.set(`exchange_rate:${targetCurrency}`, rate.toString(), 3600);
    
    return rate;
  }
}

module.exports = new RegionalPaymentConfig();
```

### 3. 支付渠道适配器

```javascript
// backend/services/payment-service/src/adapters/PaymentAdapter.js

class PaymentAdapter {
  constructor() {
    this.adapters = {
      'alipay': new AlipayAdapter(),
      'wechat_pay': new WeChatPayAdapter(),
      'stripe': new StripeAdapter(),
      'paypal': new PayPalAdapter(),
      'apple_pay': new ApplePayAdapter(),
      'google_pay': new GooglePayAdapter(),
      'kakao_pay': new KakaoPayAdapter(),
      'razorpay': new RazorpayAdapter(),
      'mercado_pago': new MercadoPagoAdapter(),
      'pix': new PixAdapter(),
    };
  }

  /**
   * 创建支付订单
   */
  async createPayment(method, orderData) {
    const adapter = this.adapters[method];
    if (!adapter) {
      throw new Error(`Unsupported payment method: ${method}`);
    }

    return await adapter.createPayment(orderData);
  }

  /**
   * 处理支付回调
   */
  async handleCallback(method, callbackData) {
    const adapter = this.adapters[method];
    if (!adapter) {
      throw new Error(`Unsupported payment method: ${method}`);
    }

    return await adapter.handleCallback(callbackData);
  }

  /**
   * 查询支付状态
   */
  async queryPayment(method, transactionId) {
    const adapter = this.adapters[method];
    if (!adapter) {
      throw new Error(`Unsupported payment method: ${method}`);
    }

    return await adapter.queryPayment(transactionId);
  }

  /**
   * 处理退款
   */
  async refund(method, transactionId, amount, reason) {
    const adapter = this.adapters[method];
    if (!adapter) {
      throw new Error(`Unsupported payment method: ${method}`);
    }

    return await adapter.refund(transactionId, amount, reason);
  }
}

// 示例：Alipay 适配器
class AlipayAdapter {
  async createPayment(orderData) {
    const alipaySdk = this.getAlipaySdk();
    
    const result = await alipaySdk.exec('alipay.trade.page.pay', {
      notify_url: process.env.ALIPAY_NOTIFY_URL,
      return_url: process.env.ALIPAY_RETURN_URL,
      biz_content: {
        out_trade_no: orderData.orderId,
        total_amount: (orderData.amount / 100).toFixed(2),
        subject: orderData.subject,
        product_code: 'FAST_INSTANT_TRADE_PAY',
      },
    });

    return {
      paymentUrl: result,
      method: 'alipay',
    };
  }

  async handleCallback(callbackData) {
    const alipaySdk = this.getAlipaySdk();
    
    // 验证签名
    const signVerified = alipaySdk.checkNotifySign(callbackData);
    if (!signVerified) {
      throw new Error('Invalid Alipay callback signature');
    }

    return {
      orderId: callbackData.out_trade_no,
      transactionId: callbackData.trade_no,
      status: callbackData.trade_status === 'TRADE_SUCCESS' ? 'success' : 'failed',
      amount: Math.round(parseFloat(callbackData.total_amount) * 100),
    };
  }
}

module.exports = new PaymentAdapter();
```

### 4. 前端货币显示组件

```javascript
// game-client/src/components/CurrencyDisplay.js

import { useUserPreferences } from '../hooks/useUserPreferences';
import currencyFormatter from '../utils/currencyFormatter';

export function CurrencyDisplay({ amount, currency, showConversion = false }) {
  const { preferences } = useUserPreferences();
  const displayCurrency = currency || preferences.currency;
  const locale = preferences.locale || 'en-US';

  const formatted = currencyFormatter.format(amount, displayCurrency, locale);

  // 如果需要显示汇率转换
  let conversionInfo = null;
  if (showConversion && currency !== preferences.currency) {
    const converted = currencyFormatter.convert(amount, currency, preferences.currency);
    conversionInfo = (
      <span className="currency-conversion">
        ≈ {currencyFormatter.format(converted, preferences.currency, locale)}
      </span>
    );
  }

  return (
    <span className="currency-display">
      <span className="amount">{formatted}</span>
      {conversionInfo}
    </span>
  );
}

// 价格选择器
export function PriceSelector({ basePriceUSD, productId }) {
  const { countryCode, preferences } = useUserPreferences();
  const [pricing, setPricing] = useState(null);

  useEffect(() => {
    async function fetchPricing() {
      const response = await fetch(`/api/v1/payments/regional-pricing`, {
        method: 'POST',
        body: JSON.stringify({
          productId,
          countryCode,
          basePriceUSD,
        }),
      });
      const data = await response.json();
      setPricing(data);
    }
    fetchPricing();
  }, [countryCode, productId, basePriceUSD]);

  if (!pricing) return <Skeleton />;

  return (
    <div className="price-selector">
      <CurrencyDisplay amount={pricing.regionalPrice} currency={pricing.currency} />
      {pricing.multiplier !== 1.0 && (
        <span className="regional-badge">
          {pricing.multiplier < 1 ? '优惠价格' : '区域定价'}
        </span>
      )}
    </div>
  );
}
```

### 5. 区域定价管理 API

```javascript
// backend/services/payment-service/src/routes/regionalPricing.js

const express = require('express');
const router = express.Router();
const auth = require('../../shared/middleware/auth');
const regionalPaymentConfig = require('../../shared/regionalPaymentConfig');
const currencyFormatter = require('../../shared/currencyFormatter');

/**
 * 获取用户区域的支付配置
 */
router.get('/config', auth, async (req, res) => {
  const countryCode = req.user.countryCode || 'US';
  const config = regionalPaymentConfig.getConfig(countryCode);

  res.json({
    currency: config.currency,
    paymentMethods: regionalPaymentConfig.getAvailableMethods(countryCode),
    taxRate: config.taxRate,
    symbol: currencyFormatter.getSymbol(config.currency),
  });
});

/**
 * 计算区域化价格
 */
router.post('/regional-pricing', auth, async (req, res) => {
  const { productId, countryCode, basePriceUSD } = req.body;
  
  const pricing = await regionalPaymentConfig.calculateRegionalPrice(
    basePriceUSD,
    countryCode || req.user.countryCode
  );

  // 记录价格查询日志
  logger.info('Regional pricing calculated', {
    productId,
    userId: req.user.id,
    countryCode,
    ...pricing,
  });

  res.json(pricing);
});

/**
 * 获取支持的货币列表
 */
router.get('/currencies', async (req, res) => {
  const currencies = Object.keys(CURRENCY_CONFIG).map(code => ({
    code,
    symbol: currencyFormatter.getSymbol(code),
    name: new Intl.DisplayNames(['en'], { type: 'currency' }).of(code),
  }));

  res.json(currencies);
});

/**
 * 获取汇率信息
 */
router.get('/exchange-rates', async (req, res) => {
  const baseCurrency = req.query.base || 'USD';
  const rates = await cache.get(`exchange_rates:${baseCurrency}`);

  if (!rates) {
    const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${baseCurrency}`);
    const data = await response.json();
    await cache.set(`exchange_rates:${baseCurrency}`, JSON.stringify(data.rates), 3600);
    res.json({ base: baseCurrency, rates: data.rates });
  } else {
    res.json({ base: baseCurrency, rates: JSON.parse(rates) });
  }
});

module.exports = router;
```

### 6. 数据库迁移

```sql
-- database/migrations/20260615170000_add_regional_pricing.sql

-- 区域定价表
CREATE TABLE regional_pricing (
  id SERIAL PRIMARY KEY,
  product_id VARCHAR(100) NOT NULL,
  country_code VARCHAR(10) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  price_amount BIGINT NOT NULL, -- 最小单位
  multiplier DECIMAL(10, 4) DEFAULT 1.0,
  tax_rate DECIMAL(5, 4) DEFAULT 0.0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_id, country_code)
);

-- 用户货币偏好表
CREATE TABLE user_currency_preferences (
  user_id VARCHAR(50) PRIMARY KEY REFERENCES users(id),
  preferred_currency VARCHAR(3) DEFAULT 'USD',
  display_locale VARCHAR(10) DEFAULT 'en-US',
  auto_convert BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 支付方式映射表
CREATE TABLE payment_method_mapping (
  id SERIAL PRIMARY KEY,
  country_code VARCHAR(10) NOT NULL,
  payment_method VARCHAR(50) NOT NULL,
  priority INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (country_code, payment_method)
);

-- 创建索引
CREATE INDEX idx_regional_pricing_product ON regional_pricing(product_id);
CREATE INDEX idx_regional_pricing_country ON regional_pricing(country_code);
CREATE INDEX idx_payment_method_country ON payment_method_mapping(country_code);
```

## 验收标准

- [ ] 支持 50+ 种货币的正确格式化显示
- [ ] 根据用户区域自动选择支付方式
- [ ] 区域化价格计算准确（汇率、系数、税费）
- [ ] 前端货币显示组件正常工作
- [ ] 支付渠道适配器接口统一
- [ ] 汇率缓存机制有效（1小时刷新）
- [ ] 数据库表结构正确创建
- [ ] API 端点响应正确
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 国际化文档完善

## 影响范围

- backend/services/payment-service/src/routes/regionalPricing.js（新增）
- backend/services/payment-service/src/adapters/PaymentAdapter.js（新增）
- backend/shared/currencyFormatter.js（新增）
- backend/shared/regionalPaymentConfig.js（新增）
- game-client/src/components/CurrencyDisplay.js（新增）
- game-client/src/utils/currencyFormatter.js（新增）
- database/migrations/20260615170000_add_regional_pricing.sql（新增）

## 参考

- [ISO 4217 Currency Codes](https://www.iso.org/iso-4217-currency-codes.html)
- [Unicode CLDR - Currency Formatting](https://cldr.unicode.org/)
- [Stripe Multi-Currency Guide](https://stripe.com/docs/currencies)
- [PayPal Localization](https://developer.paypal.com/docs/api/reference/locale-codes/)
