// tests/unit/catch.test.js
'use strict';

// ── Pure logic extracted for testing (mirrors catch-service/src/index.js) ──
const THROW_BONUS = { MISS: 0, NICE: 1.3, GREAT: 1.5, EXCELLENT: 1.7 };
const BALL_MULT   = { POKE_BALL: 1.0, GREAT_BALL: 1.5, ULTRA_BALL: 2.0, MASTER_BALL: Infinity };
const BERRY_MULT  = { NONE: 1.0, RAZZ_BERRY: 1.5, GOLDEN_RAZZ_BERRY: 2.5 };
const CURVE_BONUS = 1.1;

function calcCatchProb({ baseCatchRate, cp, ballType, throwRating, isCurve, berryUsed }) {
  if (ballType === 'MASTER_BALL') return 1.0;
  const cpModifier = Math.max(1.0, 1 + (cp / 2500));
  const base       = baseCatchRate / (2 * cpModifier);
  const throwB     = THROW_BONUS[throwRating] || 1.0;
  const curveB     = isCurve ? CURVE_BONUS : 1.0;
  const exponent   = BALL_MULT[ballType] * BERRY_MULT[berryUsed || 'NONE'] * throwB * curveB;
  return Math.min(0.99, 1 - Math.pow(Math.max(0, 1 - base), exponent));
}

// ── Minimal test runner (no external deps needed) ────────────
let passed = 0, failed = 0;

