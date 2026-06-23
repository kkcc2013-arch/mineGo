/**
 * REQ-00104: 精灵交换市场与竞价拍卖系统 - 单元测试
 */

// Mock DB and Redis before requiring MarketplaceService
const mockQuery = jest.fn();
const mockConnectQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(() => ({
  query: mockConnectQuery,
  release: mockRelease
}));

jest.mock('@pmg/shared/db', () => ({
  query: mockQuery,
  getPool: jest.fn(() => ({
    connect: mockConnect
  }))
}));

jest.mock('@pmg/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  }))
}));

const MarketplaceService = require('../../services/social-service/src/marketplace/MarketplaceService');

describe('MarketplaceService Unit Tests', () => {
  let service;

  beforeEach(() => {
    service = MarketplaceService;
    jest.clearAllMocks();
  });

  describe('配置初始化', () => {
    test('应该正确初始化市场配置', () => {
      expect(service.config).toBeDefined();
      expect(service.config.TAX_FIXED).toBe(0.10);
      expect(service.config.TAX_AUCTION).toBe(0.12);
      expect(service.config.MIN_FEE).toBe(100);
      expect(service.config.HIGH_VALUE_THRESHOLD).toBe(10000);
    });
  });

  describe('createListing', () => {
    test('如果用户不拥有精灵，上架应该失败', async () => {
      // 模拟所有权验证返回空行
      mockConnectQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
      mockConnectQuery.mockResolvedValueOnce({ rows: [] }); // Owner check

      await expect(
        service.createListing(1, 100, { listingType: 'fixed', fixedPrice: 500, duration: '24h' })
      ).rejects.toThrow('Pokemon not found or not owned by user');

      expect(mockConnectQuery).toHaveBeenCalledWith(
        expect.stringContaining('BEGIN')
      );
      expect(mockConnectQuery).toHaveBeenCalledWith(
        expect.stringContaining('ROLLBACK')
      );
      expect(mockRelease).toHaveBeenCalled();
    });

    test('如果已达到每日上架上限，上架应该失败', async () => {
      // 模拟所有权验证成功
      mockConnectQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
      mockConnectQuery.mockResolvedValueOnce({ rows: [{ id: 100, owner_id: 1, is_frozen: false }] }); // Owner check
      // 模拟今天已上架 50 次 (达到上限)
      mockConnectQuery.mockResolvedValueOnce({ rows: [{ count: '50' }] }); // Daily count check

      await expect(
        service.createListing(1, 100, { listingType: 'fixed', fixedPrice: 500, duration: '24h' })
      ).rejects.toThrow('Daily listing limit reached');

      expect(mockConnectQuery).toHaveBeenCalledWith(
        expect.stringContaining('ROLLBACK')
      );
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('placeBid', () => {
    test('如果列表不存在或不活跃，出价应该失败', async () => {
      mockConnectQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
      mockConnectQuery.mockResolvedValueOnce({ rows: [] }); // Listing lock query (empty)

      await expect(
        service.placeBid(2, 'mock-listing-id', 1000)
      ).rejects.toThrow('Listing not found or not active');

      expect(mockConnectQuery).toHaveBeenCalledWith(
        expect.stringContaining('ROLLBACK')
      );
      expect(mockRelease).toHaveBeenCalled();
    });

    test('非拍卖模式的列表，出价应该失败', async () => {
      mockConnectQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
      // 模拟列表为固定一口价模式
      mockConnectQuery.mockResolvedValueOnce({
        rows: [{
          id: 1,
          listing_id: 'mock-listing-id',
          listing_type: 'fixed',
          status: 'active',
          expires_at: new Date(Date.now() + 3600000).toISOString()
        }]
      });

      await expect(
        service.placeBid(2, 'mock-listing-id', 1000)
      ).rejects.toThrow('This listing is not an auction');

      expect(mockConnectQuery).toHaveBeenCalledWith(
        expect.stringContaining('ROLLBACK')
      );
    });

    test('卖家不能给自己上架的商品出价', async () => {
      mockConnectQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
      // 模拟卖家用户ID为 2，同时出价人也是 2
      mockConnectQuery.mockResolvedValueOnce({
        rows: [{
          id: 1,
          listing_id: 'mock-listing-id',
          listing_type: 'auction',
          seller_id: 2,
          status: 'active',
          expires_at: new Date(Date.now() + 3600000).toISOString()
        }]
      });

      await expect(
        service.placeBid(2, 'mock-listing-id', 1000)
      ).rejects.toThrow('Seller cannot bid on their own listing');

      expect(mockConnectQuery).toHaveBeenCalledWith(
        expect.stringContaining('ROLLBACK')
      );
    });

    test('出价如果低于最低加价幅度，应该失败', async () => {
      mockConnectQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
      // 当前最高价为 1000，按 5% 最小加价幅度，最低出价需要 1050
      mockConnectQuery.mockResolvedValueOnce({
        rows: [{
          id: 1,
          listing_id: 'mock-listing-id',
          listing_type: 'auction',
          seller_id: 3,
          current_highest_bid: 1000,
          status: 'active',
          expires_at: new Date(Date.now() + 3600000).toISOString()
        }]
      });

      await expect(
        service.placeBid(2, 'mock-listing-id', 1040)
      ).rejects.toThrow('Minimum bid is 1050');

      expect(mockConnectQuery).toHaveBeenCalledWith(
        expect.stringContaining('ROLLBACK')
      );
    });
  });
});
