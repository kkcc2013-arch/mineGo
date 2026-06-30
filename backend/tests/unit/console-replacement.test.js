// backend/tests/unit/console-replacement.test.js
/**
 * REQ-00391: console.log 替换单元测试
 */

const fs = require('fs');
const path = require('path');

describe('Console Replacement (REQ-00391)', () => {
  const sharedDir = path.join(__dirname, '../../shared');
  
  test('No console.log/error/warn in backend/shared/*.js', () => {
    const files = fs.readdirSync(sharedDir).filter(f => f.endsWith('.js'));
    const consoleFiles = [];
    
    for (const file of files) {
      const filePath = path.join(sharedDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      
      // 排除 logger.js 本身
      if (file === 'logger.js') continue;
      
      // 检查是否包含 console.log/error/warn
      const hasConsole = /\bconsole\.(log|error|warn)\(/.test(content);
      if (hasConsole) {
        consoleFiles.push(file);
      }
    }
    
    expect(consoleFiles).toEqual([]);
  });
  
  test('Logger import exists in files that previously had console', () => {
    const expectedFiles = [
      'CDNManager.js',
      'RedisPoolManager.js',
      'ImageProcessor.js',
      'ServiceLauncher.js',
      'ageVerification.js',
      'auth.js',
      'businessMetrics.js',
      'contentLocalizer.js',
      'criticalPathTracing.js',
      'db.js',
      'dependencyAnalyzer.js',
      'redis.js',
      'scalingMetrics.js',
      'spawnMetrics.js',
      'timezoneMiddleware.js',
      'tracing.js',
      'tracingMiddleware.js'
    ];
    
    for (const file of expectedFiles) {
      const filePath = path.join(sharedDir, file);
      if (!fs.existsSync(filePath)) continue;
      
      const content = fs.readFileSync(filePath, 'utf-8');
      const hasLogger = content.includes("require('./logger')") || 
                        content.includes('createLogger');
      
      expect(hasLogger).toBe(true);
    }
  });
  
  test('ESLint config has no-console rule', () => {
    const eslintPath = path.join(__dirname, '../../../.eslintrc.json');
    const eslintConfig = JSON.parse(fs.readFileSync(eslintPath, 'utf-8'));
    
    expect(eslintConfig.rules['no-console']).toBeDefined();
    expect(eslintConfig.rules['no-console'][0]).toBe('error');
  });
});
