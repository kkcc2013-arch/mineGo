// frontend/game-client/src/utils/unitSystem.js
// REQ-00335: 游戏距离单位本地化与智能转换系统
// 单位制配置与格式化工具

'use strict';

import { i18n, getCurrentLocale } from '../i18n/index.js';

/**
 * 单位制枚举
 */
export const UnitSystem = {
  METRIC: 'metric',    // 公制：km, m, kg, °C
  IMPERIAL: 'imperial' // 英制：mi, ft, lb, °F
};

/**
 * 国家/地区到单位制的映射
 */
export const COUNTRY_UNIT_SYSTEM = {
  'US': 'imperial',    // 美国
  'LR': 'imperial',    // 利比里亚
  'MM': 'imperial',    // 缅甸
  'default': 'metric'
};

const STORAGE_KEY = 'pmg_unit_system';
let currentUnitSystem = null;

/**
 * 获取当前单位制
 * @returns {string} 'metric' | 'imperial'
 */
export function getCurrentUnitSystem() {
  if (currentUnitSystem) {
    return currentUnitSystem;
  }
  
  // 1. 检查 localStorage
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && Object.values(UnitSystem).includes(saved)) {
    currentUnitSystem = saved;
    return saved;
  }
  
  // 2. 根据浏览器语言推断
  const locale = navigator.language || navigator.userLanguage;
  if (locale) {
    // en-US, en-LR, my (缅甸语)
    if (locale === 'en-US' || locale === 'en-LR' || locale.startsWith('my')) {
      currentUnitSystem = UnitSystem.IMPERIAL;
      return currentUnitSystem;
    }
  }
  
  // 3. 默认公制
  currentUnitSystem = UnitSystem.METRIC;
  return currentUnitSystem;
}

/**
 * 设置单位制
 * @param {string} system - 'metric' | 'imperial'
 */
export function setUnitSystem(system) {
  if (!Object.values(UnitSystem).includes(system)) {
    console.error('[unitSystem] Invalid unit system:', system);
    return;
  }
  
  currentUnitSystem = system;
  localStorage.setItem(STORAGE_KEY, system);
  
  // 触发全局事件，通知其他组件更新
  window.dispatchEvent(new CustomEvent('unitSystemChanged', {
    detail: { unitSystem: system }
  }));
}

/**
 * 自动检测用户单位制偏好
 * 优先级：用户设置 > 浏览器语言 > IP 地理位置 > 默认公制
 */
export async function detectUnitSystem() {
  // 1. 检查用户设置
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && Object.values(UnitSystem).includes(saved)) {
    return saved;
  }
  
  // 2. 根据浏览器语言推断
  const locale = navigator.language || navigator.userLanguage;
  if (locale) {
    if (locale === 'en-US' || locale === 'en-LR' || locale.startsWith('my')) {
      return UnitSystem.IMPERIAL;
    }
  }
  
  // 3. 尝试通过 API 获取用户国家
  try {
    const response = await fetch('/api/v1/user/preferences');
    if (response.ok) {
      const data = await response.json();
      if (data.unitSystem) {
        return data.unitSystem;
      }
      if (data.country && COUNTRY_UNIT_SYSTEM[data.country]) {
        return COUNTRY_UNIT_SYSTEM[data.country];
      }
    }
  } catch (err) {
    console.warn('[unitSystem] Failed to fetch user preferences:', err);
  }
  
  // 4. 默认公制
  return UnitSystem.METRIC;
}

/**
 * 初始化单位制
 */
export async function initializeUnitSystem() {
  const detected = await detectUnitSystem();
  setUnitSystem(detected);
  return detected;
}

// ─────────────────────────────────────────────────────────────
// 格式化工具
// ─────────────────────────────────────────────────────────────

