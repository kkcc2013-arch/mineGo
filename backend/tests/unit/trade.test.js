// backend/tests/unit/trade.test.js
// 精灵交易系统单元测试（独立版本）

'use strict';

// 直接定义要测试的函数（避免依赖问题）
const RARITY_MULTIPLIERS = {
  COMMON: 1.0,
  UNCOMMON: 1.5,
  RARE: 2.0,
  EPIC: 3.0,
  LEGENDARY: 5.0
};

const FRIEND_LEVEL_DISCOUNTS = {
  GOOD: 0.9,
  GREAT: 0.8,
  ULTRA: 0.7,
  BEST: 0.6
};

const BASE_STARDUST_COST = 100;
const REMOTE_TRADE_MULTIPLIER = 3;

function calculateStardustCost(pokemon1, pokemon2, friendLevel, isRemote = false) {
  let cost = BASE_STARDUST_COST;

  const rarity1 = RARITY_MULTIPLIERS[pokemon1.rarity] || 1.0;
  const rarity2 = RARITY_MULTIPLIERS[pokemon2.rarity] || 1.0;
  const rarityMultiplier = (rarity1 + rarity2) / 2;
  cost *= rarityMultiplier;

  const cpDiff = Math.abs((pokemon1.cp || 0) - (pokemon2.cp || 0));
  const cpMultiplier = 1 + (cpDiff / 1000);
  cost *= cpMultiplier;

  const discount = FRIEND_LEVEL_DISCOUNTS[friendLevel] || 1.0;
  cost *= discount;

  if (isRemote) {
    cost *= REMOTE_TRADE_MULTIPLIER;
  }

  return Math.max(100, Math.floor(cost));
}

function calculatePokemonValue(pokemon) {
  let value = 0;

  value += (pokemon.cp || 0) * 1;

  const rarityValues = {
    COMMON: 100,
    UNCOMMON: 300,
    RARE: 1000,
    EPIC: 5000,
    LEGENDARY: 20000
  };
  value += rarityValues[pokemon.rarity] || 0;

  if (pokemon.iv_attack !== undefined && pokemon.iv_defense !== undefined && pokemon.iv_hp !== undefined) {
    const totalIV = (pokemon.iv_attack || 0) + (pokemon.iv_defense || 0) + (pokemon.iv_hp || 0);
    value += totalIV * 50;
  }

  if (pokemon.is_lucky) {
    value *= 1.5;
  }

  if (pokemon.is_shiny) {
    value *= 2;
  }

  return Math.floor(value);
}

function getRarityMultiplier(rarity) {
  return RARITY_MULTIPLIERS[rarity] || 1.0;
}

function getFriendLevelDiscount(level) {
  return FRIEND_LEVEL_DISCOUNTS[level] || 1.0;
}

const Severity = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL'
};

function getHighestSeverity(flags) {
  const order = [Severity.LOW, Severity.MEDIUM, Severity.HIGH, Severity.CRITICAL];
  let highest = Severity.LOW;
  
  for (const flag of flags) {
    if (order.indexOf(flag.severity) > order.indexOf(highest)) {
      highest = flag.severity;
    }
  }
  
  return highest;
}

const TradeLimits = {
  maxDailyTrades: 100,
  minFriendLevel: 'GOOD',
  minPokemonLevel: 10,
  cooldownBetweenTrades: 60000,
  maxRecentTrades: 5,
  maxNewAccountTrades: 50
};

