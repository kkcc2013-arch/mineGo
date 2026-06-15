/**
 * 精灵详情批量查询单元测试
 * REQ-00145: 精灵详情批量查询优化
 */

const { expect } = require('chai');
const sinon = require('sinon');
const request = require('supertest');
const express = require('express');

// Mock 依赖
const mockClient = {
    query: sinon.stub(),
    release: sinon.stub()
};

const mockRedis = {
    mget: sinon.stub().resolves([]),
    mset: sinon.stub().resolves(),
    pipeline: sinon.stub().returns({
        expire: sinon.stub().returnsThis(),
        exec: sinon.stub().resolves()
    })
};

describe('Pokemon Batch Query API', () => {
    let app;

    beforeEach(() => {
        // 重置 stubs
        sinon.reset();

        // 创建测试应用
        app = express();
        app.use(express.json());

        // Mock 认证中间件
        app.use((req, res, next) => {
            req.user = { id: 'test-user-123' };
            next();
        });

        // 加载路由
        const batchRouter = require('../../backend/services/pokemon-service/src/routes/batch');
        app.use('/pokemon/batch', batchRouter);
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('POST /pokemon/batch/details', () => {
        it('should return 400 for empty ids array', async () => {
            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({ ids: [] });

            expect(response.status).to.equal(400);
        });

        it('should return 400 for ids array exceeding limit', async () => {
            const ids = Array(101).fill(null).map((_, i) => `uuid-${i}`);
            
            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({ ids });

            expect(response.status).to.equal(400);
            expect(response.body.error).to.include('100');
        });

        it('should return 400 for invalid UUID format', async () => {
            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({ ids: ['invalid-uuid', 'another-invalid'] });

            expect(response.status).to.equal(400);
        });

        it('should successfully query multiple pokemon', async () => {
            // Mock 数据库查询
            mockClient.query.onFirstCall().resolves({
                rows: [
                    {
                        id: 'uuid-1',
                        user_id: 'test-user-123',
                        species_id: 25,
                        species_name: 'Pikachu',
                        name_zh: '皮卡丘',
                        name_en: 'Pikachu',
                        type1: 'electric',
                        type2: null,
                        nickname: '皮皮',
                        level: 30,
                        cp: 2500,
                        hp: 100,
                        max_hp: 120,
                        shiny: false,
                        gender: 'male',
                        iv_attack: 15,
                        iv_defense: 14,
                        iv_stamina: 15,
                        iv_hp: 15,
                        base_attack: 112,
                        base_defense: 96,
                        base_stamina: 111,
                        base_hp: 70
                    },
                    {
                        id: 'uuid-2',
                        user_id: 'test-user-123',
                        species_id: 6,
                        species_name: 'Charizard',
                        name_zh: '喷火龙',
                        name_en: 'Charizard',
                        type1: 'fire',
                        type2: 'flying',
                        nickname: null,
                        level: 35,
                        cp: 3000,
                        hp: 150,
                        max_hp: 160,
                        shiny: true,
                        gender: 'female',
                        iv_attack: 15,
                        iv_defense: 15,
                        iv_stamina: 14,
                        iv_hp: 15,
                        base_attack: 223,
                        base_defense: 176,
                        base_stamina: 156,
                        base_hp: 78
                    }
                ]
            });

            // Mock 技能查询
            mockClient.query.onSecondCall().resolves({ rows: [] });

            // Mock 进化查询
            mockClient.query.onThirdCall().resolves({ rows: [] });

            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({
                    ids: ['uuid-1', 'uuid-2'],
                    options: {
                        include_moves: true,
                        include_evolution: true,
                        include_stats: true
                    }
                });

            expect(response.status).to.equal(200);
            expect(response.body.code).to.equal(0);
            expect(response.body.data.results).to.have.lengthOf(2);
            expect(response.body.data.results[0].species_name_zh).to.equal('皮卡丘');
            expect(response.body.data.results[1].species_name_zh).to.equal('喷火龙');
        });

        it('should return not_found for non-existent IDs', async () => {
            // Mock 空查询结果
            mockClient.query.resolves({ rows: [] });

            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({
                    ids: ['non-existent-uuid-1', 'non-existent-uuid-2']
                });

            expect(response.status).to.equal(200);
            expect(response.body.data.not_found).to.have.lengthOf(2);
            expect(response.body.data.results).to.have.lengthOf(0);
        });

        it('should respect include_moves option', async () => {
            mockClient.query.onFirstCall().resolves({
                rows: [{ id: 'uuid-1', user_id: 'test-user-123', species_id: 25 }]
            });

            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({
                    ids: ['uuid-1'],
                    options: { include_moves: false }
                });

            expect(response.status).to.equal(200);
        });

        it('should return cache hit rate', async () => {
            // Mock 缓存命中
            mockRedis.mget.resolves([JSON.stringify({ id: 'uuid-1', species_name: 'Pikachu' }), null]);

            mockClient.query.resolves({
                rows: [{ id: 'uuid-2', user_id: 'test-user-123', species_id: 6 }]
            });

            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({ ids: ['uuid-1', 'uuid-2'] });

            expect(response.status).to.equal(200);
            expect(response.body.data.cache_hit_rate).to.exist;
        });

        it('should measure query time', async () => {
            mockClient.query.resolves({
                rows: [{ id: 'uuid-1', user_id: 'test-user-123', species_id: 25 }]
            });

            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({ ids: ['uuid-1'] });

            expect(response.status).to.equal(200);
            expect(response.body.data.query_time_ms).to.be.a('number');
        });
    });

    describe('Performance Tests', () => {
        it('should handle 50 IDs in under 200ms', async () => {
            const ids = Array(50).fill(null).map((_, i) => `uuid-${i}`);

            mockClient.query.resolves({
                rows: ids.map((id, i) => ({
                    id,
                    user_id: 'test-user-123',
                    species_id: i + 1,
                    species_name: `Pokemon-${i}`,
                    name_zh: `精灵-${i}`,
                    name_en: `Pokemon-${i}`,
                    type1: 'normal',
                    type2: null,
                    level: 30,
                    cp: 1000 + i * 10
                }))
            });

            const startTime = Date.now();

            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({ ids });

            const duration = Date.now() - startTime;

            expect(response.status).to.equal(200);
            expect(duration).to.be.lessThan(200);
        });
    });

    describe('Cache Integration', () => {
        it('should use Redis cache for repeated queries', async () => {
            // Mock 缓存命中
            mockRedis.mget.resolves([
                JSON.stringify({ id: 'uuid-1', species_name: 'Cached Pokemon' })
            ]);

            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({ ids: ['uuid-1'] });

            expect(response.status).to.equal(200);
            expect(response.body.data.results[0].species_name).to.equal('Cached Pokemon');
        });

        it('should write to cache after database query', async () => {
            mockRedis.mget.resolves([null]);

            mockClient.query.resolves({
                rows: [{
                    id: 'uuid-1',
                    user_id: 'test-user-123',
                    species_id: 25,
                    species_name: 'Pikachu'
                }]
            });

            const response = await request(app)
                .post('/pokemon/batch/details')
                .send({ ids: ['uuid-1'] });

            expect(response.status).to.equal(200);
            // 验证 mset 被调用
            expect(mockRedis.mset.called).to.be.true;
        });
    });
});
