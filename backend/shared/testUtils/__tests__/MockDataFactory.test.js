// backend/shared/testUtils/__tests__/MockDataFactory.test.js
'use strict';

const { MockDataFactory, factory } = require('../MockDataFactory');

describe('MockDataFactory', () => {
  describe('createUser()', () => {
    it('should create a user with all required fields', () => {
      const user = factory.createUser();
      
      expect(user).toHaveProperty('userId');
      expect(user).toHaveProperty('email');
      expect(user).toHaveProperty('username');
      expect(user).toHaveProperty('level');
      expect(user).toHaveProperty('team');
      expect(user.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
    
    it('should apply overrides', () => {
      const user = factory.createUser({
        level: 50,
        team: 'mystic',
        username: 'CustomTrainer'
      });
      
      expect(user.level).toBe(50);
      expect(user.team).toBe('mystic');
      expect(user.username).toBe('CustomTrainer');
    });
    
    it('should generate unique user IDs', () => {
      const user1 = factory.createUser();
      const user2 = factory.createUser();
      
      expect(user1.userId).not.toBe(user2.userId);
    });
  });
  
  describe('createPokemon()', () => {
    it('should create a pokemon with required fields', () => {
      const pokemon = factory.createPokemon();
      
      expect(pokemon).toHaveProperty('pokemonId');
      expect(pokemon).toHaveProperty('speciesId');
      expect(pokemon).toHaveProperty('speciesName');
      expect(pokemon).toHaveProperty('cp');
      expect(pokemon).toHaveProperty('iv');
      expect(pokemon.iv).toHaveProperty('attack');
      expect(pokemon.iv).toHaveProperty('defense');
      expect(pokemon.iv).toHaveProperty('stamina');
    });
    
    it('should calculate IV percentage correctly', () => {
      const pokemon = factory.createPokemon({
        species: { id: 1, name: 'Test', type: 'normal', baseAttack: 100, baseDefense: 100, baseStamina: 100 }
      });
      
      const expectedPercentage = (pokemon.iv.attack + pokemon.iv.defense + pokemon.iv.stamina) / 45 * 100;
      expect(pokemon.ivPercentage).toBeCloseTo(expectedPercentage, 2);
    });
    
    it('should support custom species', () => {
      const customSpecies = {
        id: 999,
        name: 'CustomMon',
        type: 'fire',
        baseAttack: 200,
        baseDefense: 150,
        baseStamina: 120
      };
      
      const pokemon = factory.createPokemon({ species: customSpecies });
      expect(pokemon.speciesId).toBe(999);
      expect(pokemon.speciesName).toBe('CustomMon');
      expect(pokemon.type).toBe('fire');
    });
    
    it('should generate shiny pokemon rarely', () => {
      let shinyCount = 0;
      const samples = 1000;
      
      for (let i = 0; i < samples; i++) {
        const pokemon = factory.createPokemon();
        if (pokemon.isShiny) shinyCount++;
      }
      
      // Shiny rate is 1%, should be around 1% (allow 0-3%)
      expect(shinyCount / samples).toBeLessThan(0.03);
    });
  });
  
  describe('createGym()', () => {
    it('should create a gym with location', () => {
      const gym = factory.createGym();
      
      expect(gym).toHaveProperty('gymId');
      expect(gym).toHaveProperty('team');
      expect(gym).toHaveProperty('location');
      expect(gym.location).toHaveProperty('latitude');
      expect(gym.location).toHaveProperty('longitude');
      expect(gym.location.latitude).toBeGreaterThanOrEqual(-90);
      expect(gym.location.latitude).toBeLessThanOrEqual(90);
    });
  });
  
  describe('createQuest()', () => {
    it('should create a quest with targets and rewards', () => {
      const quest = factory.createQuest();
      
      expect(quest).toHaveProperty('questId');
      expect(quest).toHaveProperty('type');
      expect(quest).toHaveProperty('target');
      expect(quest).toHaveProperty('rewards');
      expect(quest.rewards).toHaveProperty('exp');
    });
  });
  
  describe('createPaymentOrder()', () => {
    it('should create a payment order', () => {
      const order = factory.createPaymentOrder();
      
      expect(order).toHaveProperty('orderId');
      expect(order).toHaveProperty('amount');
      expect(order).toHaveProperty('currency');
      expect(order).toHaveProperty('productId');
      expect(order).toHaveProperty('status');
    });
    
    it('should support custom amount', () => {
      const order = factory.createPaymentOrder({ amount: 99.99 });
      expect(order.amount).toBe(99.99);
    });
  });
  
  describe('createUsers()', () => {
    it('should create multiple users', () => {
      const users = factory.createUsers(10);
      
      expect(users).toHaveLength(10);
      users.forEach(user => {
        expect(user).toHaveProperty('userId');
      });
    });
  });
  
  describe('createPokemon()', () => {
    it('should create multiple pokemon', () => {
      const pokemons = factory.createPokemon(5);
      
      expect(pokemons).toHaveLength(5);
      pokemons.forEach(pokemon => {
        expect(pokemon).toHaveProperty('pokemonId');
      });
    });
  });
  
  describe('helper methods', () => {
    it('randomInt() should generate integers in range', () => {
      for (let i = 0; i < 100; i++) {
        const num = factory.randomInt(1, 10);
        expect(num).toBeGreaterThanOrEqual(1);
        expect(num).toBeLessThanOrEqual(10);
        expect(Number.isInteger(num)).toBe(true);
      }
    });
    
    it('randomFloat() should respect decimals', () => {
      const num = factory.randomFloat(0, 1, 2);
      const decimals = (num.toString().split('.')[1] || '').length;
      expect(decimals).toBeLessThanOrEqual(2);
    });
    
    it('randomString() should generate correct length', () => {
      const str = factory.randomString(10);
      expect(str.length).toBe(10);
    });
    
    it('randomChoice() should select from array', () => {
      const arr = ['a', 'b', 'c'];
      const choice = factory.randomChoice(arr);
      expect(arr).toContain(choice);
    });
    
    it('calculateCP() should return a number', () => {
      const species = { baseAttack: 100, baseDefense: 100, baseStamina: 100 };
      const cp = factory.calculateCP(species, 20, 10, 10, 10);
      expect(typeof cp).toBe('number');
      expect(cp).toBeGreaterThan(0);
    });
  });
  
  describe('load()', () => {
    it('should load from repository or generate', () => {
      const user = factory.load('user:newuser');
      expect(user).toHaveProperty('userId');
    });
  });
});
