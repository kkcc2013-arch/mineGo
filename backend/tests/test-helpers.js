// tests/test-helpers.js - Minimal test runner
'use strict';

let passed = 0, failed = 0;
let currentSuite = '';

function describe(name, fn) {
  const prevSuite = currentSuite;
  currentSuite = name;
  console.log(`\n📋 ${name}`);
  fn();
  currentSuite = prevSuite;
}

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✅ ${desc}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${desc}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

function expect(val) {
  return {
    toBe: (expected) => {
      if (val !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`);
      }
    },
    toEqual: (expected) => {
      if (JSON.stringify(val) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`);
      }
    },
    toBeTruthy: () => {
      if (!val) throw new Error(`Expected truthy, got ${JSON.stringify(val)}`);
    },
    toBeFalsy: () => {
      if (val) throw new Error(`Expected falsy, got ${JSON.stringify(val)}`);
    },
    toBeNull: () => {
      if (val !== null) throw new Error(`Expected null, got ${JSON.stringify(val)}`);
    },
    toContain: (s) => {
      if (!val || !val.includes(s)) {
        throw new Error(`"${JSON.stringify(val)}" does not contain "${s}"`);
      }
    },
    toBeGreaterThan: (n) => {
      if (typeof val !== 'number' || val <= n) {
        throw new Error(`Expected ${val} to be greater than ${n}`);
      }
    },
    toBeLessThan: (n) => {
      if (typeof val !== 'number' || val >= n) {
        throw new Error(`Expected ${val} to be less than ${n}`);
      }
    },
    toThrow: () => {
      if (typeof val !== 'function') throw new Error('toThrow requires a function');
      let threw = false;
      try { val(); } catch { threw = true; }
      if (!threw) throw new Error('Expected function to throw');
    },
    not: {
      toBe: (expected) => {
        if (val === expected) {
          throw new Error(`Expected value not to be ${JSON.stringify(expected)}`);
        }
      },
      toBeNull: () => {
        if (val === null) throw new Error('Expected value not to be null');
      }
    }
  };
}

function runTests() {
  console.log('\n========================================');
  console.log('📊 Test Results:');
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📈 Total:  ${passed + failed}`);
  console.log('========================================\n');
  
  if (failed > 0) {
    console.log('❌ Some tests failed!\n');
    process.exit(1);
  } else {
    console.log('🎉 All tests passed!\n');
    process.exit(0);
  }
}

module.exports = { describe, it, expect, runTests };
