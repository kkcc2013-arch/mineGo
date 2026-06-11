/**
 * REQ-00076: 精灵成就系统与里程碑奖励
 * 单元测试
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const achievementService = require('../services/pokemon-service/src/achievementService');

// Mock database
const mockDb = {
  select: sinon.stub().returnsThis(),
  where: sinon.stub().returnsThis(),
  first: sinon.stub(),
  insert: sinon.stub().returnsThis(),
  update: sinon.stub().returnsThis(),
  onConflict: sinon.stub().returnsThis(),
  ignore: sinon.stub(),
  merge: sinon.stub().returnsThis(),
  join: sinon.stub().returnsThis(),
  leftJoin: sinon.stub().returnsThis(),
  limit: sinon.stub().returnsThis(),
  offset: sinon.stub().returnsThis(),
  orderBy: sinon.stub().returnsThis(),
  raw: sinon.stub()
};

// Replace db with mock
sinon.stub(require('../shared/db'), 'db').value(mockDb);

describe('AchievementService', () => {
  beforeEach(() => {
    // Reset all stubs
    sinon.reset();
    
    // Reset service state
    achievementService.achievementDefinitions.clear();
    achievementService.initialized = false;
  });

  describe('loadDefinitions', () => {
    it('should load achievement definitions from database', async () => {
      const mockAchievements = [
        {
          achievement_id: 'first_catch',
          category: 'catch',
          name: '{"zh": "初次捕捉", "en": "First Catch"}',
          description: '{"zh": "捕捉你的第一只精灵"}',
          rarity: 'common',
          points: 10,
          is_hidden: false,
          trigger_conditions: '{"type": "catch_count", "target": 1}',
          rewards: '{"coins": 100}'
        },
        {
          achievement_id: 'catch_master_100',
          category: 'catch',
          name: '{"zh": "捕捉新手"}',
          description: '{"zh": "捕捉 100 只精灵"}',
          rarity: 'common',
          points: 50,
          is_hidden: false,
          trigger_conditions: '{"type": "catch_count", "target": 100}',
          rewards: '{"coins": 1000}'
        }
      ];

      mockDb.select.returnsThis();
      mockDb.where.returnsThis();
      const thenable = Promise.resolve(mockAchievements);
      Object.assign(thenable, mockDb);
      mockDb.select.returns(thenable);

      await achievementService.loadDefinitions();

      expect(achievementService.achievementDefinitions.size).to.equal(2);
      expect(achievementService.initialized).to.be.true;
    });

    it('should handle empty database', async () => {
      const thenable = Promise.resolve([]);
      Object.assign(thenable, mockDb);
      mockDb.select.returns(thenable);

      await achievementService.loadDefinitions();

      expect(achievementService.achievementDefinitions.size).to.equal(0);
    });
  });

  describe('processEvent', () => {
    beforeEach(async () => {
      // Load mock definitions
      achievementService.achievementDefinitions.set('first_catch', {
        achievement_id: 'first_catch',
        category: 'catch',
        name: { zh: '初次捕捉' },
        description: { zh: '捕捉你的第一只精灵' },
        rarity: 'common',
        points: 10,
        is_hidden: false,
        trigger_conditions: { type: 'catch_count', target: 1 },
        rewards: { coins: 100 }
      });

      achievementService.achievementDefinitions.set('catch_master_100', {
        achievement_id: 'catch_master_100',
        category: 'catch',
        name: { zh: '捕捉新手' },
        description: { zh: '捕捉 100 只精灵' },
        rarity: 'common',
        points: 50,
        is_hidden: false,
        trigger_conditions: { type: 'catch_count', target: 100 },
        rewards: { coins: 1000 }
      });

      achievementService.initialized = true;
    });

    it('should create new achievement progress for user', async () => {
      const userId = 1;
      const eventType = 'catch_count';
      const eventData = { count: 1 };

      // Mock no existing achievement
      mockDb.where.onFirstCall().returnsThis();
      const firstStub = sinon.stub();
      firstStub.onFirstCall().resolves(null);
      mockDb.where.returnsThis();
      mockDb.first = firstStub;

      // Mock insert
      mockDb.insert.onFirstCall().returnsThis();
      const insertThenable = Promise.resolve([{ id: 1 }]);
      Object.assign(insertThenable, mockDb);
      mockDb.insert.returns(insertThenable);

      // Mock update
      mockDb.update.onFirstCall().returnsThis();
      const updateThenable = Promise.resolve(1);
      Object.assign(updateThenable, mockDb);
      mockDb.update.returns(updateThenable);

      // Mock snapshot
      mockDb.where.onSecondCall().returnsThis();
      firstStub.onSecondCall().resolves(null);
      mockDb.insert.onSecondCall().returns(Promise.resolve([{ id: 1 }]));

      const results = await achievementService.processEvent(userId, eventType, eventData);

      expect(results).to.be.an('array');
      expect(results.length).to.be.greaterThan(0);
      expect(results[0]).to.have.property('achievement_id', 'first_catch');
      expect(results[0]).to.have.property('completed', true);
    });

    it('should update existing achievement progress', async () => {
      const userId = 1;
      const eventType = 'catch_count';
      const eventData = { count: 5 };

      // Mock existing achievement progress
      mockDb.where.onFirstCall().returnsThis();
      const firstStub = sinon.stub();
      firstStub.onFirstCall().resolves({
        user_id: userId,
        achievement_id: 'catch_master_100',
        progress: 50,
        target: 100,
        completed: false
      });
      mockDb.where.returnsThis();
      mockDb.first = firstStub;

      // Mock update
      mockDb.update.returnsThis();
      const updateThenable = Promise.resolve(1);
      Object.assign(updateThenable, mockDb);
      mockDb.update.returns(updateThenable);

      const results = await achievementService.processEvent(userId, eventType, eventData);

      expect(results).to.be.an('array');
    });
  });

  describe('calculateProgress', () => {
    it('should return count for catch_count events', () => {
      const progress = achievementService.calculateProgress('catch_count', { count: 1 });
      expect(progress).to.equal(1);
    });

    it('should return 1 for new species', () => {
      const progress = achievementService.calculateProgress('catch_species', { is_new_species: true });
      expect(progress).to.equal(1);
    });

    it('should return 0 for non-new species', () => {
      const progress = achievementService.calculateProgress('catch_species', { is_new_species: false });
      expect(progress).to.equal(0);
    });

    it('should return distance for distance_traveled events', () => {
      const progress = achievementService.calculateProgress('distance_traveled', { distance: 10 });
      expect(progress).to.equal(10);
    });

    it('should return 1 for battle_win events', () => {
      const progress = achievementService.calculateProgress('battle_win', { win: true });
      expect(progress).to.equal(1);
    });

    it('should return 1 for trade_count events', () => {
      const progress = achievementService.calculateProgress('trade_count', {});
      expect(progress).to.equal(1);
    });
  });

  describe('matchesFilters', () => {
    it('should return true when all filters match', () => {
      const eventData = { battle_type: 'pvp', is_shiny: true };
      const filters = { battle_type: 'pvp' };
      
      const matches = achievementService.matchesFilters(eventData, filters);
      expect(matches).to.be.true;
    });

    it('should return false when filter does not match', () => {
      const eventData = { battle_type: 'gym', is_shiny: true };
      const filters = { battle_type: 'pvp' };
      
      const matches = achievementService.matchesFilters(eventData, filters);
      expect(matches).to.be.false;
    });

    it('should return true for empty filters', () => {
      const eventData = { battle_type: 'pvp' };
      const filters = {};
      
      const matches = achievementService.matchesFilters(eventData, filters);
      expect(matches).to.be.true;
    });
  });

  describe('claimRewards', () => {
    beforeEach(() => {
      achievementService.achievementDefinitions.set('first_catch', {
        achievement_id: 'first_catch',
        category: 'catch',
        name: { zh: '初次捕捉' },
        rewards: { coins: 100, items: [{ item_id: 'pokeball', count: 10 }] }
      });
      achievementService.initialized = true;
    });

    it('should claim rewards successfully', async () => {
      const userId = 1;
      const achievementId = 'first_catch';

      // Mock user achievement
      mockDb.where.onFirstCall().returnsThis();
      const firstStub = sinon.stub();
      firstStub.onFirstCall().resolves({
        user_id: userId,
        achievement_id: achievementId,
        completed: true,
        rewards_claimed: false
      });
      mockDb.where.returnsThis();
      mockDb.first = firstStub;

      // Mock update
      mockDb.update.returnsThis();
      const updateThenable = Promise.resolve(1);
      Object.assign(updateThenable, mockDb);
      mockDb.update.returns(updateThenable);

      // Mock title insert
      mockDb.insert.onFirstCall().returnsThis();
      mockDb.onConflict.returnsThis();
      mockDb.ignore.returns(Promise.resolve());

      const rewards = await achievementService.claimRewards(userId, achievementId);

      expect(rewards).to.have.property('coins', 100);
      expect(rewards).to.have.property('items');
      expect(rewards.items).to.be.an('array');
      expect(rewards.items[0]).to.have.property('item_id', 'pokeball');
    });

    it('should throw error if achievement not completed', async () => {
      const userId = 1;
      const achievementId = 'first_catch';

      mockDb.where.onFirstCall().returnsThis();
      const firstStub = sinon.stub();
      firstStub.onFirstCall().resolves({
        user_id: userId,
        achievement_id: achievementId,
        completed: false,
        rewards_claimed: false
      });
      mockDb.where.returnsThis();
      mockDb.first = firstStub;

      try {
        await achievementService.claimRewards(userId, achievementId);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('not completed');
      }
    });

    it('should throw error if rewards already claimed', async () => {
      const userId = 1;
      const achievementId = 'first_catch';

      mockDb.where.onFirstCall().returnsThis();
      const firstStub = sinon.stub();
      firstStub.onFirstCall().resolves({
        user_id: userId,
        achievement_id: achievementId,
        completed: true,
        rewards_claimed: true
      });
      mockDb.where.returnsThis();
      mockDb.first = firstStub;

      try {
        await achievementService.claimRewards(userId, achievementId);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('already claimed');
      }
    });
  });

  describe('getUserAchievements', () => {
    it('should return user achievements with progress', async () => {
      const userId = 1;

      const mockResults = [
        {
          achievement_id: 'first_catch',
          category: 'catch',
          name: '{"zh": "初次捕捉"}',
          description: '{"zh": "捕捉你的第一只精灵"}',
          rarity: 'common',
          points: 10,
          is_hidden: false,
          progress: 1,
          target: 1,
          completed: true,
          rewards_claimed: true
        },
        {
          achievement_id: 'catch_master_100',
          category: 'catch',
          name: '{"zh": "捕捉新手"}',
          description: '{"zh": "捕捉 100 只精灵"}',
          rarity: 'common',
          points: 50,
          is_hidden: false,
          progress: 50,
          target: 100,
          completed: false,
          rewards_claimed: false
        }
      ];

      mockDb.leftJoin.returnsThis();
      mockDb.select.returnsThis();
      mockDb.where.returnsThis();
      mockDb.orderBy.returns(Promise.resolve(mockResults));

      const achievements = await achievementService.getUserAchievements(userId);

      expect(achievements).to.be.an('array');
      expect(achievements.length).to.equal(2);
      expect(achievements[0]).to.have.property('achievement_id');
      expect(achievements[0]).to.have.property('completed');
      expect(achievements[0].name).to.be.an('object');
    });

    it('should filter by category', async () => {
      const userId = 1;
      const category = 'catch';

      mockDb.leftJoin.returnsThis();
      mockDb.select.returnsThis();
      mockDb.where.returnsThis();
      mockDb.orderBy.returns(Promise.resolve([]));

      await achievementService.getUserAchievements(userId, { category });

      // Verify category filter was applied
      expect(mockDb.where.called).to.be.true;
    });

    it('should exclude hidden achievements', async () => {
      const userId = 1;

      mockDb.leftJoin.returnsThis();
      mockDb.select.returnsThis();
      mockDb.where.returnsThis();
      mockDb.orderBy.returns(Promise.resolve([]));

      await achievementService.getUserAchievements(userId, { includeHidden: false });

      // Verify hidden filter was applied
      expect(mockDb.where.called).to.be.true;
    });
  });

  describe('getUserProgress', () => {
    it('should return user progress snapshot', async () => {
      const userId = 1;

      mockDb.where.returnsThis();
      const firstStub = sinon.stub();
      firstStub.onFirstCall().resolves({
        user_id: userId,
        total_points: 150,
        achievements_completed: 3,
        category_progress: '{"catch": 100, "battle": 50}',
        last_updated: new Date()
      });
      mockDb.where.returnsThis();
      mockDb.first = firstStub;

      const progress = await achievementService.getUserProgress(userId);

      expect(progress).to.have.property('total_points', 150);
      expect(progress).to.have.property('achievements_completed', 3);
      expect(progress).to.have.property('category_progress');
    });

    it('should return empty progress if no snapshot exists', async () => {
      const userId = 1;

      mockDb.where.returnsThis();
      const firstStub = sinon.stub();
      firstStub.onFirstCall().resolves(null);
      mockDb.where.returnsThis();
      mockDb.first = firstStub;

      const progress = await achievementService.getUserProgress(userId);

      expect(progress).to.have.property('total_points', 0);
      expect(progress).to.have.property('achievements_completed', 0);
    });
  });

  describe('getLeaderboard', () => {
    it('should return leaderboard with rankings', async () => {
      const mockLeaderboard = [
        { user_id: 1, username: 'player1', total_points: 500, achievements_completed: 10 },
        { user_id: 2, username: 'player2', total_points: 400, achievements_completed: 8 }
      ];

      mockDb.join.returnsThis();
      mockDb.select.returnsThis();
      mockDb.orderBy.returnsThis();
      mockDb.limit.returnsThis();
      mockDb.offset.returns(Promise.resolve(mockLeaderboard));

      const leaderboard = await achievementService.getLeaderboard(100, 0);

      expect(leaderboard).to.be.an('array');
      expect(leaderboard.length).to.equal(2);
      expect(leaderboard[0]).to.have.property('rank', 1);
      expect(leaderboard[1]).to.have.property('rank', 2);
    });

    it('should respect limit and offset parameters', async () => {
      mockDb.join.returnsThis();
      mockDb.select.returnsThis();
      mockDb.orderBy.returnsThis();
      mockDb.limit.returnsThis();
      mockDb.offset.returns(Promise.resolve([]));

      await achievementService.getLeaderboard(50, 100);

      // Verify limit and offset were applied
      expect(mockDb.limit.called).to.be.true;
      expect(mockDb.offset.called).to.be.true;
    });
  });

  describe('setActiveTitle', () => {
    it('should set active title successfully', async () => {
      const userId = 1;
      const titleId = 'catcher_100';

      // Mock title ownership check
      mockDb.where.onFirstCall().returnsThis();
      const firstStub = sinon.stub();
      firstStub.onFirstCall().resolves({
        user_id: userId,
        title_id: titleId,
        is_active: false
      });
      mockDb.where.returnsThis();
      mockDb.first = firstStub;

      // Mock deactivate all
      mockDb.where.onSecondCall().returnsThis();
      mockDb.update.onFirstCall().returns(Promise.resolve(1));

      // Mock activate specific
      mockDb.where.onThirdCall().returnsThis();
      mockDb.update.onSecondCall().returns(Promise.resolve(1));

      await achievementService.setActiveTitle(userId, titleId);

      expect(mockDb.update.calledTwice).to.be.true;
    });

    it('should throw error if title not owned', async () => {
      const userId = 1;
      const titleId = 'catcher_100';

      mockDb.where.onFirstCall().returnsThis();
      const firstStub = sinon.stub();
      firstStub.onFirstCall().resolves(null);
      mockDb.where.returnsThis();
      mockDb.first = firstStub;

      try {
        await achievementService.setActiveTitle(userId, titleId);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('not owned');
      }
    });
  });
});

describe('Achievement Triggers', () => {
  const { ACHIEVEMENT_TRIGGERS } = require('../shared/achievementTriggers');

  describe('ACHIEVEMENT_TRIGGERS', () => {
    it('should have correct trigger mappings', () => {
      expect(ACHIEVEMENT_TRIGGERS).to.have.property('pokemon.caught');
      expect(ACHIEVEMENT_TRIGGERS).to.have.property('battle.won');
      expect(ACHIEVEMENT_TRIGGERS).to.have.property('trade.completed');
      expect(ACHIEVEMENT_TRIGGERS).to.have.property('pokemon.bred');
      expect(ACHIEVEMENT_TRIGGERS).to.have.property('location.distance_update');
    });

    it('should extract correct data from pokemon.caught event', () => {
      const trigger = ACHIEVEMENT_TRIGGERS['pokemon.caught'];
      const event = {
        pokemonId: 123,
        speciesId: 25,
        isNewSpecies: true,
        isShiny: false,
        rarity: 'common'
      };

      const data = trigger.extractData(event);

      expect(data).to.have.property('count', 1);
      expect(data).to.have.property('species_id', 25);
      expect(data).to.have.property('is_new_species', true);
      expect(data).to.have.property('is_shiny', false);
    });

    it('should extract correct data from battle.won event', () => {
      const trigger = ACHIEVEMENT_TRIGGERS['battle.won'];
      const event = {
        battleType: 'pvp',
        opponentLevel: 50
      };

      const data = trigger.extractData(event);

      expect(data).to.have.property('win', true);
      expect(data).to.have.property('battle_type', 'pvp');
    });

    it('should extract correct data from location.distance_update event', () => {
      const trigger = ACHIEVEMENT_TRIGGERS['location.distance_update'];
      const event = {
        distanceKm: 5.2
      };

      const data = trigger.extractData(event);

      expect(data).to.have.property('distance', 5.2);
    });
  });
});

// Run tests if executed directly
if (require.main === module) {
  console.log('Running achievement service tests...');
}
