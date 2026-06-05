#!/usr/bin/env node
// scripts/validate-i18n.js
// Validates translation files for completeness and consistency
'use strict';

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'frontend', 'game-client', 'src', 'i18n', 'locales');
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];
const BASE_LANGUAGE = 'zh-CN';

function getAllKeys(obj, prefix = '') {
  const keys = [];
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      keys.push(...getAllKeys(obj[key], fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function validateTranslations() {
  console.log('🔍 Validating i18n translations...\n');
  
  let hasErrors = false;
  const baseFile = path.join(LOCALES_DIR, `${BASE_LANGUAGE}.json`);
  
  if (!fs.existsSync(baseFile)) {
    console.error(`❌ Base language file not found: ${baseFile}`);
    process.exit(1);
  }
  
  const baseContent = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  const baseKeys = getAllKeys(baseContent);
  
  console.log(`📋 Base language (${BASE_LANGUAGE}): ${baseKeys.length} translation keys\n`);
  
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang === BASE_LANGUAGE) continue;
    
    const langFile = path.join(LOCALES_DIR, `${lang}.json`);
    
    if (!fs.existsSync(langFile)) {
      console.error(`❌ Missing translation file: ${langFile}`);
      hasErrors = true;
      continue;
    }
    
    try {
      const langContent = JSON.parse(fs.readFileSync(langFile, 'utf8'));
      const langKeys = getAllKeys(langContent);
      
      // Find missing keys
      const missing = baseKeys.filter(k => !langKeys.includes(k));
      // Find extra keys
      const extra = langKeys.filter(k => !baseKeys.includes(k));
      
      console.log(`📊 ${lang}:`);
      console.log(`   Total keys: ${langKeys.length}`);
      
      if (missing.length > 0) {
        console.error(`   ❌ Missing ${missing.length} keys:`);
        missing.slice(0, 10).forEach(k => console.error(`      - ${k}`));
        if (missing.length > 10) console.error(`      ... and ${missing.length - 10} more`);
        hasErrors = true;
      }
      
      if (extra.length > 0) {
        console.warn(`   ⚠️  Extra ${extra.length} keys (not in base):`);
        extra.slice(0, 5).forEach(k => console.warn(`      - ${k}`));
      }
      
      if (missing.length === 0 && extra.length === 0) {
        console.log(`   ✅ All translations complete`);
      }
      console.log('');
      
    } catch (err) {
      console.error(`❌ Failed to parse ${langFile}: ${err.message}`);
      hasErrors = true;
    }
  }
  
  // Check for empty translations
  console.log('🔍 Checking for empty translations...\n');
  for (const lang of SUPPORTED_LANGUAGES) {
    const langFile = path.join(LOCALES_DIR, `${lang}.json`);
    if (!fs.existsSync(langFile)) continue;
    
    const content = JSON.parse(fs.readFileSync(langFile, 'utf8'));
    const keys = getAllKeys(content);
    
    const emptyKeys = keys.filter(key => {
      const parts = key.split('.');
      let val = content;
      for (const part of parts) {
        val = val?.[part];
      }
      return !val || val.trim() === '';
    });
    
    if (emptyKeys.length > 0) {
      console.warn(`⚠️  ${lang}: ${emptyKeys.length} empty translations`);
      emptyKeys.slice(0, 5).forEach(k => console.warn(`   - ${k}`));
    }
  }
  
  console.log('');
  if (hasErrors) {
    console.error('❌ Translation validation failed!');
    process.exit(1);
  } else {
    console.log('✅ All translations are valid and complete!');
    process.exit(0);
  }
}

// Run validation
validateTranslations();
