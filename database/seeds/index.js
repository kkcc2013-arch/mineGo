#!/usr/bin/env node
/**
 * mineGo 种子数据管理脚本
 * REQ-00282: 开发者环境一键初始化与智能诊断系统
 * 
 * 用法: 
 *   node database/seeds/index.js           # 填充所有种子数据
 *   node database/seeds/index.js --clean   # 清理种子数据
 *   node database/seeds/index.js --refresh # 重新填充
 */

'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

const log = {
  info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`)
};

// 数据库连接
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/minego'
});

/**
 * 测试用户数据
 */
const testUsers = [
  {
    id: 'test-user-1',
    username: 'player1',
    email: 'player1@test.com',
    password_hash: '$2b$10$dummy.hash.for.testing.purposes.only',
    level: 10,
    experience: 5000,
    coins: 1000,
    gems: 100,
    role: 'player',
    created_at: new Date(),
    updated_at: new Date()
  },
  {
    id: 'test-user-2',
    username: 'player2',
    email: 'player2@test.com',
    password_hash: '$2b$10$dummy.hash.for.testing.purposes.only',
    level: 15,
    experience: 12000,
    coins: 2500,
    gems: 200,
    role: 'player',
    created_at: new Date(),
    updated_at: new Date()
  },
  {
    id: 'test-admin',
    username: 'admin',
    email: 'admin@test.com',
    password_hash: '$2b$10$dummy.hash.for.testing.purposes.only',
    level: 50,
    experience: 100000,
    coins: 10000,
    gems: 1000,
    role: 'admin',
    created_at: new Date(),
    updated_at: new Date()
  }
];

/**
 * 测试精灵数据
 */
const testPokemon = [
  { id: 'pokemon-1', species_id: 25, name: 'Pikachu', cp: 500, iv_attack: 15, iv_defense: 14, iv_stamina: 13, latitude: 39.9042, longitude: 116.4074, owner_id: 'test-user-1' },
  { id: 'pokemon-2', species_id: 4, name: 'Charmander', cp: 300, iv_attack: 12, iv_defense: 10, iv_stamina: 11, latitude: 39.9142, longitude: 116.4174, owner_id: 'test-user-1' },
  { id: 'pokemon-3', species_id: 1, name: 'Bulbasaur', cp: 250, iv_attack: 10, iv_defense: 12, iv_stamina: 14, latitude: 39.9242, longitude: 116.4274, owner_id: 'test-user-2' },
  { id: 'pokemon-4', species_id: 7, name: 'Squirtle', cp: 280, iv_attack: 11, iv_defense: 13, iv_stamina: 12, latitude: 39.9342, longitude: 116.4374, owner_id: 'test-user-2' },
  { id: 'pokemon-5', species_id: 150, name: 'Mewtwo', cp: 4500, iv_attack: 15, iv_defense: 15, iv_stamina: 15, latitude: 39.9442, longitude: 116.4474, owner_id: 'test-admin' }
];

/**
 * 测试道具数据
 */
const testItems = [
  { id: 'item-1', item_type: 'pokeball', name: 'Poké Ball', quantity: 50, owner_id: 'test-user-1' },
  { id: 'item-2', item_type: 'greatball', name: 'Great Ball', quantity: 30, owner_id: 'test-user-1' },
  { id: 'item-3', item_type: 'ultraball', name: 'Ultra Ball', quantity: 20, owner_id: 'test-user-1' },
  { id: 'item-4', item_type: 'potion', name: 'Potion', quantity: 25, owner_id: 'test-user-1' },
  { id: 'item-5', item_type: 'revive', name: 'Revive', quantity: 10, owner_id: 'test-user-1' },
  { id: 'item-6', item_type: 'razz_berry', name: 'Razz Berry', quantity: 30, owner_id: 'test-user-2' }
];

/**
 * 填充用户数据
 */
async function seedUsers() {
  log.info('填充测试用户...');
  
  for (const user of testUsers) {
    try {
      await pool.query(`
        INSERT INTO users (id, username, email, password_hash, level, experience, coins, gems, role, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          level = EXCLUDED.level,
          coins = EXCLUDED.coins
      `, [user.id, user.username, user.email, user.password_hash, user.level, user.experience, user.coins, user.gems, user.role, user.created_at, user.updated_at]);
    } catch (err) {
      log.warn(`用户 ${user.username} 插入失败: ${err.message}`);
    }
  }
  
  log.success(`已填充 ${testUsers.length} 个测试用户`);
}

/**
 * 填充精灵数据
 */
async function seedPokemon() {
  log.info('填充测试精灵...');
  
  for (const pokemon of testPokemon) {
    try {
      await pool.query(`
        INSERT INTO pokemon (id, species_id, name, cp, iv_attack, iv_defense, iv_stamina, latitude, longitude, owner_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (id) DO UPDATE SET
          cp = EXCLUDED.cp,
          owner_id = EXCLUDED.owner_id
      `, [pokemon.id, pokemon.species_id, pokemon.name, pokemon.cp, pokemon.iv_attack, pokemon.iv_defense, pokemon.iv_stamina, pokemon.latitude, pokemon.longitude, pokemon.owner_id]);
    } catch (err) {
      log.warn(`精灵 ${pokemon.name} 插入失败: ${err.message}`);
    }
  }
  
  log.success(`已填充 ${testPokemon.length} 个测试精灵`);
}

/**
 * 填充道具数据
 */
async function seedItems() {
  log.info('填充测试道具...');
  
  for (const item of testItems) {
    try {
      await pool.query(`
        INSERT INTO items (id, item_type, name, quantity, owner_id, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (id) DO UPDATE SET
          quantity = EXCLUDED.quantity
      `, [item.id, item.item_type, item.name, item.quantity, item.owner_id]);
    } catch (err) {
      log.warn(`道具 ${item.name} 插入失败: ${err.message}`);
    }
  }
  
  log.success(`已填充 ${testItems.length} 个测试道具`);
}

/**
 * 清理种子数据
 */
async function cleanSeedData() {
  log.info('清理种子数据...');
  
  try {
    await pool.query("DELETE FROM users WHERE id LIKE 'test-%'");
    await pool.query("DELETE FROM pokemon WHERE id LIKE 'pokemon-%'");
    await pool.query("DELETE FROM items WHERE id LIKE 'item-%'");
    log.success('种子数据已清理');
  } catch (err) {
    log.warn(`清理失败: ${err.message}`);
  }
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const clean = args.includes('--clean');
  const refresh = args.includes('--refresh');

  console.log(`${colors.cyan}🌱 mineGo 种子数据管理${colors.reset}\n`);

  try {
    // 测试连接
    await pool.query('SELECT 1');
    
    if (clean) {
      await cleanSeedData();
    } else if (refresh) {
      await cleanSeedData();
      await seedUsers();
      await seedPokemon();
      await seedItems();
    } else {
      await seedUsers();
      await seedPokemon();
      await seedItems();
    }

    console.log(`\n${colors.green}✓ 种子数据操作完成${colors.reset}`);
  } catch (err) {
    log.error(`数据库连接失败: ${err.message}`);
    log.info('请确保数据库已启动: docker compose up -d postgres');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