/**
 * 格式化距离（智能选择单位）
 * @param {number} meters - 距离（米）
 * @param {Object} options - 格式化选项
 * @returns {string} 本地化的距离字符串
 * 
 * @example
 * formatDistance(150)  // 公制: "150 m" | 英制: "492 ft"
 * formatDistance(2500) // 公制: "2.5 km" | 英制: "1.6 mi"
 */
export function formatDistance(meters, options = {}) {
  if (typeof meters !== 'number' || isNaN(meters)) {
    return '-';
  }
  
  const {
    precision = 1,         // 小数位数
    shortForm = false,     // 是否使用简写（km vs 千米）
    locale = getCurrentLocale()
  } = options;
  
  const unitSystem = getCurrentUnitSystem();
  
  if (unitSystem === UnitSystem.IMPERIAL) {
    // 公制 → 英制转换
    const feet = meters * 3.28084;
    const miles = meters * 0.000621371;
    
    if (miles >= 0.1) {
      // 大于 0.1 英里，显示英里
      const formatted = miles.toFixed(precision);
      return shortForm 
        ? `${formatted} mi`
        : `${formatted} ${i18n('unit.mile', { count: miles })}`;
    } else {
      // 小于 0.1 英里，显示英尺
      const formatted = Math.round(feet);
      return shortForm 
        ? `${formatted} ft`
        : `${formatted} ${i18n('unit.foot', { count: feet })}`;
    }
  } else {
    // 公制
    if (meters >= 1000) {
      const km = meters / 1000;
      const formatted = km.toFixed(precision);
      return shortForm 
        ? `${formatted} km`
        : `${formatted} ${i18n('unit.kilometer', { count: km })}`;
    } else {
      const formatted = Math.round(meters);
      return shortForm 
        ? `${formatted} m`
        : `${formatted} ${i18n('unit.meter', { count: meters })}`;
    }
  }
}

/**
 * 格式化速度
 * @param {number} metersPerSecond - 速度（米/秒）
 * @param {Object} options - 格式化选项
 * @returns {string} 本地化的速度字符串
 * 
 * @example
 * formatSpeed(10) // 公制: "36 km/h" | 英制: "22 mph"
 */
export function formatSpeed(metersPerSecond, options = {}) {
  if (typeof metersPerSecond !== 'number' || isNaN(metersPerSecond)) {
    return '-';
  }
  
  const unitSystem = getCurrentUnitSystem();
  const { precision = 0, shortForm = false } = options;
  
  if (unitSystem === UnitSystem.IMPERIAL) {
    const mph = metersPerSecond * 2.23694;
    const formatted = mph.toFixed(precision);
    return shortForm ? `${formatted} mph` : `${formatted} ${i18n('unit.mph')}`;
  } else {
    const kmh = metersPerSecond * 3.6;
    const formatted = kmh.toFixed(precision);
    return shortForm ? `${formatted} km/h` : `${formatted} ${i18n('unit.kmh')}`;
  }
}

/**
 * 格式化温度
 * @param {number} celsius - 温度（摄氏度）
 * @param {Object} options - 格式化选项
 * @returns {string} 本地化的温度字符串
 * 
 * @example
 * formatTemperature(25) // 公制: "25°C" | 英制: "77°F"
 */
export function formatTemperature(celsius, options = {}) {
  if (typeof celsius !== 'number' || isNaN(celsius)) {
    return '-';
  }
  
  const unitSystem = getCurrentUnitSystem();
  const { precision = 0 } = options;
  
  if (unitSystem === UnitSystem.IMPERIAL) {
    const fahrenheit = celsius * 9/5 + 32;
    return `${fahrenheit.toFixed(precision)}°F`;
  } else {
    return `${celsius.toFixed(precision)}°C`;
  }
}

/**
 * 格式化重量
 * @param {number} kilograms - 重量（千克）
 * @param {Object} options - 格式化选项
 * @returns {string} 本地化的重量字符串
 * 
 * @example
 * formatWeight(10) // 公制: "10 kg" | 英制: "22 lb"
 */
