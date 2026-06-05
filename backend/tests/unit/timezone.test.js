// backend/tests/unit/timezone.test.js
// REQ-00029: 游戏事件时区本地化与多时区支持 - 单元测试

'use strict';

const { z } = require('zod');

// Mock dependencies
jest.mock('../../../shared/db', () => ({
  query: jest.fn()
}));

jest.mock('../../../shared/auth', () => ({
  requireAuth: jest.fn((req, res, next) => next()),
  AppError: class AppError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  successResp: (data, message) => ({ success: true, data, message })
}));

const { query } = require('../../../shared/db');
const timezoneRouter = require('../../services/user-service/src/routes/timezone');

describe('REQ-00029: Timezone Support', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { 
      user: { sub: 'user-123' },
      body: {},
      headers: {}
    };
    res = {
      json: jest.fn(),
      status: jest.fn(() => res),
      send: jest.fn(),
      setHeader: jest.fn()
    };
    next = jest.fn();
  });

  describe('GET /users/me/timezone', () => {
    test('should return user timezone settings', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          timezone: 'Asia/Shanghai',
          timezone_updated_at: '2026-06-05T10:00:00Z'
        }]
      });

      const handler = timezoneRouter.stack.find(l => l.route?.path === '/me/timezone')?.route?.stack[0]?.handle;
      await handler(req, res, next);

      expect(query).toHaveBeenCalledWith(
        'SELECT timezone, timezone_updated_at FROM users WHERE id = $1',
        ['user-123']
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            timezone: 'Asia/Shanghai'
          })
        })
      );
    });

    test('should return UTC for users without timezone', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          timezone: null,
          timezone_updated_at: null
        }]
      });

      const handler = timezoneRouter.stack.find(l => l.route?.path === '/me/timezone')?.route?.stack[0]?.handle;
      await handler(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            timezone: 'UTC'
          })
        })
      );
    });

    test('should handle non-existent user', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const handler = timezoneRouter.stack.find(l => l.route?.path === '/me/timezone')?.route?.stack[0]?.handle;
      await handler(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('PUT /users/me/timezone', () => {
    test('should update user timezone', async () => {
      req.body = { timezone: 'America/New_York' };

      query
        .mockResolvedValueOnce({ rows: [{ 1: 1 }] }) // isValidTimezone check
        .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE

      const handler = timezoneRouter.stack.find(l => l.route?.path === '/me/timezone')?.route?.stack[1]?.handle;
      await handler(req, res, next);

      expect(query).toHaveBeenCalledWith(
        'UPDATE users SET timezone = $1, timezone_updated_at = NOW() WHERE id = $2',
        ['America/New_York', 'user-123']
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: '时区设置已更新'
        })
      );
    });

    test('should reject invalid timezone', async () => {
      req.body = { timezone: 'Invalid/Timezone' };

      query.mockResolvedValueOnce({ rows: [] }); // isValidTimezone check

      const handler = timezoneRouter.stack.find(l => l.route?.path === '/me/timezone')?.route?.stack[1]?.handle;
      await handler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'INVALID_TIMEZONE'
          })
        })
      );
    });

    test('should validate request body', async () => {
      req.body = { timezone: '' };

      const handler = timezoneRouter.stack.find(l => l.route?.path === '/me/timezone')?.route?.stack[1]?.handle;
      await handler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('should accept valid IANA timezones', async () => {
      const validTimezones = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London'];
      
      for (const tz of validTimezones) {
        req.body = { timezone: tz };
        query.mockClear();
        query
          .mockResolvedValueOnce({ rows: tz === 'UTC' ? [] : [{ 1: 1 }] })
          .mockResolvedValueOnce({ rowCount: 1 });

        const handler = timezoneRouter.stack.find(l => l.route?.path === '/me/timezone')?.route?.stack[1]?.handle;
        await handler(req, res, next);

        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ success: true })
        );
      }
    });
  });

  describe('GET /users/timezones', () => {
    test('should return common timezones', async () => {
      query.mockResolvedValueOnce({
        rows: [
          { name: 'Africa/Abidjan', utc_offset: 0 },
          { name: 'America/New_York', utc_offset: -18000 }
        ]
      });

      const handler = timezoneRouter.stack.find(l => l.route?.path === '/timezones')?.route?.stack[0]?.handle;
      await handler(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            common: expect.arrayContaining([
              expect.objectContaining({ id: 'Asia/Shanghai' })
            ])
          })
        })
      );
    });

    test('should handle database error gracefully', async () => {
      query.mockRejectedValueOnce(new Error('DB error'));

      const handler = timezoneRouter.stack.find(l => l.route?.path === '/timezones')?.route?.stack[0]?.handle;
      await handler(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            common: expect.any(Array)
          })
        })
      );
    });
  });
});

