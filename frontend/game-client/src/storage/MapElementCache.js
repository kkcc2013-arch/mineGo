// frontend/game-client/src/storage/MapElementCache.js
// Cache for map elements (wild Pokemon, Pokestops, Gyms)
'use strict';

/**
 * MapElementCache - Manages cached map elements in IndexedDB
 * Handles wild Pokemon, Pokestops, and Gyms with expiration
 */
export class MapElementCache {
  /**
   * @param {import('./PersistedStore').PersistedStore} persistedStore 
   */
  constructor(persistedStore) {
    this.persistedStore = persistedStore;
    this.maxAge = 5 * 60 * 1000; // 5 minutes (wild pokemon expire quickly)
  }

  /**
   * Ensure store is initialized
   */
  async ensureInitialized() {
    await this.persistedStore.init();
  }

  // ── Wild Pokemon ────────────────────────────────────────

  /**
   * Cache wild Pokemon
   * @param {object[]} wildPokemon 
   * @returns {Promise<void>}
   */
  async cacheWildPokemon(wildPokemon) {
    if (!wildPokemon || wildPokemon.length === 0) return;

    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('mapElements', 'readwrite');
      const store = tx.objectStore('mapElements');
      const now = Date.now();

      for (const pokemon of wildPokemon) {
        store.put({
          id: pokemon.id,
          type: 'wild',
          data: pokemon,
          expiresAt: pokemon.expiresAt || (now + this.maxAge),
          updatedAt: now
        });
      }

      tx.oncomplete = () => {
        console.log(`[MapElementCache] Cached ${wildPokemon.length} wild Pokemon`);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get cached wild Pokemon
   * @returns {Promise<object[]>}
   */
  async getWildPokemon() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('mapElements', 'readonly');
      const store = tx.objectStore('mapElements');
      const index = store.index('type');
      const request = index.getAll('wild');

      request.onsuccess = () => {
        const now = Date.now();
        const valid = request.result
          .filter(item => !item.expiresAt || item.expiresAt > now)
          .map(item => item.data);
        resolve(valid);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // ── Pokestops ───────────────────────────────────────────

  /**
   * Cache Pokestops
   * @param {object[]} pokestops 
   * @returns {Promise<void>}
   */
  async cachePokestops(pokestops) {
    if (!pokestops || pokestops.length === 0) return;

    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('mapElements', 'readwrite');
      const store = tx.objectStore('mapElements');
      const now = Date.now();
      const pokestopMaxAge = 30 * 60 * 1000; // 30 minutes for pokestops

      for (const pokestop of pokestops) {
        store.put({
          id: pokestop.id,
          type: 'pokestop',
          data: pokestop,
          expiresAt: now + pokestopMaxAge,
          updatedAt: now
        });
      }

      tx.oncomplete = () => {
        console.log(`[MapElementCache] Cached ${pokestops.length} Pokestops`);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get cached Pokestops
   * @returns {Promise<object[]>}
   */
  async getPokestops() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('mapElements', 'readonly');
      const store = tx.objectStore('mapElements');
      const index = store.index('type');
      const request = index.getAll('pokestop');

      request.onsuccess = () => {
        const now = Date.now();
        const valid = request.result
          .filter(item => !item.expiresAt || item.expiresAt > now)
          .map(item => item.data);
        resolve(valid);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // ── Gyms ─────────────────────────────────────────────────

  /**
   * Cache Gyms
   * @param {object[]} gyms 
   * @returns {Promise<void>}
   */
  async cacheGyms(gyms) {
    if (!gyms || gyms.length === 0) return;

    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('mapElements', 'readwrite');
      const store = tx.objectStore('mapElements');
      const now = Date.now();
      const gymMaxAge = 60 * 60 * 1000; // 1 hour for gyms

      for (const gym of gyms) {
        store.put({
          id: gym.id,
          type: 'gym',
          data: gym,
          expiresAt: now + gymMaxAge,
          updatedAt: now
        });
      }

      tx.oncomplete = () => {
        console.log(`[MapElementCache] Cached ${gyms.length} Gyms`);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get cached Gyms
   * @returns {Promise<object[]>}
   */
  async getGyms() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('mapElements', 'readonly');
      const store = tx.objectStore('mapElements');
      const index = store.index('type');
      const request = index.getAll('gym');

      request.onsuccess = () => {
        const now = Date.now();
        const valid = request.result
          .filter(item => !item.expiresAt || item.expiresAt > now)
          .map(item => item.data);
        resolve(valid);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // ── Generic Operations ───────────────────────────────────

  /**
   * Get all cached map elements grouped by type
   * @returns {Promise<{wild: object[], pokestops: object[], gyms: object[]}>}
   */
  async getAll() {
    const [wild, pokestops, gyms] = await Promise.all([
      this.getWildPokemon(),
      this.getPokestops(),
      this.getGyms()
    ]);

    return { wild, pokestops, gyms };
  }

  /**
   * Cache all map elements at once
   * @param {{wildPokemon?: object[], pokestops?: object[], gyms?: object[]}} elements 
   */
  async cacheAll(elements) {
    const promises = [];

    if (elements.wildPokemon) {
      promises.push(this.cacheWildPokemon(elements.wildPokemon));
    }
    if (elements.pokestops) {
      promises.push(this.cachePokestops(elements.pokestops));
    }
    if (elements.gyms) {
      promises.push(this.cacheGyms(elements.gyms));
    }

    await Promise.all(promises);
  }

  /**
   * Remove a specific map element
   * @param {string} id 
   * @returns {Promise<void>}
   */
  async remove(id) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('mapElements', 'readwrite');
      const store = tx.objectStore('mapElements');
      store.delete(id);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clean expired map elements
   * @returns {Promise<number>} Number of deleted records
   */
  async cleanExpired() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('mapElements', 'readwrite');
      const store = tx.objectStore('mapElements');
      const index = store.index('expiresAt');

      const now = Date.now();
      const range = IDBKeyRange.upperBound(now);
      let deletedCount = 0;

      const request = index.openCursor(range);

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          deletedCount++;
          cursor.continue();
        } else {
          console.log(`[MapElementCache] Cleaned ${deletedCount} expired map elements`);
          resolve(deletedCount);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get cache statistics
   * @returns {Promise<{wild: number, pokestops: number, gyms: number, expired: number}>}
   */
  async getStats() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('mapElements', 'readonly');
      const store = tx.objectStore('mapElements');
      const request = store.getAll();

      request.onsuccess = () => {
        const now = Date.now();
        const items = request.result;

        const stats = {
          wild: 0,
          pokestops: 0,
          gyms: 0,
          expired: 0
        };

        for (const item of items) {
          const isExpired = item.expiresAt && item.expiresAt <= now;

          if (isExpired) {
            stats.expired++;
          } else if (item.type === 'wild') {
            stats.wild++;
          } else if (item.type === 'pokestop') {
            stats.pokestops++;
          } else if (item.type === 'gym') {
            stats.gyms++;
          }
        }

        resolve(stats);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all cached map elements
   * @returns {Promise<void>}
   */
  async clear() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('mapElements', 'readwrite');
      const store = tx.objectStore('mapElements');
      store.clear();

      tx.oncomplete = () => {
        console.log('[MapElementCache] Cache cleared');
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }
}
