// Generate spawn points around Shanghai pokestop clusters
const { Client } = require('pg');

// 连接串从环境变量读取（原先硬编码了生产库密码）
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required, e.g. postgres://pmg_user:***@127.0.0.1:5432/pmg');
  process.exit(1);
}
const client = new Client({ connectionString: process.env.DATABASE_URL });

// Core locations in Shanghai (from pokestop data)
const centers = [
  { lat: 31.2398, lng: 121.5014, name: '陆家嘴', biome: 'URBAN' },
  { lat: 31.2304, lng: 121.4737, name: '人民广场', biome: 'PARK' },
  { lat: 31.2397, lng: 121.4905, name: '外滩', biome: 'WATERFRONT' },
  { lat: 31.2269, lng: 121.4918, name: '豫园', biome: 'URBAN' },
  { lat: 31.2198, lng: 121.4631, name: '复兴公园', biome: 'PARK' },
  { lat: 31.2350, lng: 121.4800, name: '南京路', biome: 'URBAN' },
  { lat: 31.2280, lng: 121.4750, name: '老西门', biome: 'URBAN' },
];

const BIOMES = ['URBAN', 'PARK', 'WATERFRONT', 'ANY'];

async function seed() {
  await client.connect();

  // Clear existing spawn points
  await client.query('DELETE FROM spawn_points');

  let count = 0;
  // Generate 5-7 spawn points per center with small random offsets
  for (const center of centers) {
    const numSpawns = 5 + Math.floor(Math.random() * 3);
    for (let i = 0; i < numSpawns; i++) {
      // Random offset within ~300m (0.003 degrees ≈ 300m)
      const dlat = (Math.random() - 0.5) * 0.006;
      const dlng = (Math.random() - 0.5) * 0.006;
      const lat = center.lat + dlat;
      const lng = center.lng + dlng;
      const biome = i % 3 === 0 ? 'ANY' : center.biome;

      await client.query(`
        INSERT INTO spawn_points (lat, lng, location, biome, is_active)
        VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326), $5, true)
      `, [lat, lng, lat, lng, biome]);
      count++;
    }
  }

  console.log(`Inserted ${count} spawn points`);
  await client.end();
}

seed().catch(e => { console.error(e); process.exit(1); });
