#!/usr/bin/env node
/**
 * 循环依赖检查脚本
 * 用于 CI/CD 流程中，发现循环依赖时构建失败
 */

const { DependencyAnalyzer } = require('../shared/dependencyAnalyzer');

async function checkCycles() {
  console.log('[Cycle Check] Analyzing dependencies...\n');
  
  const analyzer = new DependencyAnalyzer();
  const result = await analyzer.analyzeAll();
  
  console.log(`[Cycle Check] Total services: ${result.services.length}`);
  console.log(`[Cycle Check] Total dependencies: ${result.dependencies.length}`);
  console.log(`[Cycle Check] Cycles detected: ${result.cycles.length}\n`);
  
  if (result.cycles.length > 0) {
    console.error('❌ CYCLIC DEPENDENCIES DETECTED:\n');
    
    result.cycles.forEach((cycle, i) => {
      console.error(`  ${i + 1}. ${cycle.join(' → ')}`);
    });
    
    console.error('\n⚠️  Circular dependencies may cause:');
    console.error('  - Cascading failures');
    console.error('  - Startup order issues');
    console.error('  - Infinite loops in request chains');
    console.error('\n💡 Recommendation: Refactor to break the cycle using:');
    console.error('  - Event-driven architecture');
    console.error('  - Shared modules');
    console.error('  - Service merging');
    
    process.exit(1);
  } else {
    console.log('✅ No circular dependencies detected\n');
    
    console.log('📋 Service startup order:');
    result.startupOrder.forEach((service, i) => {
      console.log(`  ${i + 1}. ${service}`);
    });
    
    console.log('\n✨ All dependencies are healthy!');
    process.exit(0);
  }
}

checkCycles().catch(err => {
  console.error('[Cycle Check] Error:', err);
  process.exit(1);
});
