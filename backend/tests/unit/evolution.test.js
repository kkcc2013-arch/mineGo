/**
 * REQ-00065: 精灵进化与成长系统
 * 单元测试
 */

const { EvolutionService } = require('../evolutionService');

// Mock 依赖
jest.mock('pg', () => ({
    Pool: jest.fn(() => ({
        query: jest.fn(),
        connect: jest.fn(() => ({
            query: jest.fn(),
            release: jest.fn()
        }))
    }))
}));

jest.mock('ioredis', () => {
    return jest.fn(() => ({
        del: jest.fn(),
        get: jest.fn(),
        set: jest.fn()
    }));
});

jest.mock('prom-client', () => ({
    Counter: jest.fn(() => ({
        inc: jest.fn()
    })),
    Histogram: jest.fn(() => ({
        observe: jest.fn()
    }))
}));

jest.mock('../../../shared/logger', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn()
    }
}));

describe('EvolutionService', () => {
    let evolutionService;
    
    beforeEach(() => {
        evolutionService = new EvolutionService();
        jest.clearAllMocks();
    });
    
    describe('buildExperienceTable', () => {
        it('应该构建6种成长曲线', () => {
            const table = evolutionService.experienceTable;
            
            expect(table).toHaveProperty('fast');
            expect(table).toHaveProperty('medium_fast');
            expect(table).toHaveProperty('medium_slow');
            expect(table).toHaveProperty('slow');
            expect(table).toHaveProperty('fluctuating');
            expect(table).toHaveProperty('erratic');
        });
        
        it('medium_fast 曲线应该是 n³', () => {
            const table = evolutionService.experienceTable.medium_fast;
            
            // 等级 1: 1³ = 1
            expect(table[0]).toBe(1);
            // 等级 10: 10³ = 1000
            expect(table[9]).toBe(1000);
            // 等级 50: 50³ = 125000
            expect(table[49]).toBe(125000);
        });
        
        it('slow 曲线应该是 5/4 * n³', () => {
            const table = evolutionService.experienceTable.slow;
            
            // 等级 1: 5/4 * 1³ = 1
            expect(table[0]).toBe(1);
            // 等级 10: 5/4 * 1000 = 1250
            expect(table[9]).toBe(1250);
        });
    });
    
    describe('buildCPMultiplierTable', () => {
        it('应该构建100级的CP倍率表', () => {
            const table = evolutionService.cpMultiplierTable;
            
            expect(Object.keys(table).length).toBe(100);
            expect(table[1]).toBeDefined();
            expect(table[100]).toBeDefined();
        });
        
        it('高等级的CP倍率应该比低等级高', () => {
            const table = evolutionService.cpMultiplierTable;
            
            expect(table[50]).toBeGreaterThan(table[1]);
            expect(table[100]).toBeGreaterThan(table[50]);
        });
    });
    
    describe('calculateLevelFromExp', () => {
        it('应该根据经验值返回正确的等级', () => {
            // medium_fast: 等级 10 需要 1000 经验
            const level = evolutionService.calculateLevelFromExp(1000, 'medium_fast');
            expect(level).toBe(10);
        });
        
        it('经验值不足时应该返回等级1', () => {
            const level = evolutionService.calculateLevelFromExp(0, 'medium_fast');
            expect(level).toBe(1);
        });
        
        it('经验值超过100级时应该返回100', () => {
            const level = evolutionService.calculateLevelFromExp(1000000, 'medium_fast');
            expect(level).toBe(100);
        });
    });
    
    describe('getExpForLevel', () => {
        it('应该返回指定等级所需的经验值', () => {
            const exp = evolutionService.getExpForLevel(10, 'medium_fast');
            expect(exp).toBe(1000);
        });
        
        it('应该处理不存在的等级', () => {
            const exp = evolutionService.getExpForLevel(0, 'medium_fast');
            expect(exp).toBe(0);
        });
    });
    
    describe('calculatePostEvolutionStats', () => {
        it('应该正确计算进化后的属性', () => {
            const pokemon = {
                level: 20,
                iv_hp: 15,
                iv_attack: 15,
                iv_defense: 15,
                iv_sp_attack: 15,
                iv_sp_defense: 15,
                iv_speed: 15
            };
            
            const targetSpecies = {
                base_hp: 100,
                base_attack: 100,
                base_defense: 100,
                base_sp_attack: 100,
                base_sp_defense: 100,
                base_speed: 100
            };
            
            const stats = evolutionService.calculatePostEvolutionStats(pokemon, targetSpecies);
            
            expect(stats).toHaveProperty('totalHp');
            expect(stats).toHaveProperty('attack');
            expect(stats).toHaveProperty('defense');
            expect(stats).toHaveProperty('spAttack');
            expect(stats).toHaveProperty('spDefense');
            expect(stats).toHaveProperty('speed');
            expect(stats).toHaveProperty('cp');
            
            // 所有属性应该是正数
            expect(stats.totalHp).toBeGreaterThan(0);
            expect(stats.attack).toBeGreaterThan(0);
            expect(stats.cp).toBeGreaterThan(0);
        });
        
        it('CP 值应该基于属性计算', () => {
            const pokemon = {
                level: 30,
                iv_hp: 15,
                iv_attack: 15,
                iv_defense: 15,
                iv_sp_attack: 15,
                iv_sp_defense: 15,
                iv_speed: 15
            };
            
            const strongSpecies = {
                base_hp: 150,
                base_attack: 150,
                base_defense: 150,
                base_sp_attack: 150,
                base_sp_defense: 150,
                base_speed: 150
            };
            
            const weakSpecies = {
                base_hp: 50,
                base_attack: 50,
                base_defense: 50,
                base_sp_attack: 50,
                base_sp_defense: 50,
                base_speed: 50
            };
            
            const strongStats = evolutionService.calculatePostEvolutionStats(pokemon, strongSpecies);
            const weakStats = evolutionService.calculatePostEvolutionStats(pokemon, weakSpecies);
            
            // 强物种的 CP 应该更高
            expect(strongStats.cp).toBeGreaterThan(weakStats.cp);
        });
    });
    
    describe('recommendEvolution', () => {
        it('应该返回唯一的进化路径', () => {
            const evolutions = [{
                to_species_id: 3,
                preview: { statsChange: { cp: 100 } }
            }];
            
            const result = evolutionService.recommendEvolution(evolutions, {});
            
            expect(result.reason).toBe('ONLY_ONE_PATH');
            expect(result.recommended.to_species_id).toBe(3);
        });
        
        it('应该根据 CP 增益推荐最优进化', () => {
            const evolutions = [
                { to_species_id: 134, preview: { statsChange: { cp: 500 } } },
                { to_species_id: 135, preview: { statsChange: { cp: 800 } } },
                { to_species_id: 136, preview: { statsChange: { cp: 600 } } }
            ];
            
            const result = evolutionService.recommendEvolution(evolutions, {});
            
            expect(result.recommended.to_species_id).toBe(135);
            expect(result.reason).toBe('OPTIMAL_CP_AND_RARITY');
        });
        
        it('应该考虑稀有度作为次要因素', () => {
            const evolutions = [
                { to_species_id: 134, preview: { statsChange: { cp: 500 } }, to_rarity: 'common' },
                { to_species_id: 135, preview: { statsChange: { cp: 520 } }, to_rarity: 'legendary' }
            ];
            
            const result = evolutionService.recommendEvolution(evolutions, {});
            
            // CP 相近，稀有度高的优先
            expect(result.recommended.to_species_id).toBe(135);
        });
    });
    
    describe('checkEvolutionConditions', () => {
        it('等级进化应该检查等级需求', async () => {
            const pokemon = { level: 15 };
            const evolutionPath = {
                evolution_type: 'level',
                min_level: 16
            };
            
            const result = await evolutionService.checkEvolutionConditions(pokemon, evolutionPath, 1);
            
            expect(result.canEvolve).toBe(false);
            expect(result.requirements.type).toBe('level');
            expect(result.requirements.met).toBe(false);
        });
        
        it('满足等级时应该可以进化', async () => {
            const pokemon = { level: 20 };
            const evolutionPath = {
                evolution_type: 'level',
                min_level: 16
            };
            
            const result = await evolutionService.checkEvolutionConditions(pokemon, evolutionPath, 1);
            
            expect(result.canEvolve).toBe(true);
            expect(result.requirements.met).toBe(true);
        });
        
        it('交换进化应该标记为需要交易', async () => {
            const pokemon = { level: 30 };
            const evolutionPath = {
                evolution_type: 'trade'
            };
            
            const result = await evolutionService.checkEvolutionConditions(pokemon, evolutionPath, 1);
            
            expect(result.canEvolve).toBe(false);
            expect(result.requirements.type).toBe('trade');
        });
    });
    
    describe('checkComplexConditions', () => {
        it('应该检查亲密度条件', async () => {
            const pokemon = { friendship: 200 };
            const conditions = { friendship: 220 };
            
            const result = await evolutionService.checkComplexConditions(pokemon, conditions, 1);
            
            expect(result.met).toBe(false);
            expect(result.missingRequirements).toContainEqual(
                expect.objectContaining({ type: 'friendship' })
            );
        });
        
        it('应该检查时间条件（白天）', async () => {
            const pokemon = {};
            
            // 模拟白天
            const originalHour = Date.prototype.getHours;
            Date.prototype.getHours = () => 12;
            
            const dayConditions = { time: 'day' };
            const nightConditions = { time: 'night' };
            
            const dayResult = await evolutionService.checkComplexConditions(pokemon, dayConditions, 1);
            const nightResult = await evolutionService.checkComplexConditions(pokemon, nightConditions, 1);
            
            expect(dayResult.met).toBe(true);
            expect(nightResult.met).toBe(false);
            
            Date.prototype.getHours = originalHour;
        });
        
        it('应该检查攻击力大于防御力条件', async () => {
            const strongAttack = { attack: 100, defense: 80 };
            const weakAttack = { attack: 80, defense: 100 };
            const conditions = { attack_stat_gt_defense: true };
            
            const strongResult = await evolutionService.checkComplexConditions(strongAttack, conditions, 1);
            const weakResult = await evolutionService.checkComplexConditions(weakAttack, conditions, 1);
            
            expect(strongResult.met).toBe(true);
            expect(weakResult.met).toBe(false);
        });
    });
});

// 运行测试的说明
console.log(`
===========================================
REQ-00065: 精灵进化与成长系统 - 单元测试
===========================================

运行测试: npm test -- evolution.test.js

测试覆盖:
- 经验值表构建（6种成长曲线）
- CP 倍率表构建
- 等级计算
- 进化后属性计算
- 进化推荐算法
- 进化条件检查
- 复杂进化条件检查

测试数量: 20+
`);