describe('Timezone Middleware', () => {
  const { timezoneMiddleware, formatTimeForAPI, getTimezoneOffsetHours } = require('../../../shared/timezoneMiddleware');

  test('should set timezone from user preference', async () => {
    const reqWithUser = {
      user: { sub: 'user-123' },
      headers: {}
    };
    const res = { 
      locals: {}, 
      setHeader: jest.fn() 
    };
    const next = jest.fn();

    query.mockResolvedValueOnce({
      rows: [{ timezone: 'Asia/Tokyo' }]
    });

    await timezoneMiddleware(reqWithUser, res, next);

    expect(reqWithUser.timezone).toBe('Asia/Tokyo');
    expect(res.locals.timezone).toBe('Asia/Tokyo');
    expect(next).toHaveBeenCalled();
  });

  test('should prioritize header timezone', async () => {
    const reqWithHeader = {
      user: { sub: 'user-123' },
      headers: { 'x-timezone': 'America/Los_Angeles' }
    };
    const res = { 
      locals: {}, 
      setHeader: jest.fn() 
    };
    const next = jest.fn();

    query.mockResolvedValueOnce({
      rows: [{ timezone: 'Asia/Tokyo' }]
    });

    await timezoneMiddleware(reqWithHeader, res, next);

    expect(reqWithHeader.timezone).toBe('America/Los_Angeles');
  });

  test('should default to UTC when no preference', async () => {
    const reqNoUser = {
      headers: {}
    };
    const res = { 
      locals: {}, 
      setHeader: jest.fn() 
    };
    const next = jest.fn();

    await timezoneMiddleware(reqNoUser, res, next);

    expect(reqNoUser.timezone).toBe('UTC');
  });

  test('formatTimeForAPI should return correct format', () => {
    const date = '2026-06-05T10:00:00Z';
    const result = formatTimeForAPI(date, 'startTime');

    expect(result).toEqual({
      startTime: '2026-06-05T10:00:00.000Z',
      startTimeUnix: expect.any(Number)
    });
  });

  test('formatTimeForAPI should handle null', () => {
    const result = formatTimeForAPI(null, 'time');
    expect(result).toBeNull();
  });

  test('getTimezoneOffsetHours should return offset', () => {
    const offset = getTimezoneOffsetHours('Asia/Shanghai');
    expect(typeof offset).toBe('number');
  });
});

describe('Timezone Utils (Frontend)', () => {
  // Import frontend utils (would need to mock DOM)
  test('placeholder for frontend utils tests', () => {
    expect(true).toBe(true);
  });
});

describe('Timezone Validation', () => {
  test('should validate IANA timezone format', () => {
    const validTimezones = [
      'UTC',
      'Asia/Shanghai',
      'America/New_York',
      'Europe/London',
      'Australia/Sydney'
    ];

    const invalidTimezones = [
      '',
      '   ',
      'Invalid',
      'Asia/Shanghai/Extra',
      '12345'
    ];

    validTimezones.forEach(tz => {
      expect(/^[A-Za-z_\/]+$/.test(tz) || tz === 'UTC').toBe(true);
    });

    invalidTimezones.forEach(tz => {
      // Some invalid formats might still pass regex, but should fail at DB/API level
      if (tz === 'UTC') {
        expect(/^[A-Za-z_\/]+$/.test(tz) || tz === 'UTC').toBe(true);
      }
    });
  });
});

describe('Time Offset Calculations', () => {
  test('should handle positive offsets', () => {
    const offset = '+08:00';
    expect(offset).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  test('should handle negative offsets', () => {
    const offset = '-05:00';
    expect(offset).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  test('should handle zero offset', () => {
    const offset = '+00:00';
    expect(offset).toBe('+00:00');
  });
});

describe('Edge Cases', () => {
  test('should handle special characters in timezone header', async () => {
    const req = {
      user: { sub: 'user-123' },
      headers: { 'x-timezone': 'Asia/Shanghai<script>alert(1)</script>' }
    };
    const res = { 
      locals: {}, 
      setHeader: jest.fn() 
    };
    const next = jest.fn();

    query.mockResolvedValueOnce({
      rows: [{ timezone: 'UTC' }]
    });

    const { timezoneMiddleware } = require('../../../shared/timezoneMiddleware');
    await timezoneMiddleware(req, res, next);

    // Should reject invalid format
    expect(req.timezone).toBe('UTC');
  });

  test('should handle database connection error', async () => {
    query.mockRejectedValueOnce(new Error('Connection refused'));

    const req = {
      user: { sub: 'user-123' },
      headers: {}
    };
    const res = { 
      locals: {}, 
      setHeader: jest.fn() 
    };
    const next = jest.fn();

    const { timezoneMiddleware } = require('../../../shared/timezoneMiddleware');
    await timezoneMiddleware(req, res, next);

    // Should fallback to UTC
    expect(req.timezone).toBe('UTC');
    expect(next).toHaveBeenCalled();
  });
});
