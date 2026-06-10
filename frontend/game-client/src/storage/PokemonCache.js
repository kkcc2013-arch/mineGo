// frontend/game-client/src/storage/PokemonCache.js
// Cached Pokemon storage with expiration support
'use strict';

/**
 * PokemonCache - Manages cached Pokemon data in IndexedDB
 * Provides CRUD operations with automatic expiration
 */
export class PokemonCache {
  /**
   * @param {import('./PersistedStore').PersistedStore} persistedStore 
   */
  constructor(persistedStore) {
    this.persistedStore = persistedStore;
    this.maxAge = 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Ensure store is initialized
   */
  async ensureInitialized() {
    await this.persistedStore.init();
  }

  /**
   * Cache a single Pokemon
   * @param {object} pokemon 
   * @returns {Promise<void>}
   */
  async cachePokemon(pokemon) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('pokemon', 'readwrite');
      const store = tx.objectStore('pokemon');

      const record = {
        ...pokemon,
        updatedAt: Date.now()
      };

      store.put(record);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Cache multiple Pokemon at once
   * @param {object[]} pokemonList 
   * @returns {Promise<void>}
   */
  async cachePokemonList(pokemonList) {
    if (!pokemonList || pokemonList.length === 0) return;

    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('pokemon', 'readwrite');
      const store = tx.objectStore('pokemon');
      const now = Date.now();

      for (const pokemon of pokemonList) {
        store.put({ ...pokemon, updatedAt: now });
      }

      tx.oncomplete = () => {
        console.log(`[PokemonCache] Cached ${pokemonList.length} Pokemon`);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get all cached Pokemon (valid only)
   * @returns {Promise<object[]>}
   */
  async getCachedPokemon() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('pokemon', 'readonly');
      const store = tx.objectStore('pokemon');
      const request = store.getAll();

      request.onsuccess = () => {
        const now = Date.now();
        const valid = request.result.filter(p =>
          now - p.updatedAt < this.maxAge
        );
        resolve(valid);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get a single Pokemon by ID
   * @param {string} id 
   * @returns {Promise<object|null>}
   */
  async getPokemon(id) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('pokemon', 'readonly');
      const store = tx.objectStore('pokemon');
      const request = store.get(id);

      request.onsuccess = () => {
        const pokemon = request.result;
        if (!pokemon) {
          resolve(null);
          return;
        }

        // Check expiration
        const now = Date.now();
        if (now - pokemon.updatedAt > this.maxAge) {
          resolve(null);
        } else {
          resolve(pokemon);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get Pokemon by species ID
   * @param {number} speciesId 
   * @returns {Promise<object[]>}
   */
  async getPokemonBySpecies(speciesId) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('pokemon', 'readonly');
      const store = tx.objectStore('pokemon');
      const index = store.index('speciesId');
      const request = index.getAll(speciesId);

      request.onsuccess = () => {
        const now = Date.now();
        const valid = request.result.filter(p =>
          now - p.updatedAt < this.maxAge
        );
        resolve(valid);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete a cached Pokemon
   * @param {string} id 
   * @returns {Promise<void>}
   */
  async deletePokemon(id) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('pokemon', 'readwrite');
      const store = tx.objectStore('pokemon');
      store.delete(id);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clean expired Pokemon from cache
   * @returns {Promise<number>} Number of deleted records
   */
  async cleanExpired() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('pokemon', 'readwrite');
      const store = tx.objectStore('pokemon');
      const index = store.index('updatedAt');

      const cutoff = Date.now() - this.maxAge;
      const range = IDBKeyRange.upperBound(cutoff);
      let deletedCount = 0;

      const request = index.openCursor(range);

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          deletedCount++;
          cursor.continue();
        } else {
          console.log(`[PokemonCache] Cleaned ${deletedCount} expired Pokemon`);
          resolve(deletedCount);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get cache statistics
   * @returns {Promise<{total: number, valid: number, expired: number}>}
   */
  async getStats() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('pokemon', 'readonly');
      const store = tx.objectStore('pokemon');
      const request = store.getAll();

      request.onsuccess = () => {
        const now = Date.now();
        const total = request.result.length;
        const valid = request.result.filter(p => now - p.updatedAt < this.maxAge).length;

        resolve({
          total,
          valid,
          expired: total - valid
        });
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all cached Pokemon
   * @returns {Promise<void>}
   */
  async clear() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('pokemon', 'readwrite');
      const store = tx.objectStore('pokemon');
      store.clear();

      tx.oncomplete = () => {
        console.log('[PokemonCache] Cache cleared');
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Update max age for cache entries
   * @param {number} maxAgeMs 
   */
  setMaxAge(maxAgeMs) {
    this.maxAge = maxAgeMs;
  }
}
