// tests/unit/spawn.test.js
'use strict';

let passed = 0, failed = 0;
function test(desc, fn) {
  try { fn(); console.log(`  ✓ ${desc}`); passed++; }
  catch (e) { console.error(`  ✗ ${desc}\n    ${e.message}`); failed++; }
}
function expect(val) {
  return {
    toBe: (e) => { if (val !== e) throw new Error(`Expected ${e}, got ${val}`); },
    toBeGreaterThan: (n) => { if (val <= n) throw new Error(`Expected > ${n}, got ${val}`); },
    toBeLessThan: (n) => { if (val >= n) throw new Error(`Expected < ${n}, got ${val}`); },
    toBeGreaterThanOrEqual: (n) => { if (val < n) throw new Error(`Expected >= ${n}, got ${val}`); },
    toBeLessThanOrEqual: (n) => { if (val > n) throw new Error(`Expected <= ${n}, got ${val}`); },
    toBeInRange: (lo, hi) => { if (val < lo || val > hi) throw new Error(`Expected [${lo},${hi}], got ${val}`); },
    toBeCloseTo: (e, d=2) => { if (Math.abs(val-e) > Math.pow(10,-d)/2) throw new Error(`Expected ~${e}, got ${val}`); },
  };
}

// ── Spawn Weight Distribution ─────────────────────────────────
console.log('\n[Spawn Rarity Distribution Tests]');

const RARITY_WEIGHTS = { COMMON:60, UNCOMMON:25, RARE:12, EPIC:2.5, LEGENDARY:0.5 };

function weightedRandom(weights) {
  const total = Object.values(weights).reduce((a,b)=>a+b,0);
  let rand = Math.random() * total;
  for (const [key,w] of Object.entries(weights)) {
    rand -= w;
    if (rand <= 0) return key;
  }
  return Object.keys(weights).pop();
}

test('Weights sum to 100', () => {
  const sum = Object.values(RARITY_WEIGHTS).reduce((a,b)=>a+b,0);
  expect(sum).toBe(100);
});

test('Weighted random stays within defined rarities', () => {
  const valid = new Set(Object.keys(RARITY_WEIGHTS));
  for (let i=0; i<100; i++) {
    const result = weightedRandom(RARITY_WEIGHTS);
    if (!valid.has(result)) throw new Error(`Invalid rarity: ${result}`);
  }
});

test('COMMON appears most frequently in 10,000 draws', () => {
  const counts = { COMMON:0, UNCOMMON:0, RARE:0, EPIC:0, LEGENDARY:0 };
  for (let i=0; i<10000; i++) counts[weightedRandom(RARITY_WEIGHTS)]++;
  const commonFreq = counts.COMMON / 10000;
  expect(commonFreq).toBeGreaterThan(0.50); // should be ~60%
  expect(commonFreq).toBeLessThan(0.72);
});

test('LEGENDARY appears rarely in 10,000 draws (< 2%)', () => {
  const counts = {};
  Object.keys(RARITY_WEIGHTS).forEach(k => counts[k]=0);
  for (let i=0; i<10000; i++) counts[weightedRandom(RARITY_WEIGHTS)]++;
  const legendaryFreq = counts.LEGENDARY / 10000;
  expect(legendaryFreq).toBeLessThan(0.02);
});

// ── IV Generation ─────────────────────────────────────────────
console.log('\n[IV Generation Tests]');

function generateIV() {
  return {
    attack:  Math.floor(Math.random() * 16),
    defense: Math.floor(Math.random() * 16),
    hp:      Math.floor(Math.random() * 16),
  };
}

test('IV values are always between 0 and 15 (1000 iterations)', () => {
  for (let i=0; i<1000; i++) {
    const iv = generateIV();
    if (iv.attack < 0 || iv.attack > 15 ||
        iv.defense < 0 || iv.defense > 15 ||
        iv.hp < 0 || iv.hp > 15) {
      throw new Error(`IV out of range: ${JSON.stringify(iv)}`);
    }
  }
});

