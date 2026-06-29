// frontend/game-client/src/components/FormattedNumber.js
// React-like component for formatted number display
'use strict';

import NumberFormatter from '../utils/numberFormat.js';

/**
 * FormattedNumber Component
 * Unified number display component for game UI
 * 
 * Usage examples:
 * <FormattedNumber value={123456} type="number" compact />
 * <FormattedNumber value={5000} type="currency" currency="gold" />
 * <FormattedNumber value={0.456} type="percent" />
 * <FormattedNumber value={10000} type="gameValue" valueType="power" />
 */
class FormattedNumber {
  constructor(options = {}) {
    this.value = options.value ?? 0;
    this.type = options.type || 'number';
    this.locale = options.locale || null;
    this.compact = options.compact ?? false;
    this.precision = options.precision;
    this.currency = options.currency || 'gold';
    this.valueType = options.valueType || 'power';
    this.normalize = options.normalize ?? true;
    this.className = options.className || '';
    this.id = options.id || '';
    this.onClick = options.onClick || null;
  }

  /**
   * Render formatted number as HTML string
   */
  render() {
    let formatted;
    
    switch (this.type) {
      case 'currency':
        formatted = NumberFormatter.formatCurrency(this.value, this.currency, this.locale, {
          compact: this.compact,
          precision: this.precision
        });
        break;
      
      case 'percent':
        formatted = NumberFormatter.formatPercent(this.value, this.locale, {
          precision: this.precision,
          normalize: this.normalize
        });
        break;
      
      case 'gameValue':
        formatted = NumberFormatter.formatGameValue(this.value, this.valueType, this.locale, {
          precision: this.precision
        });
        break;
      
      case 'compact':
        formatted = NumberFormatter.formatCompact(this.value, this.locale, {
          precision: this.precision
        });
        break;
      
      case 'distance':
        formatted = NumberFormatter.formatDistance(this.value, this.locale, {
          precision: this.precision
        });
        break;
      
      case 'duration':
        formatted = NumberFormatter.formatDuration(this.value, this.locale);
        break;
      
      case 'countdown':
        formatted = NumberFormatter.formatCountdown(this.value, this.locale, {
          showHours: this.showHours
        });
        break;
      
      case 'level':
        formatted = NumberFormatter.formatLevel(this.value, this.locale);
        break;
      
      case 'damage':
        formatted = NumberFormatter.formatDamage(this.value, this.locale, {
          precision: this.precision
        });
        break;
      
      case 'hp':
        formatted = NumberFormatter.formatHP(this.value, this.locale, {
          precision: this.precision
        });
        break;
      
      case 'exp':
        formatted = NumberFormatter.formatExp(this.value, this.locale, {
          precision: this.precision
        });
        break;
      
      case 'power':
        formatted = NumberFormatter.formatPower(this.value, this.locale, {
          precision: this.precision
        });
        break;
      
      case 'catchRate':
        formatted = NumberFormatter.formatCatchRate(this.value, this.locale);
        break;
      
      default:
        formatted = NumberFormatter.formatNumber(this.value, this.locale, {
          compact: this.compact,
          precision: this.precision
        });
    }
    
    // Build HTML element
    const attrs = [];
    if (this.className) attrs.push(`class="${this.className}"`);
    if (this.id) attrs.push(`id="${this.id}"`);
    
    let html = `<span data-formatted-number="${this.type}" ${attrs.join(' ')}>${formatted}</span>`;
    
    return html;
  }

  /**
   * Create element and attach event handlers
   */
  createElement() {
    const span = document.createElement('span');
    span.setAttribute('data-formatted-number', this.type);
    if (this.className) span.className = this.className;
    if (this.id) span.id = this.id;
    
    span.textContent = this.format();
    
    if (this.onClick) {
      span.addEventListener('click', this.onClick);
    }
    
    return span;
  }

