#!/usr/bin/env node
'use strict';
/**
 * Contract Compatibility Checker
 * 检查契约变更的兼容性
 */

const fs = require('fs');
const path = require('path');
const ContractRegistry = require('../../shared/contract/ContractRegistry');

// 加载契约
const userContract = require('../../services/user-service/contracts/user.contract');
const pokemonContract = require('../../services/pokemon-service/contracts/pokemon.contract');
const socialContract = require('../../services/social-service/contracts/social.contract');

async function checkCompatibility() {
  const args = process.argv.slice(2);
  const registry = new ContractRegistry();
  
  console.log('='.repeat(60));
  console.log('API Contract Compatibility Check');
  console.log('='.repeat(60) + '\n');

  // 注册当前契约
  registry.registerProvider('user-service', userContract);
  registry.registerProvider('pokemon-service', pokemonContract);
  registry.registerProvider('social-service', socialContract);

  // 加载历史版本（如果存在）
  const historyPath = path.join(__dirname, 'contract-history.json');
  let hasBreakingChanges = false;

  try {
    if (fs.existsSync(historyPath)) {
      const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      
      for (const [serviceName, oldContract] of Object.entries(history)) {
        console.log(`\nChecking ${serviceName}...`);
        
        const currentContract = registry.getProvider(serviceName);
        if (currentContract) {
          const result = registry.checkCompatibility(serviceName, currentContract);
          
          if (!result.compatible) {
            hasBreakingChanges = true;
            console.log(`  ❌ Breaking changes detected:`);
            
            for (const change of result.breakingChanges) {
              console.log(`    - ${change.type}: ${change.message || change.endpoint || ''}`);
            }
          } else {
            console.log(`  ✅ Compatible`);
            
            if (result.nonBreakingChanges.length > 0) {
              console.log(`  ℹ️ Non-breaking changes:`);
              for (const change of result.nonBreakingChanges) {
                console.log(`    - ${change.type}: ${change.message || change.endpoint || ''}`);
              }
            }
          }
        }
      }
    } else {
      console.log('No contract history found. First run - skipping compatibility check.');
      console.log('Future runs will compare against this baseline.');
      
      // 保存当前契约作为基线
      const history = {
        'user-service': userContract.toJSON(),
        'pokemon-service': pokemonContract.toJSON(),
        'social-service': socialContract.toJSON()
      };
      
      fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
      console.log('\nBaseline saved to:', historyPath);
    }
  } catch (error) {
    console.error('Error checking compatibility:', error.message);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  
  if (hasBreakingChanges) {
    console.log('❌ Breaking changes detected!');
    console.log('Please review the changes and update consumers accordingly.');
    process.exit(1);
  } else {
    console.log('✅ All changes are backward compatible.');
    process.exit(0);
  }
}

checkCompatibility();
