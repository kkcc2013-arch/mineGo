// backend/tests/unit/retryManager.test.js
// REQ-00402: 重试管理器单元测试

'use strict';

const {
  RetryManager,
  ExponentialBackoff,
  LinearBackoff,
  AdaptiveBackoff,
  ErrorClassifier,
  RetryBudget,
  RetryBudgetExhaustedError,
  MaxRetriesExceededError,
  TimeoutError,
  AbortError
} = require('../../shared/RetryManager');

describe('RetryManager', () => {
  let retryManager;

  beforeEach(() => {
    retryManager = new RetryManager({
      maxRetries: 3,
      initialDelay: 10,
      maxDelay: 1000,
      backoffFactor: 2,
      jitterType: 'full',
      timeout: 5000
    });
  });

  describe('execute', () => {
    test('should succeed on first attempt', async () => {
      const operation = jest.fn().mockResolvedValue('success');

      const result = await retryManager.execute(operation, { operationName: 'test' });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should retry on retryable error', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' })
        .mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' })
        .mockResolvedValue('success');

      const result = await retryManager.execute(operation, { operationName: 'test' });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    test('should not retry on non-retryable error', async () => {
      const operation = jest.fn()
        .mockRejectedValue({ status: 400, message: 'Bad Request' });

      await expect(retryManager.execute(operation, { operationName: 'test' }))
        .rejects.toThrow();

      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should throw MaxRetriesExceededError after max retries', async () => {
      const operation = jest.fn()
        .mockRejectedValue({ status: 503, message: 'Service Unavailable' });

      await expect(retryManager.execute(operation, { operationName: 'test' }))
        .rejects.toThrow(MaxRetriesExceededError);

      expect(operation).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    test('should respect AbortSignal', async () => {
      const controller = new AbortController();
      const operation = jest.fn().mockImplementation(() => {
        return new Promise((resolve) => setTimeout(resolve, 1000));
      });

      // 立即取消
      setTimeout(() => controller.abort(), 10);

      await expect(retryManager.execute(operation, {
        operationName: 'test',
        signal: controller.signal
      })).rejects.toThrow(AbortError);
    });
  });
});

describe('ExponentialBackoff', () => {
  let backoff;

  beforeEach(() => {
    backoff = new ExponentialBackoff({
      initialDelay: 100,
      maxDelay: 10000,
      backoffFactor: 2,
      jitterType: 'full',
      jitterRange: 0.5
    });
  });

  test('should calculate exponential delay', () => {
    const classification = { severity: 'medium' };

    const delay1 = backoff.calculateDelay(1, classification);
    const delay2 = backoff.calculateDelay(2, classification);
    const delay3 = backoff.calculateDelay(3, classification);

    // With full jitter, delay can be 0 to max
    expect(delay1).toBeLessThanOrEqual(100);
    expect(delay2).toBeLessThanOrEqual(200);
    expect(delay3).toBeLessThanOrEqual(400);
  });

  test('should respect maxDelay', () => {
    const classification = { severity: 'medium' };

    const delay = backoff.calculateDelay(10, classification);

    expect(delay).toBeLessThanOrEqual(10000);
  });

  test('should adjust delay based on severity', () => {
    const highSeverity = { severity: 'high' };
    const lowSeverity = { severity: 'low' };

    const highDelay = backoff.calculateDelay(1, highSeverity);
    const lowDelay = backoff.calculateDelay(1, lowSeverity);

    // High severity should have larger delay
    expect(highDelay).toBeGreaterThan(lowDelay);
  });
});

describe('LinearBackoff', () => {
  let backoff;

  beforeEach(() => {
    backoff = new LinearBackoff({
      initialDelay: 100,
      maxDelay: 5000,
      increment: 500,
      jitterRange: 0.5
    });
  });

  test('should calculate linear delay', () => {
    const classification = { severity: 'medium' };

    const delay1 = backoff.calculateDelay(1, classification);
    const delay2 = backoff.calculateDelay(2, classification);
    const delay3 = backoff.calculateDelay(3, classification);

    // Linear growth with jitter
    expect(delay1).toBeGreaterThanOrEqual(50);
    expect(delay2).toBeGreaterThanOrEqual(300);
    expect(delay3).toBeGreaterThanOrEqual(400);
  });
});

describe('AdaptiveBackoff', () => {
  let backoff;

  beforeEach(() => {
    backoff = new AdaptiveBackoff({
      initialDelay: 100,
      maxDelay: 10000,
      minDelay: 50
    });
  });

  test('should adjust delay based on success rate', () => {
    const classification = { severity: 'medium' };

    // Record enough successes to trigger adjustment
    for (let i = 0; i < 10; i++) {
      backoff.recordSuccess();
    }

    const delay = backoff.calculateDelay(1, classification);

    // After high success rate, delay should decrease
    expect(delay).toBeLessThan(100);
  });
});

describe('ErrorClassifier', () => {
  let classifier;

  beforeEach(() => {
    classifier = new ErrorClassifier();
  });

  describe('classifyHttpError', () => {
    test('should classify 429 as retryable', () => {
      const error = { status: 429 };
      const result = classifier.classify(error);

      expect(result.retryable).toBe(true);
      expect(result.type).toBe('rate_limit');
    });

    test('should classify 5xx as retryable', () => {
      const error500 = { status: 500 };
      const error502 = { status: 502 };
      const error503 = { status: 503 };

      expect(classifier.classify(error500).retryable).toBe(true);
      expect(classifier.classify(error502).retryable).toBe(true);
      expect(classifier.classify(error503).retryable).toBe(true);
    });

    test('should classify 4xx as non-retryable', () => {
      const error400 = { status: 400 };
      const error401 = { status: 401 };
      const error403 = { status: 403 };
      const error404 = { status: 404 };

      expect(classifier.classify(error400).retryable).toBe(false);
      expect(classifier.classify(error401).retryable).toBe(false);
      expect(classifier.classify(error403).retryable).toBe(false);
      expect(classifier.classify(error404).retryable).toBe(false);
    });

    test('should parse Retry-After header', () => {
      const error = {
        status: 429,
        headers: { 'retry-after': '5' }
      };

      const result = classifier.classify(error);

      expect(result.suggestedDelay).toBe(5000);
    });
  });

  describe('classifyNetworkError', () => {
    test('should classify ECONNRESET as retryable', () => {
      const error = { code: 'ECONNRESET' };
      const result = classifier.classify(error);

      expect(result.retryable).toBe(true);
      expect(result.type).toBe('network');
    });

    test('should classify ETIMEDOUT as retryable', () => {
      const error = { code: 'ETIMEDOUT' };
      const result = classifier.classify(error);

      expect(result.retryable).toBe(true);
    });
  });

  describe('classifyBusinessError', () => {
    test('should classify ValidationError as non-retryable', () => {
      const error = { name: 'ValidationError' };
      const result = classifier.classify(error);

      expect(result.retryable).toBe(false);
    });

    test('should classify unknown business errors as retryable', () => {
      const error = { name: 'TemporaryError' };
      const result = classifier.classify(error);

      expect(result.retryable).toBe(true);
    });
  });
});

describe('RetryBudget', () => {
  let budget;

  beforeEach(() => {
    budget = new RetryBudget({
      maxBudget: 10,
      refillRate: 5,
      refillInterval: 100
    });
  });

  afterEach(() => {
    budget.stopRefillTimer();
  });

  test('should allow requests within budget', () => {
    for (let i = 0; i < 10; i++) {
      expect(budget.allow()).toBe(true);
    }
  });

  test('should reject requests when budget exhausted', () => {
    for (let i = 0; i < 10; i++) {
      budget.allow();
    }

    expect(budget.allow()).toBe(false);
  });

  test('should refill budget over time', async () => {
    for (let i = 0; i < 10; i++) {
      budget.allow();
    }

    expect(budget.allow()).toBe(false);

    // Wait for refill
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(budget.getBudget()).toBeGreaterThan(0);
  });
});
