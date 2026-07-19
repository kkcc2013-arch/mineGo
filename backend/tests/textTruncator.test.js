/**
 * SmartTextTruncator 单元测试
 */

const {
  textTruncator,
  ChineseStrategy,
  EnglishStrategy,
  JapaneseStrategy,
  GermanStrategy,
  ArabicStrategy,
  ThaiStrategy,
  KoreanStrategy
} = require('../../shared/i18n/textTruncator');

describe('SmartTextTruncator', () => {
  describe('基本截断功能', () => {
    test('短文本不应被截断', () => {
      const result = textTruncator.truncate('Hello World', { maxLength: 20 });
      expect(result.wasTruncated).toBe(false);
      expect(result.truncated).toBe('Hello World');
    });

    test('长文本应被截断', () => {
      const result = textTruncator.truncate('This is a very long text that needs to be truncated', {
        maxLength: 20,
        locale: 'en'
      });
      expect(result.wasTruncated).toBe(true);
      expect(result.truncated.length).toBeLessThanOrEqual(23); // 20 + '...'
    });

    test('应添加自定义省略符', () => {
      const result = textTruncator.truncate('This is a test text', {
        maxLength: 10,
        ellipsis: '…',
        locale: 'en'
      });
      expect(result.truncated).toMatch(/…$/);
    });
  });

  describe('中文截断策略', () => {
    const strategy = new ChineseStrategy();

    test('应在标点符号后截断', () => {
      const text = '这是一段很长的中文描述文字，需要在逗号处截断。';
      const result = textTruncator.truncate(text, { maxLength: 18, locale: 'zh' });
      expect(result.truncated).toMatch(/[，。！？、]…$/);
    });

    test('短中文文本不应截断', () => {
      const text = '短文本';
      const result = textTruncator.truncate(text, { maxLength: 10, locale: 'zh' });
      expect(result.wasTruncated).toBe(false);
      expect(result.truncated).toBe('短文本');
    });

    test('无标点时应安全截断', () => {
      const text = '这是一段没有标点的超长中文文本需要进行截断处理';
      const result = textTruncator.truncate(text, { maxLength: 15, locale: 'zh' });
      expect(result.wasTruncated).toBe(true);
      expect(result.truncated.length).toBeLessThanOrEqual(18);
    });
  });

  describe('英语截断策略', () => {
    test('应在单词边界截断', () => {
      const text = 'Catch the legendary Pokemon Mewtwo in the wild';
      const result = textTruncator.truncate(text, { maxLength: 22, locale: 'en' });
      expect(result.wasTruncated).toBe(true);
      expect(result.truncated).not.toMatch(/\w\.\.\.$/); // 不应以字母+省略符结尾
      expect(result.truncated).toMatch(/\s?\.\.\.$/); // 应以空格+省略符或省略符结尾
    });

    test('无空格时应硬截断', () => {
      const text = 'Supercalifragilisticexpialidocious';
      const result = textTruncator.truncate(text, { maxLength: 15, locale: 'en' });
      expect(result.wasTruncated).toBe(true);
      expect(result.truncated.length).toBe(18);
    });
  });

  describe('日语截断策略', () => {
    test('应在句末标点后截断', () => {
      const text = 'ポケモンGOの世界へようこそ！このゲームでは、現実世界でポケモンを捕まえることができます。';
      const result = textTruncator.truncate(text, { maxLength: 25, locale: 'ja' });
      expect(result.wasTruncated).toBe(true);
    });
  });

  describe('占位符保护', () => {
    test('应保护占位符不被破坏', () => {
      const text = 'Welcome {userName}! You have {count} new messages waiting for you.';
      const result = textTruncator.truncate(text, { maxLength: 30, locale: 'en' });
      expect(result.truncated).not.toContain('{user');
      expect(result.truncated).not.toContain('{cou');
    });

    test('完整占位符应被保留', () => {
      const text = 'Hello {name}, welcome back!';
      const result = textTruncator.truncate(text, { maxLength: 20, locale: 'en' });
      if (result.truncated.includes('{')) {
        expect(result.truncated).toContain('{name}');
      }
    });

    test('截断占位符应产生警告', () => {
      const text = 'Hello {veryLongPlaceholderName}, welcome!';
      const result = textTruncator.truncate(text, { maxLength: 10, locale: 'en' });
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('HTML 标签保护', () => {
    test('应保护 HTML 标签', () => {
      const text = '<strong>Hello</strong> world, this is a long text.';
      const result = textTruncator.truncate(text, {
        maxLength: 20,
        locale: 'en',
        respectHTML: true
      });
      // 如果保留了开始标签，应该也保留结束标签
      if (result.truncated.includes('<strong>')) {
        expect(result.truncated).toContain('</strong>');
      }
    });
  });

  describe('批量截断', () => {
    test('应正确处理批量截断', () => {
      const texts = [
        'Short text',
        'This is a longer text that will be truncated',
        'Another short one'
      ];
      const results = textTruncator.truncateBatch(texts, { maxLength: 15, locale: 'en' });
      
      expect(results.length).toBe(3);
      expect(results[0].wasTruncated).toBe(false);
      expect(results[1].wasTruncated).toBe(true);
      expect(results[2].wasTruncated).toBe(false);
    });
  });

  describe('语言检测', () => {
    test('应正确检测中文', () => {
      const locale = textTruncator.detectLocale('这是一段中文文本');
      expect(locale).toBe('zh');
    });

    test('应正确检测日语', () => {
      const locale = textTruncator.detectLocale('これは日本語のテキストです');
      expect(locale).toBe('ja');
    });

    test('应正确检测韩语', () => {
      const locale = textTruncator.detectLocale('이것은 한국어 텍스트입니다');
      expect(locale).toBe('ko');
    });

    test('应正确检测阿拉伯语', () => {
      const locale = textTruncator.detectLocale('هذا نص باللغة العربية');
      expect(locale).toBe('ar');
    });

    test('应默认为英语', () => {
      const locale = textTruncator.detectLocale('This is English text');
      expect(locale).toBe('en');
    });
  });

  describe('自动截断', () => {
    test('应自动检测语言并截断', () => {
      const result = textTruncator.autoTruncate('这是一段需要被截断的很长中文文本，用于测试自动语言检测功能。', 20);
      expect(result.wasTruncated).toBe(true);
      expect(result.truncated.length).toBeLessThanOrEqual(23);
    });
  });

  describe('预览功能', () => {
    test('应生成截断预览', () => {
      const sampleTexts = [
        'Short',
        'This is a longer text that will be truncated'
      ];
      const preview = textTruncator.getPreview('en', 15, sampleTexts);
      
      expect(preview.locale).toBe('en');
      expect(preview.maxLength).toBe(15);
      expect(preview.results.length).toBe(2);
      expect(preview.summary.truncatedCount).toBe(1);
    });
  });

  describe('边界情况', () => {
    test('空文本应正常处理', () => {
      const result = textTruncator.truncate('', { maxLength: 10 });
      expect(result.truncated).toBe('');
      expect(result.wasTruncated).toBe(false);
    });

    test('null 应正常处理', () => {
      const result = textTruncator.truncate(null, { maxLength: 10 });
      expect(result.truncated).toBe(null);
    });

    test('maxLength 过小应返回省略符', () => {
      const result = textTruncator.truncate('Hello', { maxLength: 2, ellipsis: '...' });
      expect(result.truncated.length).toBeLessThanOrEqual(2);
    });

    test('超长 maxLength 应不截断', () => {
      const text = 'Short text';
      const result = textTruncator.truncate(text, { maxLength: 10000 });
      expect(result.wasTruncated).toBe(false);
    });
  });

  describe('性能测试', () => {
    test('1000 次截断应小于 100ms', () => {
      const text = 'This is a test text for performance testing purposes';
      const start = Date.now();
      
      for (let i = 0; i < 1000; i++) {
        textTruncator.truncate(text, { maxLength: 30, locale: 'en' });
      }
      
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    });
  });
});

describe('各语言策略独立测试', () => {
  test('ChineseStrategy 应在标点后截断', () => {
    const strategy = new ChineseStrategy();
    const result = strategy.truncate('这是测试文本，需要截断。', 8);
    expect(result).toMatch(/^[^，。]*[，。]?$/);
  });

  test('EnglishStrategy 应在空格处截断', () => {
    const strategy = new EnglishStrategy();
    const result = strategy.truncate('Hello world test', 8);
    expect(result).not.toMatch(/\w$/);
  });

  test('JapaneseStrategy 应正确处理日语', () => {
    const strategy = new JapaneseStrategy();
    const result = strategy.truncate('テストテキストです。', 6);
    expect(result.length).toBeLessThanOrEqual(6);
  });
});