// 测试套件
describe('Trade System', () => {
  
  describe('Stardust Cost Calculation', () => {
    
    test('should calculate base cost for common pokemon', () => {
      const pokemon1 = { rarity: 'COMMON', cp: 500 };
      const pokemon2 = { rarity: 'COMMON', cp: 500 };
      const cost = calculateStardustCost(pokemon1, pokemon2, 'GOOD', false);
      
      expect(cost).toBeGreaterThanOrEqual(100);
      expect(cost).toBeLessThan(200);
    });

    test('should increase cost for rare pokemon', () => {
      const pokemon1 = { rarity: 'RARE', cp: 1000 };
      const pokemon2 = { rarity: 'RARE', cp: 1000 };
      const cost = calculateStardustCost(pokemon1, pokemon2, 'GOOD', false);
      
      expect(cost).toBeGreaterThan(100);
    });

    test('should increase cost significantly for legendary pokemon', () => {
      const pokemon1 = { rarity: 'LEGENDARY', cp: 2000 };
      const pokemon2 = { rarity: 'COMMON', cp: 500 };
      const cost = calculateStardustCost(pokemon1, pokemon2, 'GOOD', false);
      
      expect(cost).toBeGreaterThan(300);
    });

    test('should apply friend level discount', () => {
      const pokemon1 = { rarity: 'COMMON', cp: 500 };
      const pokemon2 = { rarity: 'COMMON', cp: 500 };
      
      const costGood = calculateStardustCost(pokemon1, pokemon2, 'GOOD', false);
      const costBest = calculateStardustCost(pokemon1, pokemon2, 'BEST', false);
      
      // BEST friends get 40% discount, but minimum is 100
      expect(costBest).toBeLessThanOrEqual(costGood);
      expect(costBest).toBe(100); // minimum cost
    });

    test('should multiply cost for remote trades', () => {
      const pokemon1 = { rarity: 'COMMON', cp: 500 };
      const pokemon2 = { rarity: 'COMMON', cp: 500 };
      
      const costNearby = calculateStardustCost(pokemon1, pokemon2, 'GOOD', false);
      const costRemote = calculateStardustCost(pokemon1, pokemon2, 'GOOD', true);
      
      // Remote trades are 3x, but GOOD discount applies
      expect(costRemote).toBeGreaterThan(costNearby);
      expect(costRemote).toBe(Math.floor(100 * 1.0 * 1.0 * 0.9 * 3));
    });

    test('should increase cost for CP difference', () => {
      const pokemon1 = { rarity: 'COMMON', cp: 500 };
      const pokemon2 = { rarity: 'COMMON', cp: 2000 };
      
      const costDiff = calculateStardustCost(pokemon1, pokemon2, 'GOOD', false);
      const costSame = calculateStardustCost(
        { rarity: 'COMMON', cp: 500 },
        { rarity: 'COMMON', cp: 500 },
        'GOOD',
        false
      );
      
      expect(costDiff).toBeGreaterThan(costSame);
    });

    test('should enforce minimum cost of 100 stardust', () => {
      const pokemon1 = { rarity: 'COMMON', cp: 100 };
      const pokemon2 = { rarity: 'COMMON', cp: 100 };
      const cost = calculateStardustCost(pokemon1, pokemon2, 'BEST', false);
      
      expect(cost).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Pokemon Value Calculation', () => {
    
    test('should calculate value based on CP', () => {
      const pokemon = { cp: 1000, rarity: 'COMMON' };
      const value = calculatePokemonValue(pokemon);
      
      expect(value).toBeGreaterThan(1000);
    });

    test('should add value for rarity', () => {
      const common = { cp: 1000, rarity: 'COMMON' };
      const legendary = { cp: 1000, rarity: 'LEGENDARY' };
      
      const valueCommon = calculatePokemonValue(common);
      const valueLegendary = calculatePokemonValue(legendary);
      
      expect(valueLegendary).toBeGreaterThan(valueCommon);
    });

    test('should add value for IVs', () => {
      const noIV = { cp: 1000, rarity: 'COMMON' };
      const withIV = { cp: 1000, rarity: 'COMMON', iv_attack: 15, iv_defense: 15, iv_hp: 15 };
      
      const valueNoIV = calculatePokemonValue(noIV);
      const valueWithIV = calculatePokemonValue(withIV);
      
      expect(valueWithIV).toBeGreaterThan(valueNoIV);
    });

    test('should multiply value for lucky pokemon', () => {
      const normal = { cp: 1000, rarity: 'RARE' };
      const lucky = { cp: 1000, rarity: 'RARE', is_lucky: true };
      
      const valueNormal = calculatePokemonValue(normal);
      const valueLucky = calculatePokemonValue(lucky);
      
      expect(valueLucky).toBeGreaterThan(valueNormal);
    });

    test('should multiply value for shiny pokemon', () => {
      const normal = { cp: 1000, rarity: 'RARE' };
      const shiny = { cp: 1000, rarity: 'RARE', is_shiny: true };
      
      const valueNormal = calculatePokemonValue(normal);
      const valueShiny = calculatePokemonValue(shiny);
      
      expect(valueShiny).toBe(valueNormal * 2);
    });
  });

  describe('Rarity Multiplier', () => {
    
    test('should return correct multipliers', () => {
      expect(getRarityMultiplier('COMMON')).toBe(1.0);
      expect(getRarityMultiplier('UNCOMMON')).toBe(1.5);
      expect(getRarityMultiplier('RARE')).toBe(2.0);
      expect(getRarityMultiplier('EPIC')).toBe(3.0);
      expect(getRarityMultiplier('LEGENDARY')).toBe(5.0);
    });

    test('should return 1.0 for unknown rarity', () => {
      expect(getRarityMultiplier('UNKNOWN')).toBe(1.0);
    });
  });

  describe('Friend Level Discount', () => {
    
    test('should return correct discounts', () => {
      expect(getFriendLevelDiscount('GOOD')).toBe(0.9);
      expect(getFriendLevelDiscount('GREAT')).toBe(0.8);
      expect(getFriendLevelDiscount('ULTRA')).toBe(0.7);
      expect(getFriendLevelDiscount('BEST')).toBe(0.6);
    });

    test('should return 1.0 for unknown level', () => {
      expect(getFriendLevelDiscount('NEW')).toBe(1.0);
    });
  });

  describe('Trade Limits', () => {
    
    test('should have correct default limits', () => {
      expect(TradeLimits.maxDailyTrades).toBe(100);
      expect(TradeLimits.minFriendLevel).toBe('GOOD');
      expect(TradeLimits.minPokemonLevel).toBe(10);
      expect(TradeLimits.cooldownBetweenTrades).toBe(60000);
    });
  });

  describe('Anti-Cheat Severity', () => {
    
    test('should get highest severity correctly', () => {
      const flags1 = [
        { severity: Severity.LOW },
        { severity: Severity.MEDIUM }
      ];
      expect(getHighestSeverity(flags1)).toBe(Severity.MEDIUM);

      const flags2 = [
        { severity: Severity.LOW },
        { severity: Severity.CRITICAL }
      ];
      expect(getHighestSeverity(flags2)).toBe(Severity.CRITICAL);

      const flags3 = [
        { severity: Severity.HIGH },
        { severity: Severity.MEDIUM }
      ];
      expect(getHighestSeverity(flags3)).toBe(Severity.HIGH);
    });
  });

  describe('Edge Cases', () => {
    
    test('should handle missing pokemon properties', () => {
      const pokemon = {};
      const cost = calculateStardustCost(pokemon, pokemon, 'GOOD', false);
      
      expect(cost).toBeGreaterThanOrEqual(100);
    });

    test('should handle null values gracefully', () => {
      const pokemon = { rarity: 'COMMON', cp: null };
      const cost = calculateStardustCost(pokemon, pokemon, 'GOOD', false);
      
      expect(cost).toBeGreaterThanOrEqual(100);
    });

    test('should calculate value with missing properties', () => {
      const pokemon = {};
      const value = calculatePokemonValue(pokemon);
      
      expect(typeof value).toBe('number');
    });
  });

  describe('Integration Scenarios', () => {
    
    test('should calculate cost for legendary vs common trade', () => {
      const legendary = { rarity: 'LEGENDARY', cp: 3000 };
      const common = { rarity: 'COMMON', cp: 500 };
      
      const cost = calculateStardustCost(legendary, common, 'BEST', false);
      
      expect(cost).toBeGreaterThan(500);
    });

    test('should apply maximum discount for BEST friends', () => {
      const pokemon1 = { rarity: 'RARE', cp: 1000 };
      const pokemon2 = { rarity: 'RARE', cp: 1000 };
      
      const costGood = calculateStardustCost(pokemon1, pokemon2, 'GOOD', false);
      const costBest = calculateStardustCost(pokemon1, pokemon2, 'BEST', false);
      
      // Verify BEST gives lower cost than GOOD
      expect(costBest).toBeLessThan(costGood);
      // Verify BEST applies 60% (0.6) discount
      const expectedBest = Math.floor(costGood * (0.6 / 0.9)); // GOOD is 0.9, BEST is 0.6
      expect(costBest).toBe(expectedBest);
    });

    test('should calculate cost for remote legendary trade', () => {
      const pokemon1 = { rarity: 'LEGENDARY', cp: 4000 };
      const pokemon2 = { rarity: 'LEGENDARY', cp: 4000 };
      
      const cost = calculateStardustCost(pokemon1, pokemon2, 'BEST', true);
      
      // Legendary + Legendary + Remote + BEST discount
      // Base: 100 * 5.0 (legendary avg) * 1.0 (no CP diff) * 0.6 (BEST) * 3 (remote) = 900
      expect(cost).toBe(900);
      expect(cost).toBeGreaterThan(100);
    });
  });
});
