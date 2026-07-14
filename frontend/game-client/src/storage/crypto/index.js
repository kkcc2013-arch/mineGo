// frontend/game-client/src/storage/crypto/index.js
// Export crypto modules for game-client storage encryption
// REQ-00543: 游戏客户端本地存储数据加密防护系统
'use strict';

export { CryptoService } from './CryptoService.js';
export { KeyManager } from './KeyManager.js';
export { EncryptedStorage } from './EncryptedStorage.js';

/**
 * Usage example:
 * 
 * import { EncryptedStorage } from './storage/crypto/index.js';
 * 
 * // Initialize encrypted storage
 * const storage = new EncryptedStorage();
 * await storage.init();
 * 
 * // Store sensitive data (automatically encrypted)
 * await storage.set('user-token', { token: 'xxx', expiresAt: Date.now() + 3600000 });
 * await storage.set('game-progress', { level: 42, badges: ['earth', 'fire'] });
 * 
 * // Retrieve data (automatically decrypted)
 * const token = await storage.get('user-token');
 * const progress = await storage.get('game-progress');
 * 
 * // Get storage stats
 * const stats = await storage.getStats();
 * console.log('Encrypted keys:', stats.encryptedKeys);
 */
