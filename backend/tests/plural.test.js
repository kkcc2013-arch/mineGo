/**
 * PluralFormLocalization 单元测试
 */

const assert = require('assert');
const PluralFormLocalization = require('../PluralFormLocalization');
const PluralRuleMatcher = require('../PluralRuleMatcher');

describe('PluralFormLocalization', () => {
  let pluralEngine;
  let ruleMatcher;

  before(() => {
    pluralEngine = new PluralFormLocalization();
    ruleMatcher = new PluralRuleMatcher();
  });

  describe('selectPluralForm', () => {
    // 英语测试（单数和其他）
    it('should return "one" for count=1 in English', () => {
      const form = pluralEngine.selectPluralForm(1, 'en-US');
      assert.strictEqual(form, 'one');
    });

    it('should return "other" for count=0 in English', () => {
      const form = pluralEngine.selectPluralForm(0, 'en-US');
      assert.strictEqual(form, 'other');
    });

    it('should return "other" for count=5 in English', () => {
      const form = pluralEngine.selectPluralForm(5, 'en-US');
      assert.strictEqual(form, 'other');
    });

    // 中文测试（无复数）
    it('should return "other" for all counts in Chinese', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(1, 'zh-CN'), 'other');
      assert.strictEqual(pluralEngine.selectPluralForm(0, 'zh-CN'), 'other');
      assert.strictEqual(pluralEngine.selectPluralForm(100, 'zh-CN'), 'other');
    });

    // 俄语测试（四种形式）
    it('should return "one" for count=1 in Russian', () => {
      const form = pluralEngine.selectPluralForm(1, 'ru-RU');
      assert.strictEqual(form, 'one');
    });

    it('should return "few" for count=2-4 in Russian', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(2, 'ru-RU'), 'few');
      assert.strictEqual(pluralEngine.selectPluralForm(3, 'ru-RU'), 'few');
      assert.strictEqual(pluralEngine.selectPluralForm(4, 'ru-RU'), 'few');
    });

    it('should return "many" for count=5-20 in Russian', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(5, 'ru-RU'), 'many');
      assert.strictEqual(pluralEngine.selectPluralForm(10, 'ru-RU'), 'many');
      assert.strictEqual(pluralEngine.selectPluralForm(20, 'ru-RU'), 'many');
    });

    it('should return "other" for count=21 in Russian', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(21, 'ru-RU'), 'one');
      assert.strictEqual(pluralEngine.selectPluralForm(22, 'ru-RU'), 'few');
      assert.strictEqual(pluralEngine.selectPluralForm(25, 'ru-RU'), 'many');
    });

    // 阿拉伯语测试（六种形式）
    it('should return "zero" for count=0 in Arabic', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(0, 'ar-SA'), 'zero');
    });

    it('should return "one" for count=1 in Arabic', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(1, 'ar-SA'), 'one');
    });

    it('should return "two" for count=2 in Arabic', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(2, 'ar-SA'), 'two');
    });

    it('should return "few" for count=3-10 in Arabic', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(3, 'ar-SA'), 'few');
      assert.strictEqual(pluralEngine.selectPluralForm(7, 'ar-SA'), 'few');
      assert.strictEqual(pluralEngine.selectPluralForm(10, 'ar-SA'), 'few');
    });

    it('should return "many" for count=11-99 in Arabic', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(11, 'ar-SA'), 'many');
      assert.strictEqual(pluralEngine.selectPluralForm(50, 'ar-SA'), 'many');
      assert.strictEqual(pluralEngine.selectPluralForm(99, 'ar-SA'), 'many');
    });

    it('should return "other" for count>=100 in Arabic', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(100, 'ar-SA'), 'other');
      assert.strictEqual(pluralEngine.selectPluralForm(200, 'ar-SA'), 'other');
    });

    // 法语测试（one 用于 0 和 1）
    it('should return "one" for count=0 or 1 in French', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(0, 'fr-FR'), 'one');
      assert.strictEqual(pluralEngine.selectPluralForm(1, 'fr-FR'), 'one');
    });

    it('should return "other" for count>1 in French', () => {
      assert.strictEqual(pluralEngine.selectPluralForm(2, 'fr-FR'), 'other');
      assert.strictEqual(pluralEngine.selectPluralForm(100, 'fr-FR'), 'other');
    });
  });

  describe('buildPluralKey', () => {
    it('should build plural key correctly', () => {
      const key = pluralEngine.buildPluralKey('catch.success', 'one');
      assert.strictEqual(key, 'catch.success_one');
    });

    it('should build other plural key', () => {
      const key = pluralEngine.buildPluralKey('pokemon.count', 'other');
      assert.strictEqual(key, 'pokemon.count_other');
    });
  });

  describe('interpolateParams', () => {
    it('should replace {{count}} placeholder', () => {
      const message = pluralEngine.interpolateParams('You caught {{count}} Pokemon', { count: 5 });
      assert.strictEqual(message, 'You caught 5 Pokemon');
    });

    it('should replace multiple placeholders', () => {
      const message = pluralEngine.interpolateParams(
        '{{trainer}} caught {{count}} Pokemon', 
        { trainer: 'Ash', count: 10 }
      );
      assert.strictEqual(message, 'Ash caught 10 Pokemon');
    });

    it('should handle empty template', () => {
      const message = pluralEngine.interpolateParams('', { count: 5 });
      assert.strictEqual(message, '');
    });
  });

  describe('getPluralCategories', () => {
    it('should return categories for English', () => {
      const categories = pluralEngine.getPluralCategories('en-US');
      assert.deepStrictEqual(categories, ['one', 'other']);
    });

    it('should return categories for Russian', () => {
      const categories = pluralEngine.getPluralCategories('ru-RU');
      assert.deepStrictEqual(categories, ['one', 'few', 'many', 'other']);
    });

    it('should return categories for Arabic', () => {
      const categories = pluralEngine.getPluralCategories('ar-SA');
      assert.deepStrictEqual(categories, ['zero', 'one', 'two', 'few', 'many', 'other']);
    });

    it('should return other for Chinese', () => {
      const categories = pluralEngine.getPluralCategories('zh-CN');
      assert.deepStrictEqual(categories, ['other']);
    });

    it('should fallback to other for unknown locale', () => {
      const categories = pluralEngine.getPluralCategories('unknown-XX');
      assert.deepStrictEqual(categories, ['other']);
    });
  });
});