  /**
   * Get formatted string (without HTML wrapper)
   */
  format() {
    let formatted;
    
    switch (this.type) {
      case 'currency':
        formatted = NumberFormatter.formatCurrency(this.value, this.currency, this.locale, {
          compact: this.compact,
          precision: this.precision
        });
        break;
      
      case 'percent':
        formatted = NumberFormatter.formatPercent(this.value, this.locale, {
          precision: this.precision,
          normalize: this.normalize
        });
        break;
      
      case 'gameValue':
        formatted = NumberFormatter.formatGameValue(this.value, this.valueType, this.locale, {
          precision: this.precision
        });
        break;
      
      case 'compact':
        formatted = NumberFormatter.formatCompact(this.value, this.locale, {
          precision: this.precision
        });
        break;
      
      case 'distance':
        formatted = NumberFormatter.formatDistance(this.value, this.locale);
        break;
      
      case 'duration':
        formatted = NumberFormatter.formatDuration(this.value, this.locale);
        break;
      
      case 'countdown':
        formatted = NumberFormatter.formatCountdown(this.value, this.locale);
        break;
      
      default:
        formatted = NumberFormatter.formatNumber(this.value, this.locale, {
          compact: this.compact,
          precision: this.precision
        });
    }
    
    return formatted;
  }

  /**
   * Update value and re-render
   */
  updateValue(newValue) {
    this.value = newValue;
    return this.render();
  }
}

/**
 * Helper functions for quick formatting without creating component
 */
const FormattedNumberHelpers = {
  /**
   * Quick format number with compact option
   */
  quick(value, type = 'number', options = {}) {
    const formatter = new FormattedNumber({ value, type, ...options });
    return formatter.format();
  },

  /**
   * Format and return HTML string
   */
  html(value, type = 'number', options = {}) {
    const formatter = new FormattedNumber({ value, type, ...options });
    return formatter.render();
  },

  /**
   * Format gold currency
   */
  gold(value, compact = true, locale = null) {
    return NumberFormatter.formatCurrency(value, 'gold', locale, { compact });
  },

  /**
   * Format gems currency
   */
  gems(value, compact = true, locale = null) {
    return NumberFormatter.formatCurrency(value, 'gems', locale, { compact });
  },

  /**
   * Format diamonds currency
   */
  diamonds(value, compact = true, locale = null) {
    return NumberFormatter.formatCurrency(value, 'diamonds', locale, { compact });
  },

  /**
   * Format power/combat power
   */
  power(value, locale = null) {
    return NumberFormatter.formatPower(value, locale);
  },

  /**
   * Format level
   */
  level(level, locale = null) {
    return NumberFormatter.formatLevel(level, locale);
  },

  /**
   * Format catch rate (probability to percentage)
   */
  catchRate(rate, locale = null) {
    return NumberFormatter.formatCatchRate(rate, locale);
  },

  /**
   * Format distance
   */
  distance(meters, locale = null) {
    return NumberFormatter.formatDistance(meters, locale);
  },

  /**
   * Format duration
   */
  duration(seconds, locale = null) {
    return NumberFormatter.formatDuration(seconds, locale);
  },

  /**
   * Format countdown timer
   */
  countdown(seconds, locale = null, showHours = false) {
    return NumberFormatter.formatCountdown(seconds, locale, { showHours });
  },

  /**
   * Compact large number
   */
  compact(value, locale = null) {
    return NumberFormatter.formatCompact(value, locale);
  }
};

/**
 * Vue/React-like integration helpers
 */
const FormattedNumberVue = {
  /**
   * Vue directive: v-formatted-number
   * Usage: <span v-formatted-number="{ value: userGold, type: 'currency', currency: 'gold' }"></span>
   */
  directive: {
    bind(el, binding) {
      const { value, type = 'number', currency = 'gold', compact = true, precision, valueType } = binding.value || {};
      const options = { value, type, currency, compact, precision, valueType };
      const formatter = new FormattedNumber(options);
      el.textContent = formatter.format();
    },
    
    update(el, binding) {
      const { value, type = 'number', currency = 'gold', compact = true, precision, valueType } = binding.value || {};
      const options = { value, type, currency, compact, precision, valueType };
      const formatter = new FormattedNumber(options);
      el.textContent = formatter.format();
    }
  }
};

// Export for module usage
export { FormattedNumber, FormattedNumberHelpers, FormattedNumberVue };
export default FormattedNumber;