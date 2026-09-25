// frontend/game-client/src/accessibility/mapSpeech.js
// REQ-00162 / REQ-00337：地图语音描述的纯逻辑 —— 方位角、八方向、距离、附近摘要、距离音调、空间声像
import { t } from './strings.js';

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 方位角（0=北，90=东） */
export function bearingDeg(lat1, lng1, lat2, lng2) {
  const y = Math.sin(rad(lng2 - lng1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lng2 - lng1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function compass8(bearing, lang = 'zh-CN') {
  const idx = Math.round(((bearing % 360) + 360) % 360 / 45) % 8;
  return t('dir', lang)[idx];
}

/** 声像：东 = 右（+1），西 = 左（-1） */
export function panForBearing(bearing) {
  return Number(Math.sin(rad(bearing)).toFixed(3));
}

/** 距离越近音调越高：0m → 880Hz，≥1000m → 220Hz */
export function toneForDistance(meters) {
  const d = Math.max(0, Math.min(1000, Number(meters) || 0));
  return Math.round(880 - (d / 1000) * 660);
}

function nameOf(p) {
  return p.species_name || p.speciesName || p.name || `#${p.species_id || p.speciesId || '?'}`;
}

/** 把 /map/nearby 结果转换为带方位的列表（按距离升序） */
export function describeSpawns(pokemon, pos, lang = 'zh-CN') {
  return (pokemon || []).map((p) => {
    const lat = Number(p.lat ?? p.latitude);
    const lng = Number(p.lng ?? p.longitude);
    const ok = pos && Number.isFinite(lat) && Number.isFinite(lng);
    const dist = ok ? Math.round(distanceMeters(pos.lat, pos.lng, lat, lng)) : null;
    const brg = ok ? bearingDeg(pos.lat, pos.lng, lat, lng) : null;
    return {
      id: p.id,
      name: nameOf(p),
      cp: p.cp,
      speciesId: p.species_id || p.speciesId,
      distance: dist,
      bearing: brg,
      direction: brg === null ? '' : compass8(brg, lang),
      pan: brg === null ? 0 : panForBearing(brg),
    };
  }).sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
}

/** 附近摘要："附近有 3 只精灵，最近的是皮卡丘，东北方向约 120 米；2 个补给站，1 个道馆" */
export function summarizeNearby(data, pos, lang = 'zh-CN') {
  const pokemon = data.wildPokemons || data.wild_pokemons || [];
  const stops = (data.pokestops || []).length;
  const gyms = (data.gyms || []).length;
  if (!pokemon.length && !stops && !gyms) return { text: t('nearby_none', lang), spawns: [] };
  const spawns = describeSpawns(pokemon, pos, lang);
  const n = spawns[0];
  const nearest = n && n.distance !== null ? t('nearest', lang, { name: n.name, dir: n.direction, dist: n.distance }) : '';
  return {
    text: pokemon.length
      ? t('nearby_summary', lang, { count: pokemon.length, nearest, stops, gyms })
      : `${t('nearby_none', lang)}；${t('nearby_summary', lang, { count: 0, nearest: '', stops, gyms })}`,
    spawns,
  };
}

/** 卡片无障碍名称："皮卡丘，CP 350，东北方向约 120 米" */
export function spawnLabel(s, lang = 'zh-CN') {
  const parts = [s.name];
  if (s.cp) parts.push(`CP ${s.cp}`);
  if (s.distance !== null && s.distance !== undefined) {
    parts.push(lang.startsWith('en') ? `${s.distance} m ${s.direction}` : `${s.direction}方向约 ${s.distance} 米`);
  }
  return parts.join('，');
}
