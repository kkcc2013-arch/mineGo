'use strict';

const CoverageBadgeGenerator = require('./CoverageBadgeGenerator');
const { expect } = require('@jest/globals');

describe('CoverageBadgeGenerator', () => {
  let generator;

  beforeEach(() => {
    generator = new CoverageBadgeGenerator();
  });

  describe('getColor', () => {
    it('should return brightgreen for high coverage', () => {
      expect(generator.getColor(95)).toBe('brightgreen');
      expect(generator.getColor(90)).toBe('brightgreen');
    });

    it('should return green for good coverage', () => {
      expect(generator.getColor(85)).toBe('green');
      expect(generator.getColor(80)).toBe('green');
    });

    it('should return yellowgreen for acceptable coverage', () => {
      expect(generator.getColor(75)).toBe('yellowgreen');
      expect(generator.getColor(70)).toBe('yellowgreen');
    });

    it('should return yellow for moderate coverage', () => {
      expect(generator.getColor(65)).toBe('yellow');
      expect(generator.getColor(60)).toBe('yellow');
    });

    it('should return orange for low coverage', () => {
      expect(generator.getColor(55)).toBe('orange');
      expect(generator.getColor(50)).toBe('orange');
    });

    it('should return red for very low coverage', () => {
      expect(generator.getColor(40)).toBe('red');
      expect(generator.getColor(20)).toBe('red');
    });
  });

  describe('generateUrl', () => {
    it('should generate shields.io URL', () => {
      const url = generator.generateUrl(65);
      expect(url).toContain('shields.io');
      expect(url).toContain('65%');
    });

    it('should encode label correctly', () => {
      const url = generator.generateUrl(80, 'test-coverage');
      expect(url).toContain('test-coverage');
    });
  });

  describe('generateJsonBadge', () => {
    it('should generate Shields.io JSON format', () => {
      const badge = generator.generateJsonBadge(65);
      expect(badge.schemaVersion).toBe(1);
      expect(badge.label).toBe('coverage');
      expect(badge.message).toBe('65%');
      expect(badge.color).toBe('yellow');
    });

    it('should support custom label', () => {
      const badge = generator.generateJsonBadge(80, 'tests');
      expect(badge.label).toBe('tests');
    });
  });

  describe('generateSVG', () => {
    it('should generate valid SVG', () => {
      const svg = generator.generateSVG(65);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('height="20"');
    });

    it('should include coverage percentage', () => {
      const svg = generator.generateSVG(65);
      expect(svg).toContain('65');
    });

    it('should use correct color', () => {
      const svg = generator.generateSVG(90);
      expect(svg).toContain('#4c1'); // brightgreen color
    });
  });

  describe('generateMarkdown', () => {
    it('should generate markdown badge code', () => {
      const markdown = generator.generateMarkdown(65);
      expect(markdown).toContain('[![coverage]');
      expect(markdown).toContain('shields.io');
    });
  });

  describe('generateHtml', () => {
    it('should generate HTML img tag', () => {
      const html = generator.generateHtml(65);
      expect(html).toContain('<img');
      expect(html).toContain('alt="coverage"');
    });
  });

  describe('generateMultiServiceBadge', () => {
    it('should generate badges for multiple services', () => {
      const coverageData = {
        total: { lines: 70 },
        services: {
          'user-service': { lines: 75 },
          'payment-service': { lines: 85 }
        }
      };

      const badges = generator.generateMultiServiceBadge(coverageData);

      expect(badges.total).toBeDefined();
      expect(badges['user-service']).toBeDefined();
      expect(badges['payment-service']).toBeDefined();
    });
  });
});

describe('CoverageBadgeGenerator Integration', () => {
  it('should generate all badge formats', () => {
    const generator = new CoverageBadgeGenerator();

    const coverage = 75;
    const jsonBadge = generator.generateJsonBadge(coverage);
    const url = generator.generateUrl(coverage);
    const svg = generator.generateSVG(coverage);
    const markdown = generator.generateMarkdown(coverage);

    expect(jsonBadge.color).toBe('yellowgreen');
    expect(url).toContain('75%');
    expect(svg).toContain('75');
    expect(markdown).toContain('[![coverage]');
  });
});