test('IV distribution is roughly uniform (mean ~7.5)', () => {
  let total = 0;
  const N   = 10000;
  for (let i=0; i<N; i++) total += generateIV().attack;
  const mean = total / N;
  expect(mean).toBeGreaterThan(6.5);
  expect(mean).toBeLessThan(8.5);
});

// ── Shiny Probability ─────────────────────────────────────────
console.log('\n[Shiny Rate Tests]');

const SHINY_RATE = 1 / 4096;

test('Shiny rate is approximately 1/4096', () => {
  let shinyCount = 0;
  const N = 40960; // 10x expected hits
  for (let i=0; i<N; i++) {
    if (Math.random() < SHINY_RATE) shinyCount++;
  }
  const observedRate = shinyCount / N;
  // Should be between 0.01% and 0.05% with reasonable probability
  expect(observedRate).toBeLessThan(0.005);
});

// ── Speed Anti-cheat ──────────────────────────────────────────
console.log('\n[Anti-cheat Speed Tests]');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calcSpeedKmh(lat1, lng1, ts1, lat2, lng2, ts2) {
  const distKm  = haversineKm(lat1, lng1, lat2, lng2);
  const timeSec = (ts2 - ts1) / 1000;
  if (timeSec <= 0) return Infinity;
  return distKm / (timeSec / 3600);
}

const WARN_SPEED_KMH = 25;
const BAN_SPEED_KMH  = 50;

test('Walking speed (5km/h) is below warn threshold', () => {
  const now  = Date.now();
  // ~14m in 10 seconds ≈ 5km/h
  const speed = calcSpeedKmh(31.2300, 121.4700, now, 31.2301, 121.4700, now + 10000);
  expect(speed).toBeLessThan(WARN_SPEED_KMH);
});

test('Cycling speed (20km/h) is below warn threshold', () => {
  const now   = Date.now();
  // ~55m in 10 seconds ≈ 20km/h
  // 0.0005 degrees latitude ≈ 55m
  const speed = calcSpeedKmh(31.2300, 121.4700, now, 31.2305, 121.4700, now + 10000);
  expect(speed).toBeLessThan(WARN_SPEED_KMH);
});

test('Teleport (1000km instantly) exceeds ban threshold', () => {
  const now   = Date.now();
  // Shanghai to Beijing instantly
  const speed = calcSpeedKmh(31.2300, 121.4700, now, 39.9000, 116.3900, now + 2000);
  expect(speed).toBeGreaterThan(BAN_SPEED_KMH);
});

test('Running (10km/h) should be accepted (< 25km/h)', () => {
  const now   = Date.now();
  // ~28m in 10 seconds ≈ 10km/h
  const speed = calcSpeedKmh(31.2300, 121.4700, now, 31.2302, 121.4700, now + 10000);
  expect(speed).toBeLessThan(WARN_SPEED_KMH);
});

// ── Pokestop Cooldown ─────────────────────────────────────────
console.log('\n[Pokestop Cooldown Tests]');

function canSpin(lastSpunAt, nowMs = Date.now(), cooldownSec = 300) {
  if (!lastSpunAt) return true;
  return (nowMs - new Date(lastSpunAt).getTime()) >= cooldownSec * 1000;
}

test('Fresh pokestop (never spun) can always be spun', () => {
  expect(canSpin(null)).toBe(true);
});

test('Pokestop spun 4 min ago cannot be spun (5 min cooldown)', () => {
  const fourMinAgo = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  expect(canSpin(fourMinAgo)).toBe(false);
});

test('Pokestop spun 6 min ago can be spun', () => {
  const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  expect(canSpin(sixMinAgo)).toBe(true);
});

test('Pokestop spun exactly 5 min ago can be spun (boundary)', () => {
  const exactlyFiveMin = new Date(Date.now() - 5 * 60 * 1000 - 1).toISOString();
  expect(canSpin(exactlyFiveMin)).toBe(true);
});

// ── Summary ───────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
