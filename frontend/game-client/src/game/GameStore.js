// frontend/game-client/src/game/GameStore.js
// Central reactive state store for the game client
// Uses a simple pub/sub pattern (no external dependencies)
'use strict';

export class GameStore extends EventTarget {
  constructor() {
    super();
    this._state = {
      // Auth
      isLoggedIn:    false,
      currentUser:   null,

      // Location
      playerLat:     null,
      playerLng:     null,
      playerAccuracy: null,

      // Map elements
      wildPokemon:   [],   // [{id, speciesId, lat, lng, cp, expiresAt, ...}]
      pokestops:     [],   // [{id, name, lat, lng, canSpin}]
      gyms:          [],   // [{id, name, lat, lng, team, defenderCount, ...}]

      // Catch
      activeCatch:   null,  // {session, pokemon}

      // Inventory
      pokeballs:     0,
      greatballs:    0,
      ultraballs:    0,
      masterballs:   0,
      stardust:      0,
      coins:         0,

      // UI
      activeScreen:  'map',  // 'map' | 'catch' | 'pokemon' | 'pokedex' | 'shop' | 'profile'
      notifications: [],
      loading:       false,
    };

    this._subscriptions = new Map();
  }

  // ── State access ──────────────────────────────────────────
  get(key) { return this._state[key]; }

  getAll() { return { ...this._state }; }

  // ── State mutation ────────────────────────────────────────
  set(updates) {
    const changed = [];
    for (const [key, val] of Object.entries(updates)) {
      if (this._state[key] !== val) {
        this._state[key] = val;
        changed.push(key);
      }
    }
    if (changed.length > 0) {
      this.dispatchEvent(new CustomEvent('change', { detail: { changed, state: { ...this._state } } }));
      for (const key of changed) {
        this.dispatchEvent(new CustomEvent(`change:${key}`, { detail: { value: this._state[key] } }));
      }
    }
  }

  // ── Map element helpers ───────────────────────────────────
  updateMapElements({ wildPokemons, pokestops, gyms }) {
    if (wildPokemons) this.set({ wildPokemon: wildPokemons });
    if (pokestops)    this.set({ pokestops });
    if (gyms)         this.set({ gyms });
  }

  removePokemon(spawnId) {
    this.set({ wildPokemon: this._state.wildPokemon.filter(p => p.id !== spawnId) });
  }

  updatePokestopCooldown(pokestopId) {
    this.set({
      pokestops: this._state.pokestops.map(ps =>
        ps.id === pokestopId ? { ...ps, canSpin: false } : ps
      )
    });
  }

  updateGymTeam(gymId, team, defenderCount) {
    this.set({
      gyms: this._state.gyms.map(g =>
        g.id === gymId ? { ...g, controlling_team: team, defender_count: defenderCount } : g
      )
    });
  }

  // ── Inventory helpers ─────────────────────────────────────
  updateInventory(inv) {
    this.set({
      pokeballs:  inv.pokeball_count  ?? this._state.pokeballs,
      greatballs: inv.greatball_count ?? this._state.greatballs,
      ultraballs: inv.ultraball_count ?? this._state.ultraballs,
      masterballs: inv.masterball_count ?? this._state.masterballs,
      stardust:   inv.stardust ?? this._state.stardust,
      coins:      inv.coins    ?? this._state.coins,
    });
  }

  // ── Notifications ─────────────────────────────────────────
  addNotification(message, type = 'info', duration = 3000) {
    const id  = Date.now();
    const notifications = [
      ...this._state.notifications.slice(-4), // Keep last 4
      { id, message, type, createdAt: Date.now() }
    ];
    this.set({ notifications });
    if (duration > 0) {
      setTimeout(() => this.removeNotification(id), duration);
    }
    return id;
  }

  removeNotification(id) {
    this.set({ notifications: this._state.notifications.filter(n => n.id !== id) });
  }

  // ── Screen navigation ─────────────────────────────────────
  navigate(screen) {
    this.set({ activeScreen: screen });
  }

  // ── User ─────────────────────────────────────────────────
  setUser(user) {
    this.set({ isLoggedIn: !!user, currentUser: user });
    if (user) this.updateInventory(user);
  }
}

// Singleton
export const store = new GameStore();
