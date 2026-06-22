/**
 * REQ-00055: 精灵收藏展示系统 - 单元测试
 */

'use strict';

const assert = require('assert');
const showcaseService = require('../src/showcaseService');

// Mock 数据库和 Redis
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockGetJSON = jest.fn();
const mockSetJSON = jest.fn();
const mockDel = jest.fn();

jest.mock('../../../shared/db', () => ({
  query: mockQuery,
  transaction: mockTransaction
}));

jest.mock('../../../shared/redis', () => ({
  getJSON: mockGetJSON,
  setJSON: mockSetJSON,
  del: mockDel
}));

jest.mock('../../../shared/logger', () => ({
  info: jest.fn(),
  error: jest.fn()
}));

jest.mock('../../../shared/metrics', () => ({
  incrementCounter: jest.fn(),
  getCounter: jest.fn()
}));

describe('showcaseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getFavorites', () => {
    it('should return user favorites ordered by display_order', async () => {
      const mockFavorites = [
        {
          pokemon_id: 'pokemon-1',
          species_id: 25,
          species: 'Pikachu',
          level: 50,
          cp: 1500,
          is_shiny: true,
          iv_percentage: 95,
          like_count: 10,
          comment_count: 5,
          display_order: 0,
          is_showcased: true
        }
      ];

      mockQuery.mockResolvedValue({ rows: mockFavorites });

      const result = await showcaseService.getFavorites('user-1');

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].pokemonId, 'pokemon-1');
      assert.strictEqual(result[0].species, 'Pikachu');
      assert.strictEqual(result[0].isShiny, true);
      assert.strictEqual(result[0].iv, 95);
      assert.strictEqual(mockQuery.mock.calls[0][1][0], 'user-1');
    });

    it('should return empty array if no favorites', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await showcaseService.getFavorites('user-1');

      assert.deepStrictEqual(result, []);
    });
  });

  describe('addFavorite', () => {
    it('should add favorite successfully', async () => {
      // Mock: 检查精灵是否属于用户
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pokemon-1' }] }) // pokemonCheck
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // countCheck
        .mockResolvedValueOnce({ rows: [] }) // existingCheck
        .mockResolvedValueOnce({ rows: [] }) // update order
        .mockResolvedValueOnce({ rows: [{ id: 'fav-1', pokemon_id: 'pokemon-1' }] }) // insert
        .mockResolvedValueOnce({ rows: [] }); // create stats

      const result = await showcaseService.addFavorite('user-1', 'pokemon-1', 0);

      assert.strictEqual(result.pokemon_id, 'pokemon-1');
    });

    it('should throw error if pokemon does not belong to user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await assert.rejects(
        async () => await showcaseService.addFavorite('user-1', 'pokemon-1'),
        { message: 'Pokemon not found or does not belong to user' }
      );
    });

    it('should throw error if max favorites reached', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pokemon-1' }] })
        .mockResolvedValueOnce({ rows: [{ count: '6' }] });

      await assert.rejects(
        async () => await showcaseService.addFavorite('user-1', 'pokemon-1'),
        { message: 'Maximum 6 favorites allowed' }
      );
    });

    it('should throw error if pokemon already favorited', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pokemon-1' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'existing' }] });

      await assert.rejects(
        async () => await showcaseService.addFavorite('user-1', 'pokemon-1'),
        { message: 'Pokemon already favorited' }
      );
    });
  });

  describe('removeFavorite', () => {
    it('should remove favorite successfully', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ display_order: 0 }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await showcaseService.removeFavorite('user-1', 'pokemon-1');

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, 'Removed from favorites');
    });

    it('should throw error if favorite not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await assert.rejects(
        async () => await showcaseService.removeFavorite('user-1', 'pokemon-1'),
        { message: 'Favorite not found' }
      );
    });
  });

  describe('likePokemon', () => {
    it('should like pokemon and give rewards', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pokemon-1', user_id: 'user-2', species: 'Pikachu' }] }) // pokemonCheck
        .mockResolvedValueOnce({ rows: [] }) // existingCheck
        .mockResolvedValueOnce({ rows: [{ like_count: 1 }] }); // statsResult

      mockGetJSON.mockResolvedValue({
        likesToday: 0,
        commentsToday: 0,
        lastResetDate: new Date().toISOString().split('T')[0]
      });

      mockTransaction.mockImplementation(async (callback) => {
        await callback({
          query: jest.fn().mockResolvedValue({ rows: [] })
        });
      });

      const result = await showcaseService.likePokemon('user-1', 'pokemon-1');

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.likeCount, 1);
      assert.ok(result.reward);
      assert.strictEqual(result.reward.coins, 5);
    });

    it('should throw error if liking own pokemon', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pokemon-1', user_id: 'user-1' }] });

      await assert.rejects(
        async () => await showcaseService.likePokemon('user-1', 'pokemon-1'),
        { message: 'Cannot like your own pokemon' }
      );
    });

    it('should throw error if already liked', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pokemon-1', user_id: 'user-2' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'like-1' }] });

      await assert.rejects(
        async () => await showcaseService.likePokemon('user-1', 'pokemon-1'),
        { message: 'Already liked this pokemon' }
      );
    });

    it('should throw error if daily limit reached', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'pokemon-1', user_id: 'user-2' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      mockGetJSON.mockResolvedValue({
        likesToday: 20,
        commentsToday: 0,
        lastResetDate: new Date().toISOString().split('T')[0]
      });

      await assert.rejects(
        async () => await showcaseService.likePokemon('user-1', 'pokemon-1'),
        { message: 'Daily like limit (20) reached' }
      );
    });
  });

  describe('addComment', () => {
    it('should add comment successfully', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pokemon-1', user_id: 'user-2' }] }) // pokemonCheck
        .mockResolvedValueOnce({ rows: [] }); // existingCheck

      mockGetJSON.mockResolvedValue({
        likesToday: 0,
        commentsToday: 0,
        lastResetDate: new Date().toISOString().split('T')[0]
      });

      mockTransaction.mockImplementation(async (callback) => {
        await callback({
          query: jest.fn().mockResolvedValue({ rows: [{ id: 'comment-1' }] })
        });
      });

      const result = await showcaseService.addComment('user-1', 'pokemon-1', 'Great pokemon!');

      assert.strictEqual(result.success, true);
      assert.ok(result.commentId);
    });

    it('should throw error if comment is empty', async () => {
      await assert.rejects(
        async () => await showcaseService.addComment('user-1', 'pokemon-1', ''),
        { message: 'Comment cannot be empty' }
      );
    });

    it('should throw error if comment is too long', async () => {
      const longComment = 'a'.repeat(201);

      await assert.rejects(
        async () => await showcaseService.addComment('user-1', 'pokemon-1', longComment),
        { message: 'Comment exceeds maximum length (200 characters)' }
      );
    });

    it('should throw error for inappropriate content', async () => {
      await assert.rejects(
        async () => await showcaseService.addComment('user-1', 'pokemon-1', 'This is spam'),
        { message: 'Comment contains inappropriate content' }
      );
    });
  });

  describe('getUserShowcase', () => {
    it('should return user showcase with favorites', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'user-1', nickname: 'Player1', level: 50, team: 'instinct', avatar_url: null }] }) // userResult
        .mockResolvedValueOnce({ rows: [{ pokemon_id: 'pokemon-1', species: 'Pikachu', level: 50, cp: 1500, is_shiny: true, iv_percentage: 95, like_count: 10, comment_count: 5 }] }) // favoritesResult
        .mockResolvedValueOnce({ rows: [] }) // likesResult
        .mockResolvedValueOnce({ rows: [] }) // update views
        .mockResolvedValueOnce({ rows: [{ total_likes: '10', total_views: '100' }] }); // statsResult

      const result = await showcaseService.getUserShowcase('user-1', 'user-2');

      assert.strictEqual(result.userId, 'user-1');
      assert.strictEqual(result.nickname, 'Player1');
      assert.strictEqual(result.showcase.length, 1);
      assert.strictEqual(result.stats.totalLikes, 10);
    });

    it('should throw error if user not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await assert.rejects(
        async () => await showcaseService.getUserShowcase('user-nonexistent'),
        { message: 'User not found' }
      );
    });
  });

  describe('getLeaderboard', () => {
    it('should return cached leaderboard', async () => {
      const cachedLeaderboard = [{ rank: 1, species: 'Mewtwo' }];
      mockGetJSON.mockResolvedValue(cachedLeaderboard);

      const result = await showcaseService.getLeaderboard();

      assert.deepStrictEqual(result, cachedLeaderboard);
    });

    it('should query database if cache miss', async () => {
      mockGetJSON.mockResolvedValue(null);
      mockQuery.mockResolvedValue({
        rows: [
          {
            pokemon_id: 'pokemon-1',
            species: 'Mewtwo',
            level: 50,
            cp: 3000,
            is_shiny: true,
            iv_percentage: 100,
            owner_id: 'user-1',
            owner_nickname: 'Player1',
            like_count: 100,
            comment_count: 20
          }
        ]
      });

      const result = await showcaseService.getLeaderboard();

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].rank, 1);
      assert.strictEqual(result[0].species, 'Mewtwo');
      assert.ok(mockSetJSON.called);
    });
  });

  describe('Constants', () => {
    it('should export correct constants', () => {
      assert.strictEqual(showcaseService.MAX_FAVORITES, 6);
      assert.strictEqual(showcaseService.MAX_LIKES_PER_DAY, 20);
      assert.strictEqual(showcaseService.MAX_COMMENTS_PER_DAY, 5);
      assert.strictEqual(showcaseService.MAX_COMMENT_LENGTH, 200);
      assert.ok(showcaseService.REWARDS);
    });
  });
});
