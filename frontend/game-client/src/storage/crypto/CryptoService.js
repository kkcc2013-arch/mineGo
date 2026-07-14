// frontend/game-client/src/storage/crypto/CryptoService.js
// AES-256-GCM encryption service for client-side data protection
// REQ-00543: 游戏客户端本地存储数据加密防护系统
'use strict';

/**
 * CryptoService - AES-256-GCM encryption/decryption for client storage
 * 
 * Features:
 * - AES-256-GCM for authenticated encryption (confidentiality + integrity)
 * - PBKDF2 for key derivation from device secret
 * - Random IV for each encryption operation
 * - Version header for format evolution
 */
export class CryptoService {
  static ALGORITHM = 'AES-GCM';
  static KEY_LENGTH = 256;
  static IV_LENGTH = 12;  // 96 bits recommended for GCM
  static SALT_LENGTH = 16;
  static TAG_LENGTH = 128; // bits
  static VERSION = 1;
  static VERSION_PREFIX = 'mg1'; // minego encrypted v1

  /**
   * @param {Crypto} crypto - Web Crypto API instance (window.crypto.subtle)
   */
  constructor(crypto = window?.crypto?.subtle) {
    if (!crypto) {
      throw new Error('[CryptoService] Web Crypto API not available');
    }
    this.crypto = crypto;
    this.keyCache = new Map(); // Cache derived keys
  }

  /**
   * Derive encryption key from password using PBKDF2
   * @param {string} password - Device secret password
   * @param {Uint8Array} salt - Salt for key derivation
   * @returns {Promise<CryptoKey>}
   */
  async deriveKey(password, salt) {
    const cacheKey = `${password}_${this.arrayToBase64(salt)}`;
    
    if (this.keyCache.has(cacheKey)) {
      return this.keyCache.get(cacheKey);
    }

    // Import password as raw key material
    const passwordKey = await this.crypto.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );

    // Derive AES-256 key using PBKDF2
    const key = await this.crypto.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      passwordKey,
      {
        name: CryptoService.ALGORITHM,
        length: CryptoService.KEY_LENGTH
      },
      false, // not extractable
      ['encrypt', 'decrypt']
    );

    this.keyCache.set(cacheKey, key);
    return key;
  }

  /**
   * Encrypt data using AES-256-GCM
   * @param {any} data - Data to encrypt (will be JSON stringified)
   * @param {string} password - Device secret
   * @returns {Promise<string>} - Base64 encoded encrypted data with version prefix
   */
  async encrypt(data, password) {
    // Generate random salt and IV
    const salt = this.generateRandomBytes(CryptoService.SALT_LENGTH);
    const iv = this.generateRandomBytes(CryptoService.IV_LENGTH);

    // Derive key from password
    const key = await this.deriveKey(password, salt);

    // Encode data
    const plaintext = new TextEncoder().encode(JSON.stringify(data));

    // Encrypt
    const ciphertext = await this.crypto.encrypt(
      {
        name: CryptoService.ALGORITHM,
        iv: iv,
        tagLength: CryptoService.TAG_LENGTH
      },
      key,
      plaintext
    );

    // Combine: version + salt + iv + ciphertext
    const combined = new Uint8Array(
      3 + // version prefix
      salt.length +
      iv.length +
      ciphertext.byteLength
    );

    const versionBytes = new TextEncoder().encode(CryptoService.VERSION_PREFIX);
    combined.set(versionBytes, 0);
    combined.set(salt, 3);
    combined.set(iv, 3 + salt.length);
    combined.set(new Uint8Array(ciphertext), 3 + salt.length + iv.length);

    return this.arrayToBase64(combined);
  }

  /**
   * Decrypt data using AES-256-GCM
   * @param {string} encryptedData - Base64 encoded encrypted data
   * @param {string} password - Device secret
   * @returns {Promise<any>} - Decrypted and parsed data
   */
  async decrypt(encryptedData, password) {
    // Decode base64
    const combined = this.base64ToArray(encryptedData);

    // Extract version
    const versionBytes = combined.slice(0, 3);
    const version = new TextDecoder().decode(versionBytes);

    if (version !== CryptoService.VERSION_PREFIX) {
      throw new Error(`[CryptoService] Unsupported version: ${version}`);
    }

    // Extract salt, iv, ciphertext
    let offset = 3;
    const salt = combined.slice(offset, offset + CryptoService.SALT_LENGTH);
    offset += CryptoService.SALT_LENGTH;

    const iv = combined.slice(offset, offset + CryptoService.IV_LENGTH);
    offset += CryptoService.IV_LENGTH;

    const ciphertext = combined.slice(offset);

    // Derive key
    const key = await this.deriveKey(password, salt);

    // Decrypt
    const plaintext = await this.crypto.decrypt(
      {
        name: CryptoService.ALGORITHM,
        iv: iv,
        tagLength: CryptoService.TAG_LENGTH
      },
      key,
      ciphertext
    );

    // Parse and return
    const text = new TextDecoder().decode(plaintext);
    return JSON.parse(text);
  }

  /**
   * Check if data is encrypted (has version prefix)
   * @param {string} data - Data to check
   * @returns {boolean}
   */
  isEncrypted(data) {
    if (typeof data !== 'string') return false;
    try {
      const decoded = this.base64ToArray(data);
      const version = new TextDecoder().decode(decoded.slice(0, 3));
      return version === CryptoService.VERSION_PREFIX;
    } catch {
      return false;
    }
  }

  /**
   * Generate cryptographically secure random bytes
   * @param {number} length 
   * @returns {Uint8Array}
   */
  generateRandomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  /**
   * Convert Uint8Array to Base64 string
   * @param {Uint8Array} array 
   * @returns {string}
   */
  arrayToBase64(array) {
    let binary = '';
    for (let i = 0; i < array.length; i++) {
      binary += String.fromCharCode(array[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert Base64 string to Uint8Array
   * @param {string} base64 
   * @returns {Uint8Array}
   */
  base64ToArray(base64) {
    const binary = atob(base64);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      array[i] = binary.charCodeAt(i);
    }
    return array;
  }

  /**
   * Clear key cache (for security)
   */
  clearCache() {
    this.keyCache.clear();
  }
}

export default CryptoService;
