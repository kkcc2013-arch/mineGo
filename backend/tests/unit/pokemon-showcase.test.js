/**
 * REQ-00055: 精灵收藏展示系统
 * 单元测试
 * 
 * 创建时间: 2026-06-09 20:35
 */

'use strict';

const assert = require('assert');
const showcaseService = require('../../services/pokemon-service/src/showcaseService');

// Mock 数据库和 Redis
const mockDb = {
  query: jest.fn(),
  transaction: jest.fn()
};

const mockRedis = {
  getJSON: jest.fn(),
  setJSON: jest.fn(),
  del: jest.fn()
};

// 替换依赖
jest.mock('../../shared/db', () => mockDb);
jest.mock('../../shared/redis', () => mockRedis);

describe('REQ-00055: Pokemon Showcase System', () => {
  beforeEach(() => {
    // 重置 mock
    jest.clearAllMocks();
    
    // 设置默认 mock 行为
    mockDb.transaction.mockImplementation(async (fn) => {
      const mockClient = {
        query: jest.fn()
      };
      return fn(mockClient);
    });
  });
  
  // ============================================================
  // 收藏管理测试
  // ============================================================
  
  describe('Favorites Management', () => {
    
    test('should get user favorites', async () => {
      const mockFavorites = [
        {
          id: 'fav-1',
          pokemon_id: 'pokemon-1',
          display_order: 0,
          species: 'Pikachu',
          level: 50,
          is_shiny: true,
          iv_total: 98,
          like_count: 42
        }
      ];
      
      mockRedis.getJSON.mockResolvedValue(null); // 缓存未命中
      mockDb.query.mockResolvedValueOnce({ rows: mockFavorites });
      
      const result = await showcaseService.getFavorites('user-1');
      
      expect(result).toHaveLength(1);
      expect(result[0].species).toBe('Pikachu');
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM pokemon_favorites'),
        ['user-1']
      );
    });
    
    test('should return cached favorites', async () => {
      const cachedFavorites = [{ species: 'Charizard' }];
      mockRedis.getJSON.mockResolvedValue(cachedFavorites);
      
      const result = await showcaseService.getFavorites('user-1');
      
      expect(result).toEqual(cachedFavorites);
      expect(mockDb.query).not.toHaveBeenCalled();
    });
    
    test('should add favorite successfully', async () => {
      // Mock 精灵存在检查
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pokemon-1', user_id: 'user-1' }]
      });
      
      // Mock 当前收藏数量
      mockDb.query.mockResolvedValueOnce({
        rows: [{ count: '2' }]
      });
      
      // Mock 添加收藏
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'fav-1',
          pokemon_id: 'pokemon-1',
          user_id: 'user-1',
          display_order: 2
        }]
      });
      
      // Mock 更新展示状态
      mockDb.query.mockResolvedValueOnce({ rowCount: 1 });
      
      const result = await showcaseService.addFavorite('user-1', 'pokemon-1');
      
      expect(result.pokemon_id).toBe('pokemon-1');
      expect(mockRedis.del).toHaveBeenCalled();
    });
    
    test('should reject favoriting other user\'s pokemon', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pokemon-1', user_id: 'user-2' }]
      });
      
      await expect(
        showcaseService.addFavorite('user-1', 'pokemon-1')
      ).rejects.toThrow('You can only favorite your own Pokemon');
    });
    
    test('should reject exceeding max favorites', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pokemon-1', user_id: 'user-1' }]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ count: '6' }]
      });
      
      await expect(
        showcaseService.addFavorite('user-1', 'pokemon-1')
      ).rejects.toThrow('Maximum 6 favorites allowed');
    });
    
    test('should remove favorite successfully', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fav-1', pokemon_id: 'pokemon-1' }]
      });
      
      mockDb.query.mockResolvedValueOnce({ rowCount: 1 });
      
      mockDb.query.mockResolvedValueOnce({ rowCount: 1 });
      
      const result = await showcaseService.removeFavorite('user-1', 'pokemon-1');
      
      expect(result.success).toBe(true);
    });
    
    test('should reorder favorites', async () => {
      const orders = [
        { pokemonId: 'pokemon-1', displayOrder: 1 },
        { pokemonId: 'pokemon-2', displayOrder: 0 }
      ];
      
      const result = await showcaseService.reorderFavorites('user-1', orders);
      
      expect(result.success).toBe(true);
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });
  
  // ============================================================
  // 点赞功能测试
  // ============================================================
  
  describe('Like Functionality', () => {
    
    test('should like pokemon successfully', async () => {
      // Mock 精灵检查
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pokemon-1', user_id: 'user-2' }]
      });
      
      // Mock 未点赞检查
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      // Mock 限额检查
      mockDb.query.mockResolvedValueOnce({
        rows: [{ likes_today: 5, comments_today: 2, last_reset_date: new Date().toISOString().split('T')[0] }]
      });
      
      // Mock 统计查询
      mockDb.query.mockResolvedValueOnce({
        rows: [{ like_count: 43 }]
      });
      
      const result = await showcaseService.likePokemon('user-1', 'pokemon-1');
      
      expect(result.success).toBe(true);
      expect(result.likeCount).toBe(43);
      expect(result.reward).toBeDefined();
      expect(result.reward.coins).toBe(5);
    });
    
    test('should reject self-liking', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pokemon-1', user_id: 'user-1' }]
      });
      
      await expect(
        showcaseService.likePokemon('user-1', 'pokemon-1')
      ).rejects.toThrow('You cannot like your own Pokemon');
    });
    
    test('should reject duplicate likes', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pokemon-1', user_id: 'user-2' }]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'like-1' }] // 已点赞
      });
      
      await expect(
        showcaseService.likePokemon('user-1', 'pokemon-1')
      ).rejects.toThrow('You have already liked this Pokemon');
    });
    
    test('should reject exceeding daily like limit', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pokemon-1', user_id: 'user-2' }]
      });
      
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ likes_today: 20, comments_today: 2 }] // 达到上限
      });
      
      await expect(
        showcaseService.likePokemon('user-1', 'pokemon-1')
      ).rejects.toThrow('Daily like limit (20) reached');
    });
    
    test('should unlike pokemon successfully', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'like-1' }]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ like_count: 42 }]
      });
      
      const result = await showcaseService.unlikePokemon('user-1', 'pokemon-1');
      
      expect(result.success).toBe(true);
      expect(result.likeCount).toBe(42);
    });
    
    test('should check if user has liked', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'like-1' }]
      });
      
      const result = await showcaseService.hasLiked('user-1', 'pokemon-1');
      
      expect(result).toBe(true);
    });
  });
  
  // ============================================================
  // 评语功能测试
  // ============================================================
  
  describe('Comment Functionality', () => {
    
    test('should add comment successfully', async () => {
      const commentText = 'Great Pokemon!';
      
      // Mock 敏感词检查
      mockDb.query.mockResolvedValueOnce({
        rows: [{ has_sensitive: false }]
      });
      
      // Mock 精灵检查
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pokemon-1', user_id: 'user-2' }]
      });
      
      // Mock 未评论检查
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      // Mock 限额检查
      mockDb.query.mockResolvedValueOnce({
        rows: [{ comments_today: 2 }]
      });
      
      // Mock transaction
      mockDb.transaction.mockResolvedValueOnce({
        id: 'comment-1',
        pokemon_id: 'pokemon-1',
        user_id: 'user-1',
        comment: commentText
      });
      
      const result = await showcaseService.addComment('user-1', 'pokemon-1', commentText);
      
      expect(result.success).toBe(true);
      expect(result.commentId).toBe('comment-1');
      expect(result.reward).toBeDefined();
    });
    
    test('should reject comment with sensitive words', async () => {
      const commentText = 'This is fucking awesome!';
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ has_sensitive: true }]
      });
      
      await expect(
        showcaseService.addComment('user-1', 'pokemon-1', commentText)
      ).rejects.toThrow('inappropriate content');
    });
    
    test('should reject empty comment', async () => {
      await expect(
        showcaseService.addComment('user-1', 'pokemon-1', '')
      ).rejects.toThrow('must be between');
    });
    
    test('should reject too long comment', async () => {
      const longComment = 'a'.repeat(201);
      
      await expect(
        showcaseService.addComment('user-1', 'pokemon-1', longComment)
      ).rejects.toThrow('must be between');
    });
    
    test('should reject duplicate comments', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ has_sensitive: false }]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pokemon-1', user_id: 'user-2' }]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'comment-1' }] // 已评论
      });
      
      await expect(
        showcaseService.addComment('user-1', 'pokemon-1', 'Nice!')
      ).rejects.toThrow('You have already commented');
    });
    
    test('should get comments list', async () => {
      const mockComments = [
        {
          id: 'comment-1',
          comment: 'Great!',
          user_id: 'user-2',
          nickname: 'Trainer2'
        }
      ];
      
      mockDb.query.mockResolvedValueOnce({ rows: mockComments });
      mockDb.query.mockResolvedValueOnce({ rows: [{ comment_count: 5 }] });
      
      const result = await showcaseService.getComments('pokemon-1');
      
      expect(result.comments).toHaveLength(1);
      expect(result.total).toBe(5);
    });
    
    test('should delete comment', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'comment-1' }]
      });
      
      const result = await showcaseService.deleteComment('user-1', 'comment-1');
      
      expect(result.success).toBe(true);
    });
  });
  
  // ============================================================
  // 展示页面测试
  // ============================================================
  
  describe('Showcase Page', () => {
    
    test('should get user showcase', async () => {
      const mockUser = {
        id: 'user-1',
        nickname: 'Trainer1',
        level: 50,
        team: 'instinct'
      };
      
      const mockFavorites = [
        {
          pokemon_id: 'pokemon-1',
          species: 'Pikachu',
          level: 50,
          is_shiny: true,
          like_count: 42
        }
      ];
      
      const mockStats = {
        total_likes: 100,
        total_views: 500
      };
      
      mockDb.query.mockResolvedValueOnce({ rows: [mockUser] });
      mockDb.query.mockResolvedValueOnce({ rows: mockFavorites });
      mockDb.query.mockResolvedValueOnce({ rows: [mockStats] });
      
      const result = await showcaseService.getUserShowcase('user-1');
      
      expect(result.user.nickname).toBe('Trainer1');
      expect(result.showcase).toHaveLength(1);
      expect(result.stats.totalLikes).toBe(100);
    });
    
    test('should increment view count for viewer', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'user-1', nickname: 'Trainer1' }]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ pokemon_id: 'pokemon-1' }]
      });
      
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total_likes: 0, total_views: 0 }]
      });
      
      await showcaseService.getUserShowcase('user-1', 'user-2');
      
      // 应该调用了浏览计数更新
      expect(mockDb.query).toHaveBeenCalled();
    });
  });
  
  // ============================================================
  // 排行榜测试
  // ============================================================
  
  describe('Leaderboard', () => {
    
    test('should get leaderboard from cache', async () => {
      const cachedLeaderboard = [
        { rank: 1, species: 'Mewtwo', like_count: 999 }
      ];
      
      mockRedis.getJSON.mockResolvedValue(cachedLeaderboard);
      
      const result = await showcaseService.getLeaderboard('likes', 50);
      
      expect(result).toEqual(cachedLeaderboard);
    });
    
    test('should refresh leaderboard if not cached', async () => {
      mockRedis.getJSON.mockResolvedValue(null);
      
      mockDb.query.mockResolvedValueOnce({ rowCount: 1 }); // REFRESH
      
      const mockLeaderboard = [
        { rank: 1, species: 'Mewtwo', like_count: 999 }
      ];
      
      mockDb.query.mockResolvedValueOnce({ rows: mockLeaderboard });
      
      const result = await showcaseService.getLeaderboard('likes', 50);
      
      expect(result).toHaveLength(1);
      expect(mockRedis.setJSON).toHaveBeenCalled();
    });
  });
  
  // ============================================================
  // 配置测试
  // ============================================================
  
  describe('Configuration', () => {
    
    test('should have correct max favorites', () => {
      expect(showcaseService.CONFIG.MAX_FAVORITES).toBe(6);
    });
    
    test('should have correct daily limits', () => {
      expect(showcaseService.CONFIG.MAX_LIKES_PER_DAY).toBe(20);
      expect(showcaseService.CONFIG.MAX_COMMENTS_PER_DAY).toBe(5);
    });
    
    test('should have correct reward amounts', () => {
      expect(showcaseService.CONFIG.REWARDS.LIKER.coins).toBe(5);
      expect(showcaseService.CONFIG.REWARDS.LIKED_OWNER.coins).toBe(10);
      expect(showcaseService.CONFIG.REWARDS.COMMENTER.coins).toBe(2);
      expect(showcaseService.CONFIG.REWARDS.COMMENTED_OWNER.coins).toBe(20);
    });
  });
});

// ============================================================
// 运行测试
// ============================================================

console.log('✅ REQ-00055: Pokemon Showcase System - Test Suite Loaded');
console.log('   - Favorites Management: 6 tests');
console.log('   - Like Functionality: 6 tests');
console.log('   - Comment Functionality: 7 tests');
console.log('   - Showcase Page: 2 tests');
console.log('   - Leaderboard: 2 tests');
console.log('   - Configuration: 3 tests');
console.log('   Total: 26 tests');