describe('PluralRuleMatcher', () => {
  let ruleMatcher;

  before(() => {
    ruleMatcher = new PluralRuleMatcher();
  });

  describe('matchRule', () => {
    it('should match English rule for n=1', () => {
      const form = ruleMatcher.matchRule(1, 'en-US');
      assert.strictEqual(form, 'one');
    });

    it('should match Russian rule for n=21', () => {
      const form = ruleMatcher.matchRule(21, 'ru-RU');
      assert.strictEqual(form, 'one');
    });

    it('should match Arabic rule for n=0', () => {
      const form = ruleMatcher.matchRule(0, 'ar-SA');
      assert.strictEqual(form, 'zero');
    });
  });

  describe('getRules', () => {
    it('should return rules for exact locale', () => {
      const rules = ruleMatcher.getRules('en-US');
      assert.ok(rules);
      assert.ok(rules.one);
      assert.ok(rules.other);
    });

    it('should return rules for language prefix', () => {
      const rules = ruleMatcher.getRules('en');
      assert.ok(rules);
      assert.ok(rules.one);
      assert.ok(rules.other);
    });

    it('should return null for unknown locale', () => {
      const rules = ruleMatcher.getRules('unknown');
      assert.strictEqual(rules, null);
    });
  });

  describe('validateRules', () => {
    it('should validate English rules', () => {
      const result = ruleMatcher.validateRules('en-US');
      assert.strictEqual(result.valid, true);
    });

    it('should validate Russian rules', () => {
      const result = ruleMatcher.validateRules('ru-RU');
      assert.strictEqual(result.valid, true);
    });
  });

  describe('getSupportedLocales', () => {
    it('should return list of supported locales', () => {
      const locales = ruleMatcher.getSupportedLocales();
      assert.ok(locales.includes('en-US'));
      assert.ok(locales.includes('ru-RU'));
      assert.ok(locales.includes('zh-CN'));
      assert.ok(locales.includes('ar-SA'));
    });
  });

  describe('getCategoryCount', () => {
    it('should return 2 for English', () => {
      const count = ruleMatcher.getCategoryCount('en-US');
      assert.strictEqual(count, 2);
    });

    it('should return 4 for Russian', () => {
      const count = ruleMatcher.getCategoryCount('ru-RU');
      assert.strictEqual(count, 4);
    });

    it('should return 6 for Arabic', () => {
      const count = ruleMatcher.getCategoryCount('ar-SA');
      assert.strictEqual(count, 6);
    });

    it('should return 1 for Chinese', () => {
      const count = ruleMatcher.getCategoryCount('zh-CN');
      assert.strictEqual(count, 1);
    });
  });

  describe('getExampleNumbers', () => {
    it('should return example numbers for Russian "one"', () => {
      const examples = ruleMatcher.getExampleNumbers('ru-RU', 'one', 5);
      assert.ok(examples.includes(1));
      assert.ok(examples.includes(21));
      assert.ok(examples.includes(31));
    });

    it('should return example numbers for Arabic "few"', () => {
      const examples = ruleMatcher.getExampleNumbers('ar-SA', 'few', 5);
      assert.ok(examples.includes(3));
      assert.ok(examples.includes(7));
      assert.ok(examples.includes(10));
    });
  });

  describe('batchMatchRule', () => {
    it('should batch match multiple counts', () => {
      const counts = [0, 1, 2, 3, 5, 10, 20, 21];
      const results = ruleMatcher.batchMatchRule(counts, 'ru-RU');
      
      assert.strictEqual(results.length, 8);
      assert.strictEqual(results[0].category, 'many'); // 0
      assert.strictEqual(results[1].category, 'one');  // 1
      assert.strictEqual(results[2].category, 'few');  // 2
      assert.strictEqual(results[3].category, 'few');  // 3
      assert.strictEqual(results[4].category, 'many'); // 5
      assert.strictEqual(results[5].category, 'many'); // 10
      assert.strictEqual(results[6].category, 'many'); // 20
      assert.strictEqual(results[7].category, 'one');  // 21
    });
  });
});

// 运行测试
if (require.main === module) {
  const Mocha = require('mocha');
  const mocha = new Mocha();
  mocha.addFile(__filename);
  mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}

module.exports = { PluralFormLocalization, PluralRuleMatcher };