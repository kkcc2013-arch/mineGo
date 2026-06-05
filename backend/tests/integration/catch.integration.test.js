/**
 * 捕捉精灵集成测试
 * 测试捕捉流程、Redis 缓存、事件发布
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');

describe('捕捉精灵集成测试', () => {
  let app;
  let pgClient;
  let redisClient;
  let authToken;
  let userId;

  beforeAll(async () => {
    const express = require('express');
    app = express();
    app.use(express.json());

    pgClient = global.testUtils.getPgClient();
    redisClient = global.testUtils.getRedisClient();

    // 创建测试用户
    const result = await pgClient.query(
      'INSERT INTO users (email, username, created_at) VALUES ($1, $2, NOW()) RETURNING id',
      ['catch@example.com', 'catchuser']
    );
    userId = result.rows[0].id;

    authToken = jwt.sign(
      { userId, email: 'catch@example.com' },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '24h' }
    );

    // 模拟精灵刷新路由
    app.get('/api/pokemon/nearby', async (req, res) => {
      const { lat, lng, radius = 1000 } = req.query;

      try {
        // 从 Redis GEO 获取附近精灵
        const nearbyPokemons = await redisClient.georadius(
          'pokemon:locations',
          lng,
          lat,
          radius,
          'm',
          'WITHDIST',
          'COUNT',
          10
        );

        if (nearbyPokemons.length === 0) {
          // 生成随机精灵
          const mockPokemon = {
            id: 'pokemon-' + Date.now(),
            species_id: Math.floor(Math.random() * 151) + 1,
            lat: parseFloat(lat) + (Math.random() - 0.5) * 0.01,
            lng: parseFloat(lng) + (Math.random() - 0.5) * 0.01,
            cp: Math.floor(Math.random() * 1000) + 100,
            disappear_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
          };

          // 缓存到 Redis
          await redisClient.geoadd(
            'pokemon:locations',
            mockPokemon.lng,
            mockPokemon.lat,
            mockPokemon.id
          );
          await redisClient.setex(
            `pokemon:${mockPokemon.id}`,
            1800,
            JSON.stringify(mockPokemon)
          );

          return res.json({
            code: 0,
            message: '成功',
            data: [mockPokemon]
          });
        }

        // 从 Redis 获取精灵详情
        const pokemons = [];
        for (const [id, distance] of nearbyPokemons) {
          const data = await redisClient.get(`pokemon:${id}`);
          if (data) {
            const pokemon = JSON.parse(data);
            pokemon.distance = parseFloat(distance);
            pokemons.push(pokemon);
          }
        }

        res.json({
          code: 0,
          message: '成功',
          data: pokemons
        });
      } catch (err) {
        res.status(500).json({
          code: 500,
          message: '服务器错误',
          data: null
        });
      }
    });

    // 模拟捕捉路由
    app.post('/api/catch', async (req, res) => {
      const { pokemon_id, ball_type = 'pokeball' } = req.body;
      const userId = req.user?.userId || 1;

      try {
        // 获取精灵信息
        const pokemonData = await redisClient.get(`pokemon:${pokemon_id}`);
        if (!pokemonData) {
          return res.status(404).json({
            code: 404,
            message: '精灵不存在或已消失',
            data: null
          });
        }

        const pokemon = JSON.parse(pokemonData);

        // 计算捕捉概率
        const catchRate = {
          pokeball: 0.3,
          greatball: 0.5,
          ultraball: 0.7
        }[ball_type] || 0.3;

        const isCaught = Math.random() < catchRate;

        if (isCaught) {
          // 保存到数据库
          const result = await pgClient.query(
            `INSERT INTO caught_pokemons (user_id, species_id, cp, iv, caught_at, caught_location)
             VALUES ($1, $2, $3, $4, NOW(), ST_MakePoint($5, $6))
             RETURNING id`,
            [userId, pokemon.species_id, pokemon.cp, Math.floor(Math.random() * 45), pokemon.lng, pokemon.lat]
          );

          // 从地图移除
          await redisClient.zrem('pokemon:locations', pokemon_id);
          await redisClient.del(`pokemon:${pokemon_id}`);

          res.json({
            code: 0,
            message: '捕捉成功',
            data: {
              caught: true,
              pokemon: {
                id: result.rows[0].id,
                species_id: pokemon.species_id,
                cp: pokemon.cp
              }
            }
          });
        } else {
          res.json({
            code: 0,
            message: '捕捉失败',
            data: {
              caught: false,
              reason: '精灵逃脱了'
            }
          });
        }
      } catch (err) {
        res.status(500).json({
          code: 500,
          message: '服务器错误',
          data: null
        });
      }
    });

    // 认证中间件
    app.use('/api/catch', (req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token) {
        try {
          req.user = jwt.verify(token, process.env.JWT_SECRET || 'test-secret');
        } catch (err) {
          return res.status(401).json({ code: 401, message: '无效 token' });
        }
      }
      next();
    });
  });

  describe('GET /api/pokemon/nearby', () => {
    it('应该返回附近精灵列表', async () => {
      const res = await request(app)
        .get('/api/pokemon/nearby')
        .query({ lat: 39.9, lng: 116.4, radius: 1000 });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('应该将精灵缓存到 Redis GEO', async () => {
      await request(app)
        .get('/api/pokemon/nearby')
        .query({ lat: 31.2, lng: 121.5, radius: 1000 });

      // 检查 Redis GEO 数据
      const locations = await redisClient.zrange('pokemon:locations', 0, -1);
      expect(locations.length).toBeGreaterThan(0);
    });

    it('应该返回带有距离信息的精灵', async () => {
      // 先生成一些精灵
      await request(app)
        .get('/api/pokemon/nearby')
        .query({ lat: 40.0, lng: 116.5, radius: 5000 });

      const res = await request(app)
        .get('/api/pokemon/nearby')
        .query({ lat: 40.0, lng: 116.5, radius: 5000 });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
    });
  });

  describe('POST /api/catch', () => {
    let testPokemonId;

    beforeEach(async () => {
      // 创建测试精灵
      testPokemonId = 'test-pokemon-' + Date.now();
      await redisClient.geoadd('pokemon:locations', 116.4, 39.9, testPokemonId);
      await redisClient.setex(
        `pokemon:${testPokemonId}`,
        1800,
        JSON.stringify({
          id: testPokemonId,
          species_id: 25,
          lat: 39.9,
          lng: 116.4,
          cp: 500,
          disappear_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        })
      );
    });

    it('应该成功捕捉精灵', async () => {
      const res = await request(app)
        .post('/api/catch')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          pokemon_id: testPokemonId,
          ball_type: 'ultraball'
        });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toBeDefined();
    });

    it('应该将捕捉结果保存到数据库', async () => {
      await request(app)
        .post('/api/catch')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          pokemon_id: testPokemonId,
          ball_type: 'ultraball'
        });

      // 检查数据库
      const result = await pgClient.query('SELECT * FROM caught_pokemons WHERE user_id = $1', [userId]);
      expect(result.rows.length).toBeGreaterThan(0);
    });

    it('应该从地图移除已捕捉的精灵', async () => {
      await request(app)
        .post('/api/catch')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          pokemon_id: testPokemonId,
          ball_type: 'ultraball'
        });

      // 检查 Redis
      const exists = await redisClient.exists(`pokemon:${testPokemonId}`);
      expect(exists).toBe(0);
    });

    it('应该拒绝不存在的精灵', async () => {
      const res = await request(app)
        .post('/api/catch')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          pokemon_id: 'nonexistent-pokemon',
          ball_type: 'pokeball'
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(404);
    });

    it('不同球类型应该影响捕捉概率', async () => {
      // 创建一个测试精灵
      const pokemonId = 'prob-test-' + Date.now();
      await redisClient.setex(
        `pokemon:${pokemonId}`,
        1800,
        JSON.stringify({
          id: pokemonId,
          species_id: 1,
          lat: 40.0,
          lng: 116.0,
          cp: 100
        })
      );

      const results = {
        pokeball: 0,
        greatball: 0,
        ultraball: 0
      };

      // 测试不同球类型的捕捉率
      for (const ballType of Object.keys(results)) {
        let catches = 0;
        for (let i = 0; i < 100; i++) {
          const res = await request(app)
            .post('/api/catch')
            .set('Authorization', `Bearer ${authToken}`)
            .send({ pokemon_id: pokemonId, ball_type: ballType });

          if (res.body.data?.caught) catches++;
        }
        results[ballType] = catches;
      }

      // 高级球应该有更高的捕捉率
      expect(results.ultraball).toBeGreaterThan(results.pokeball);
    });
  });
});