export function formatWeight(kilograms, options = {}) {
  if (typeof kilograms !== 'number' || isNaN(kilograms)) {
    return '-';
  }
  
  const unitSystem = getCurrentUnitSystem();
  const { precision = 1, shortForm = false } = options;
  
  if (unitSystem === UnitSystem.IMPERIAL) {
    const pounds = kilograms * 2.20462;
    const formatted = pounds.toFixed(precision);
    return shortForm ? `${formatted} lb` : `${formatted} ${i18n('unit.pound')}`;
  } else {
    const formatted = kilograms.toFixed(precision);
    return shortForm ? `${formatted} kg` : `${formatted} ${i18n('unit.kilogram')}`;
  }
}

/**
 * 格式化面积
 * @param {number} squareMeters - 面积（平方米）
 * @param {Object} options - 格式化选项
 * @returns {string} 本地化的面积字符串
 * 
 * @example
 * formatArea(10000) // 公制: "1.0 ha" | 英制: "2.5 ac"
 */
export function formatArea(squareMeters, options = {}) {
  if (typeof squareMeters !== 'number' || isNaN(squareMeters)) {
    return '-';
  }
  
  const unitSystem = getCurrentUnitSystem();
  const { precision = 1, shortForm = false } = options;
  
  if (unitSystem === UnitSystem.IMPERIAL) {
    const acres = squareMeters * 0.000247105;
    const formatted = acres.toFixed(precision);
    return shortForm ? `${formatted} ac` : `${formatted} ${i18n('unit.acre')}`;
  } else {
    if (squareMeters >= 10000) {
      const hectares = squareMeters / 10000;
      const formatted = hectares.toFixed(precision);
      return shortForm ? `${formatted} ha` : `${formatted} ${i18n('unit.hectare')}`;
    } else {
      const formatted = squareMeters.toFixed(precision);
      return shortForm ? `${formatted} m²` : `${formatted} ${i18n('unit.squareMeter')}`;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 单位转换工具（用于后端 API 对接）
// ─────────────────────────────────────────────────────────────

/**
 * 将用户输入的距离转换为公制（米）
 * @param {number} value - 用户输入的距离值
 * @param {string} unit - 用户输入的单位（'km', 'mi', 'm', 'ft'）
 * @returns {number} 转换后的距离（米）
 */
export function parseDistance(value, unit) {
  const unitSystem = getCurrentUnitSystem();
  
  const conversions = {
    'm': 1,
    'km': 1000,
    'ft': 0.3048,
    'mi': 1609.34
  };
  
  const normalizer = unit.toLowerCase();
  if (!conversions[normalizer]) {
    console.warn('[unitSystem] Unknown distance unit:', unit);
    return value; // 假设已经是米
  }
  
  return value * conversions[normalizer];
}

/**
 * 将距离从公制（米）转换为目标单位制
 * @param {number} meters - 距离（米）
 * @param {string} targetUnitSystem - 目标单位制
 * @returns {Object} { value, unit }
 */
export function convertDistance(meters, targetUnitSystem) {
  if (targetUnitSystem === UnitSystem.IMPERIAL) {
    const miles = meters * 0.000621371;
    const feet = meters * 3.28084;
    
    if (miles >= 0.1) {
      return { value: miles, unit: 'mi' };
    } else {
      return { value: feet, unit: 'ft' };
    }
  } else {
    if (meters >= 1000) {
      return { value: meters / 1000, unit: 'km' };
    } else {
      return { value: meters, unit: 'm' };
    }
  }
}

// 导出默认对象
export default {
  UnitSystem,
  getCurrentUnitSystem,
  setUnitSystem,
  detectUnitSystem,
  initializeUnitSystem,
  formatDistance,
  formatSpeed,
  formatTemperature,
  formatWeight,
  formatArea,
  parseDistance,
  convertDistance
};
