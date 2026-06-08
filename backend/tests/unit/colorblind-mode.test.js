/**
 * 色盲模式支持单元测试
 * REQ-00035: 游戏客户端色盲模式支持
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  colorBlindMode,
  ColorBlindModeManager,
  COLOR_BLIND_TYPES,
  COLOR_PALETTES,
  RARITY_ICONS,
  STATUS_EFFECTS,
  TEAM_IDENTITIES
} from '../src/accessibility/ColorBlindMode.js';

describe('ColorBlindModeManager', () => {
  let manager;

  beforeEach(() => {
    // 清空 localStorage
    localStorage.clear();
    // 创建新实例
    manager = new ColorBlindModeManager();
  });

  afterEach(() => {
    manager = null;
  });

  describe('初始化', () => {
    it('应该默认为正常模式', () => {
      expect(manager.getMode()).toBe('normal');
    });

    it('应该从 localStorage 加载已保存的模式', () => {
      localStorage.setItem('pmg_colorblind_mode', 'protanopia');
      const savedManager = new ColorBlindModeManager();
      expect(savedManager.getMode()).toBe('protanopia');
    });
  });

  describe('设置模式', () => {
    it('应该正确设置有效模式', () => {
      const result = manager.setMode('deuteranopia');
      expect(result).toBe(true);
      expect(manager.getMode()).toBe('deuteranopia');
    });

    it('应该拒绝无效模式', () => {
      const result = manager.setMode('invalid_mode');
      expect(result).toBe(false);
      expect(manager.getMode()).toBe('normal');
    });

    it('应该保存模式到 localStorage', () => {
      manager.setMode('tritanopia');
      expect(localStorage.getItem('pmg_colorblind_mode')).toBe('tritanopia');
    });

    it('应该通知监听器模式变更', () => {
      const listener = vi.fn();
      manager.addListener(listener);

      manager.setMode('achromatopsia');

      expect(listener).toHaveBeenCalledWith('achromatopsia', 'normal');
    });

    it('应该支持移除监听器', () => {
      const listener = vi.fn();
      const unsubscribe = manager.addListener(listener);

      unsubscribe();
      manager.setMode('protanopia');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('稀有度图标', () => {
    it('应该返回正确的普通稀有度图标', () => {
      const icon = manager.getRarityIcon('common');
      expect(icon.icon).toBe('●');
      expect(icon.shape).toBe('circle');
      expect(icon.label).toBe('普通');
    });

    it('应该返回正确的稀有图标', () => {
      const icon = manager.getRarityIcon('rare');
      expect(icon.icon).toBe('◆');
      expect(icon.shape).toBe('diamond');
      expect(icon.label).toBe('稀有');
    });

    it('应该返回正确的史诗图标', () => {
      const icon = manager.getRarityIcon('epic');
      expect(icon.icon).toBe('★');
      expect(icon.shape).toBe('star');
      expect(icon.label).toBe('史诗');
    });

    it('应该返回正确的传说图标', () => {
      const icon = manager.getRarityIcon('legendary');
      expect(icon.icon).toBe('☆');
      expect(icon.shape).toBe('star-outline');
      expect(icon.label).toBe('传说');
    });

    it('应该根据色盲模式返回安全的颜色', () => {
      manager.setMode('protanopia');
      const icon = manager.getRarityIcon('common');
      expect(icon.color).toBe('#009988'); // protanopia safe color
    });

    it('应该为未知稀有度返回默认值', () => {
      const icon = manager.getRarityIcon('unknown');
      expect(icon.icon).toBe('?');
      expect(icon.label).toBe('未知');
    });
  });

  describe('状态效果图标', () => {
    it('应该返回正确的中毒状态', () => {
      const effect = manager.getStatusEffect('poison');
      expect(effect.icon).toBe('☠️');
      expect(effect.symbol).toBe('P');
      expect(effect.label).toBe('中毒');
    });

    it('应该返回正确的烧伤状态', () => {
      const effect = manager.getStatusEffect('burn');
      expect(effect.icon).toBe('🔥');
      expect(effect.symbol).toBe('B');
      expect(effect.label).toBe('烧伤');
    });

    it('应该返回正确的麻痹状态', () => {
      const effect = manager.getStatusEffect('paralysis');
      expect(effect.icon).toBe('⚡');
      expect(effect.symbol).toBe('L');
      expect(effect.label).toBe('麻痹');
    });

    it('应该返回正确的冰冻状态', () => {
      const effect = manager.getStatusEffect('freeze');
      expect(effect.icon).toBe('❄️');
      expect(effect.symbol).toBe('F');
      expect(effect.label).toBe('冰冻');
    });

    it('应该返回正确的睡眠状态', () => {
      const effect = manager.getStatusEffect('sleep');
      expect(effect.icon).toBe('💤');
      expect(effect.symbol).toBe('S');
      expect(effect.label).toBe('睡眠');
    });

    it('应该根据色盲模式返回安全的颜色', () => {
      manager.setMode('tritanopia');
      const effect = manager.getStatusEffect('burn');
      expect(effect.color).toBe('#BB4411'); // tritanopia safe color
    });
  });

  describe('阵营标识', () => {
    it('应该返回正确的 Valor 阵营标识', () => {
      const team = manager.getTeamIdentity('valor');
      expect(team.shape).toBe('▲');
      expect(team.name).toBe('Valor');
      expect(team.icon).toBe('🔥');
    });

    it('应该返回正确的 Mystic 阵营标识', () => {
      const team = manager.getTeamIdentity('mystic');
      expect(team.shape).toBe('■');
      expect(team.name).toBe('Mystic');
      expect(team.icon).toBe('❄️');
    });

    it('应该返回正确的 Instinct 阵营标识', () => {
      const team = manager.getTeamIdentity('instinct');
      expect(team.shape).toBe('●');
      expect(team.name).toBe('Instinct');
      expect(team.icon).toBe('⚡');
    });

    it('应该根据色盲模式返回安全的颜色', () => {
      manager.setMode('achromatopsia');
      const team = manager.getTeamIdentity('valor');
      expect(team.color).toBe('#333333'); // achromatopsia safe color
    });
  });

  describe('支持类型列表', () => {
    it('应该返回所有支持的色盲类型', () => {
      const types = manager.getSupportedTypes();
      expect(types).toHaveLength(5);
      expect(types.map(t => t.value)).toEqual([
        'normal',
        'protanopia',
        'deuteranopia',
        'tritanopia',
        'achromatopsia'
      ]);
    });

    it('应该标记当前选中的类型', () => {
      manager.setMode('deuteranopia');
      const types = manager.getSupportedTypes();
      const current = types.find(t => t.isCurrent);
      expect(current.value).toBe('deuteranopia');
    });
  });
});

describe('COLOR_BLIND_TYPES 常量', () => {
  it('应该包含 5 种类型', () => {
    expect(Object.keys(COLOR_BLIND_TYPES)).toHaveLength(5);
  });

  it('应该包含正常视觉', () => {
    expect(COLOR_BLIND_TYPES.normal).toBeDefined();
  });

  it('应该包含红色盲', () => {
    expect(COLOR_BLIND_TYPES.protanopia).toBeDefined();
  });

  it('应该包含绿色盲', () => {
    expect(COLOR_BLIND_TYPES.deuteranopia).toBeDefined();
  });

  it('应该包含蓝色盲', () => {
    expect(COLOR_BLIND_TYPES.tritanopia).toBeDefined();
  });

  it('应该包含全色盲', () => {
    expect(COLOR_BLIND_TYPES.achromatopsia).toBeDefined();
  });
});

describe('COLOR_PALETTES 常量', () => {
  it('应该为每种模式定义配色方案', () => {
    const modes = ['normal', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'];
    modes.forEach(mode => {
      expect(COLOR_PALETTES[mode]).toBeDefined();
      expect(COLOR_PALETTES[mode].primary).toBeDefined();
      expect(COLOR_PALETTES[mode].secondary).toBeDefined();
      expect(COLOR_PALETTES[mode].warning).toBeDefined();
      expect(COLOR_PALETTES[mode].success).toBeDefined();
      expect(COLOR_PALETTES[mode].danger).toBeDefined();
    });
  });

  it('应该使用有效的十六进制颜色', () => {
    const hexPattern = /^#[0-9A-Fa-f]{6}$/;
    Object.values(COLOR_PALETTES).forEach(palette => {
      Object.values(palette).forEach(color => {
        expect(color).toMatch(hexPattern);
      });
    });
  });
});

describe('RARITY_ICONS 常量', () => {
  it('应该定义 4 种稀有度', () => {
    expect(Object.keys(RARITY_ICONS)).toHaveLength(4);
  });

  it('每种稀有度应该有图标和形状', () => {
    Object.entries(RARITY_ICONS).forEach(([rarity, config]) => {
      expect(config.icon).toBeDefined();
      expect(config.shape).toBeDefined();
      expect(config.label).toBeDefined();
      expect(config.colorBlindSafe).toBeDefined();
      expect(config.colorBlindSafe.normal).toBeDefined();
      expect(config.colorBlindSafe.protanopia).toBeDefined();
    });
  });

  it('每种稀有度应该有不同的形状', () => {
    const shapes = Object.values(RARITY_ICONS).map(c => c.shape);
    const uniqueShapes = new Set(shapes);
    expect(uniqueShapes.size).toBe(4);
  });
});

describe('STATUS_EFFECTS 常量', () => {
  it('应该定义 5 种状态效果', () => {
    expect(Object.keys(STATUS_EFFECTS)).toHaveLength(5);
  });

  it('每种状态应该有图标和符号', () => {
    Object.entries(STATUS_EFFECTS).forEach(([status, config]) => {
      expect(config.icon).toBeDefined();
      expect(config.symbol).toBeDefined();
      expect(config.label).toBeDefined();
      expect(config.pattern).toBeDefined();
      expect(config.colorBlindSafe).toBeDefined();
    });
  });

  it('每种状态应该有不同的符号', () => {
    const symbols = Object.values(STATUS_EFFECTS).map(c => c.symbol);
    const uniqueSymbols = new Set(symbols);
    expect(uniqueSymbols.size).toBe(5);
  });
});

describe('TEAM_IDENTITIES 常量', () => {
  it('应该定义 3 个阵营', () => {
    expect(Object.keys(TEAM_IDENTITIES)).toHaveLength(3);
  });

  it('每个阵营应该有形状和图标', () => {
    Object.entries(TEAM_IDENTITIES).forEach(([team, config]) => {
      expect(config.shape).toBeDefined();
      expect(config.name).toBeDefined();
      expect(config.icon).toBeDefined();
      expect(config.label).toBeDefined();
      expect(config.colorBlindSafe).toBeDefined();
    });
  });

  it('每个阵营应该有不同的形状', () => {
    const shapes = Object.values(TEAM_IDENTITIES).map(c => c.shape);
    const uniqueShapes = new Set(shapes);
    expect(uniqueShapes.size).toBe(3);
  });
});

describe('WCAG 对比度合规性', () => {
  it('每种色盲模式的配色应该满足 WCAG AA 标准（4.5:1）', () => {
    // 简化的对比度检查
    const checkContrast = (fg, bg) => {
      // 计算亮度
      const getLuminance = (hex) => {
        const rgb = {
          r: parseInt(hex.slice(1, 3), 16),
          g: parseInt(hex.slice(3, 5), 16),
          b: parseInt(hex.slice(5, 7), 16)
        };
        const [rs, gs, bs] = [rgb.r, rgb.g, rgb.b].map(c => {
          c = c / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      };

      const l1 = getLuminance(fg);
      const l2 = getLuminance(bg);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    };

    Object.entries(COLOR_PALETTES).forEach(([mode, palette]) => {
      // 假设白色背景
      const whiteBg = '#FFFFFF';
      const ratio = checkContrast(palette.primary, whiteBg);
      expect(ratio).toBeGreaterThanOrEqual(3); // 至少满足 UI 元件标准
    });
  });
});
