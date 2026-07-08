'use strict';

/**
 * 覆盖率 Badge 生成器
 * 生成 Shields.io 格式的覆盖率徽章
 */
class CoverageBadgeGenerator {
  constructor(options = {}) {
    this.defaultColor = 'gray';
    this.colorRanges = [
      { min: 90, color: 'brightgreen' },
      { min: 80, color: 'green' },
      { min: 70, color: 'yellowgreen' },
      { min: 60, color: 'yellow' },
      { min: 50, color: 'orange' },
      { min: 0, color: 'red' }
    ];
  }

  /**
   * 根据 coverage 值确定颜色
   */
  getColor(coverage) {
    for (const range of this.colorRanges) {
      if (coverage >= range.min) {
        return range.color;
      }
    }
    return this.defaultColor;
  }

  /**
   * 生成 SVG Badge
   */
  generateSVG(coverage, label = 'coverage') {
    const roundedCoverage = Math.round(coverage * 10) / 10;
    const color = this.getColor(roundedCoverage);
    const message = `${roundedCoverage}%`;

    return this.createSVG(label, message, color);
  }

  /**
   * 创建 SVG 内容
   */
  createSVG(label, message, color) {
    const labelWidth = label.length * 6 + 10;
    const messageWidth = message.length * 6 + 10;
    const totalWidth = labelWidth + messageWidth;

    const colorMap = {
      brightgreen: '#4c1',
      green: '#97CA00',
      yellowgreen: '#a4a61d',
      yellow: '#dfb317',
      orange: '#fe7d37',
      red: '#e05d44',
      gray: '#555'
    };

    const bgColor = colorMap[color] || colorMap.gray;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
  <linearGradient id="a" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".7"/>
    <stop offset=".1" stop-color="#aaa" stop-opacity=".1"/>
    <stop offset=".9" stop-color="#000" stop-opacity=".3"/>
    <stop offset="1" stop-color="#000" stop-opacity=".5"/>
  </linearGradient>
  <rect rx="3" width="${totalWidth}" height="20" fill="#555"/>
  <rect rx="3" x="${labelWidth}" width="${messageWidth}" height="20" fill="${bgColor}"/>
  <rect rx="3" width="${totalWidth}" height="20" fill="url(#a)"/>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2 + 1}" y="15">${label}</text>
    <text x="${labelWidth + messageWidth / 2 - 1}" y="15">${message}</text>
  </g>
</svg>`;
  }

  /**
   * 生成 Shields.io URL
   */
  generateUrl(coverage, label = 'coverage') {
    const color = this.getColor(coverage);
    const encodedLabel = encodeURIComponent(label);
    const encodedMessage = encodeURIComponent(`${Math.round(coverage)}%`);
    
    return `https://img.shields.io/badge/${encodedLabel}-${encodedMessage}-${color}`;
  }

  /**
   * 生成 JSON Badge（Shields.io 格式）
   */
  generateJsonBadge(coverage, label = 'coverage') {
    const color = this.getColor(coverage);
    
    return {
      schemaVersion: 1,
      label,
      message: `${Math.round(coverage)}%`,
      color
    };
  }

  /**
   * 生成多服务 Badge 组合
   */
  generateMultiServiceBadge(coverageData) {
    const badges = {};

    // 总覆盖率
    if (coverageData.total) {
      badges.total = this.generateJsonBadge(coverageData.total.lines, 'coverage');
    }

    // 各服务覆盖率
    if (coverageData.services) {
      for (const [service, data] of Object.entries(coverageData.services)) {
        if (!data.error) {
          badges[service] = this.generateJsonBadge(data.lines, service);
        }
      }
    }

    return badges;
  }

  /**
   * 生成 Markdown Badge 代码
   */
  generateMarkdown(coverage, label = 'coverage') {
    const url = this.generateUrl(coverage, label);
    return `[![${label}](${url})](https://github.com/kkcc2013-arch/mineGo/blob/main/docs/STATUS.md)`;
  }

  /**
   * 生成 HTML Badge 代码
   */
  generateHtml(coverage, label = 'coverage') {
    const url = this.generateUrl(coverage, label);
    return `<img alt="${label}" src="${url}">`;
  }
}

module.exports = CoverageBadgeGenerator;