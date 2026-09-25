// pokemon-service/src/routes/voiceDescription.js
// REQ-00337：精灵语音描述 API（经网关 /v1/pokemon/* 鉴权访问）
//   GET /pokemon/species/:id/voice-description?lang=zh-CN|en-US|ja-JP   单个精灵（野生/图鉴）
//   GET /pokemon/voice-descriptions?ids=1,4,7&lang=                      批量（列表场景，≤50）
//   GET /pokemon/my/:id/voice-description                                玩家自己的精灵（含 CP/HP/IV/技能）
'use strict';

const express = require('express');
const { query } = require('../../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../../shared/auth');
const { buildVoiceDescription, normalizeLang, SPECIES_SQL } = require('../voiceDescriptionService');

const router = express.Router();

function reqLang(req) {
  return normalizeLang(req.query.lang || req.headers['x-language'] || req.headers['accept-language']);
}

function parseSpeciesId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 32767) throw new AppError(1001, '精灵编号非法', 400);
  return n;
}

router.get('/species/:id/voice-description', async (req, res, next) => {
  try {
    const id = parseSpeciesId(req.params.id);
    const { rows: [species] } = await query(`${SPECIES_SQL} WHERE s.id = $1`, [id]);
    if (!species) throw new AppError(3001, '精灵不存在', 404);
    const wildCp = Number(req.query.cp) > 0 ? Number(req.query.cp) : null;
    res.json(successResp(buildVoiceDescription(species, { lang: reqLang(req), wildCp })));
  } catch (err) { next(err); }
});

router.get('/voice-descriptions', async (req, res, next) => {
  try {
    const ids = [...new Set(String(req.query.ids || '').split(',').filter(Boolean).map(parseSpeciesId))];
    if (!ids.length) throw new AppError(1001, 'ids 不能为空', 400);
    if (ids.length > 50) throw new AppError(1001, '一次最多 50 个', 400);
    const lang = reqLang(req);
    const { rows } = await query(`${SPECIES_SQL} WHERE s.id = ANY($1::int[]) ORDER BY s.id`, [ids]);
    res.json(successResp({ lang, items: rows.map((r) => buildVoiceDescription(r, { lang })) }));
  } catch (err) { next(err); }
});

router.get('/my/:id/voice-description', requireAuth, async (req, res, next) => {
  try {
    const { rows: [pi] } = await query(
      `SELECT id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, is_shiny, fast_move, charge_move
         FROM pokemon_instances WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.sub]
    );
    if (!pi) throw new AppError(3001, '精灵不存在', 404);
    const { rows: [species] } = await query(`${SPECIES_SQL} WHERE s.id = $1`, [pi.species_id]);
    if (!species) throw new AppError(3001, '精灵不存在', 404);
    res.json(successResp({ pokemonId: pi.id, ...buildVoiceDescription(species, { lang: reqLang(req), instance: pi }) }));
  } catch (err) {
    if (err && err.code === '22P02') return next(new AppError(1001, '精灵 ID 非法', 400));
    next(err);
  }
});

module.exports = router;