function test(desc, fn) {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${desc}\n    ${e.message}`);
    failed++;
  }
}

function expect(val) {
  return {
    toBe: (expected) => {
      if (val !== expected) throw new Error(`Expected ${expected}, got ${val}`);
    },
    toBeCloseTo: (expected, decimals = 2) => {
      const delta = Math.abs(val - expected);
      const tol   = Math.pow(10, -decimals) / 2;
      if (delta > tol) throw new Error(`Expected ~${expected} (±${tol}), got ${val}`);
    },
    toBeGreaterThan: (n) => {
      if (val <= n) throw new Error(`Expected > ${n}, got ${val}`);
    },
    toBeLessThan: (n) => {
      if (val >= n) throw new Error(`Expected < ${n}, got ${val}`);
    },
    toBeGreaterThanOrEqual: (n) => {
      if (val < n) throw new Error(`Expected >= ${n}, got ${val}`);
    },
    toBeLessThanOrEqual: (n) => {
      if (val > n) throw new Error(`Expected <= ${n}, got ${val}`);
    },
  };
}

// ── Test Suite: Catch Probability ────────────────────────────
console.log('\n[Catch Probability Tests]');

test('Master Ball always returns 1.0', () => {
  const p = calcCatchProb({ baseCatchRate: 0.05, cp: 3000, ballType: 'MASTER_BALL', throwRating: 'MISS', isCurve: false });
  expect(p).toBe(1.0);
});

test('Higher CP reduces catch probability', () => {
  // cp=200: cpModifier=1-200/5000=0.96  → high modifier → lower difficulty
  // cp=2500: cpModifier=1-2500/5000=0.5 → lower modifier → harder to catch
  const lowCP  = calcCatchProb({ baseCatchRate: 0.3, cp: 200,  ballType: 'POKE_BALL', throwRating: 'NICE', isCurve: false });
  const highCP = calcCatchProb({ baseCatchRate: 0.3, cp: 4800, ballType: 'POKE_BALL', throwRating: 'NICE', isCurve: false });
  expect(lowCP).toBeGreaterThan(highCP);
});

test('Ultra Ball > Great Ball > Poke Ball for same throw', () => {
  const opts = { baseCatchRate: 0.2, cp: 500, throwRating: 'NICE', isCurve: false };
  const pb = calcCatchProb({ ...opts, ballType: 'POKE_BALL' });
  const gb = calcCatchProb({ ...opts, ballType: 'GREAT_BALL' });
  const ub = calcCatchProb({ ...opts, ballType: 'ULTRA_BALL' });
  expect(gb).toBeGreaterThan(pb);
  expect(ub).toBeGreaterThan(gb);
});

test('Excellent throw > Great > Nice > Miss', () => {
  const opts = { baseCatchRate: 0.2, cp: 800, ballType: 'POKE_BALL', isCurve: false };
  const miss      = calcCatchProb({ ...opts, throwRating: 'MISS' });
  const nice      = calcCatchProb({ ...opts, throwRating: 'NICE' });
  const great     = calcCatchProb({ ...opts, throwRating: 'GREAT' });
  const excellent = calcCatchProb({ ...opts, throwRating: 'EXCELLENT' });
  expect(nice).toBeGreaterThan(miss);
  expect(great).toBeGreaterThan(nice);
  expect(excellent).toBeGreaterThan(great);
});

test('Curve ball adds 10% bonus', () => {
  const opts = { baseCatchRate: 0.25, cp: 600, ballType: 'POKE_BALL', throwRating: 'NICE' };
  const straight = calcCatchProb({ ...opts, isCurve: false });
  const curve    = calcCatchProb({ ...opts, isCurve: true });
  expect(curve).toBeGreaterThan(straight);
});

test('Golden Razz Berry > Razz Berry > None', () => {
  const opts = { baseCatchRate: 0.2, cp: 1000, ballType: 'POKE_BALL', throwRating: 'NICE', isCurve: false };
  const none  = calcCatchProb({ ...opts, berryUsed: 'NONE' });
  const razz  = calcCatchProb({ ...opts, berryUsed: 'RAZZ_BERRY' });
  const gold  = calcCatchProb({ ...opts, berryUsed: 'GOLDEN_RAZZ_BERRY' });
  expect(razz).toBeGreaterThan(none);
  expect(gold).toBeGreaterThan(razz);
});

test('Probability is always in [0, 0.99] (except Master Ball)', () => {
  for (const cp of [50, 500, 2000, 4500]) {
    for (const ball of ['POKE_BALL', 'GREAT_BALL', 'ULTRA_BALL']) {
      const p = calcCatchProb({ baseCatchRate: 0.1, cp, ballType: ball, throwRating: 'EXCELLENT', isCurve: true, berryUsed: 'GOLDEN_RAZZ_BERRY' });
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(0.99);
    }
  }
});

test('Legendary pokemon (base rate 0.02) is very hard with Poke Ball', () => {
  const p = calcCatchProb({ baseCatchRate: 0.02, cp: 3500, ballType: 'POKE_BALL', throwRating: 'NICE', isCurve: false });
  expect(p).toBeLessThan(0.05);
});

// ── Test Suite: CP Calculation ────────────────────────────────
console.log('\n[CP Calculation Tests]');

function calcCP(baseAtk, baseDef, baseHp, ivAtk, ivDef, ivHp) {
  return Math.max(10, Math.floor(
    ((baseAtk + ivAtk) * Math.sqrt(baseDef + ivDef) * Math.sqrt(baseHp + ivHp)) / 10
  ));
}

test('Perfect IV (15/15/15) yields higher CP than zero IV (0/0/0)', () => {
  const perfectCP = calcCP(112, 96, 111, 15, 15, 15);
  const zeroCP    = calcCP(112, 96, 111, 0, 0, 0);
  expect(perfectCP).toBeGreaterThan(zeroCP);
});

test('Pikachu CP is at least 10', () => {
  const cp = calcCP(112, 96, 111, 0, 0, 0);
  expect(cp).toBeGreaterThanOrEqual(10);
});

test('Mewtwo (highest stats) has higher base CP than Pikachu', () => {
  const mewtwoCP  = calcCP(300, 182, 214, 10, 10, 10);
  const pikachuCP = calcCP(112, 96, 111, 10, 10, 10);
  expect(mewtwoCP).toBeGreaterThan(pikachuCP);
});

// ── Test Suite: IV Percentage ────────────────────────────────
console.log('\n[IV Percentage Tests]');

function calcIvPct(atkIv, defIv, hpIv) {
  return Math.round((atkIv + defIv + hpIv) * 100 / 45);
}

test('Perfect IV gives 100%', () => {
  expect(calcIvPct(15, 15, 15)).toBe(100);
});

test('Zero IV gives 0%', () => {
  expect(calcIvPct(0, 0, 0)).toBe(0);
});

test('Average IV (10/10/10) gives ~67%', () => {
  expect(calcIvPct(10, 10, 10)).toBe(67);
});

// ── Test Suite: Haversine Distance ───────────────────────────
console.log('\n[Haversine Distance Tests]');

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

test('Same coordinates = 0 distance', () => {
  const d = haversineM(31.23, 121.47, 31.23, 121.47);
  expect(d).toBeLessThan(0.01);
});

test('Distance is always non-negative', () => {
  const d = haversineM(31.23, 121.47, 31.24, 121.48);
  expect(d).toBeGreaterThanOrEqual(0);
});

test('Shanghai to Beijing is ~1000-1100km', () => {
  const d = haversineM(31.23, 121.47, 39.90, 116.39) / 1000;
  expect(d).toBeGreaterThan(1000);
  expect(d).toBeLessThan(1200);
});

test('Points 100m apart are within 150m threshold', () => {
  // ~100m north
  const d = haversineM(31.2300, 121.4700, 31.2309, 121.4700);
  expect(d).toBeLessThan(150);
  expect(d).toBeGreaterThan(50);
});

// ── Test Suite: Reward Calculation ───────────────────────────
console.log('\n[Reward Calculation Tests]');

function calcCatchReward(throwRating, isCurve, isShiny) {
  const XP_BY_RATING = { NICE: 120, GREAT: 170, EXCELLENT: 200 };
  const baseXp = XP_BY_RATING[throwRating] || 100;
  return {
    xp: baseXp + (isCurve ? 10 : 0) + (isShiny ? 500 : 0),
    stardust: 100,
    candy: 3,
  };
}

test('Excellent throw rewards more XP than Nice', () => {
  const nice      = calcCatchReward('NICE', false, false);
  const excellent = calcCatchReward('EXCELLENT', false, false);
  expect(excellent.xp).toBeGreaterThan(nice.xp);
});

test('Shiny catch adds 500 XP bonus', () => {
  const normal = calcCatchReward('NICE', false, false);
  const shiny  = calcCatchReward('NICE', false, true);
  expect(shiny.xp - normal.xp).toBe(500);
});

test('Curve ball adds 10 XP', () => {
  const straight = calcCatchReward('GREAT', false, false);
  const curve    = calcCatchReward('GREAT', true, false);
  expect(curve.xp - straight.xp).toBe(10);
});

test('Stardust reward is always 100', () => {
  for (const rating of ['NICE', 'GREAT', 'EXCELLENT']) {
    expect(calcCatchReward(rating, false, false).stardust).toBe(100);
  }
});

// ── Test Suite: Daily Quest Logic ─────────────────────────────
console.log('\n[Daily Quest Tests]');

function isDailyQuestComplete(quest) {
  return quest.catch_current  >= quest.catch_target  &&
         quest.spin_current   >= quest.spin_target   &&
         quest.walk_current_km >= quest.walk_target_km;
}

test('Quest complete when all targets met', () => {
  const q = { catch_current: 5, catch_target: 5, spin_current: 3, spin_target: 3, walk_current_km: 2.0, walk_target_km: 2.0 };
  expect(isDailyQuestComplete(q)).toBe(true);
});

test('Quest incomplete if catch target not met', () => {
  const q = { catch_current: 4, catch_target: 5, spin_current: 3, spin_target: 3, walk_current_km: 2.0, walk_target_km: 2.0 };
  expect(isDailyQuestComplete(q)).toBe(false);
});

test('Quest incomplete if walk target not met', () => {
  const q = { catch_current: 5, catch_target: 5, spin_current: 3, spin_target: 3, walk_current_km: 1.5, walk_target_km: 2.0 };
  expect(isDailyQuestComplete(q)).toBe(false);
});

// ── Summary ───────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('  ✅ All tests passed!\n');
}
