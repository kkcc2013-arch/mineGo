/**
 * 精灵收藏室 API（REQ-00359 / REQ-00403）——网关 /v1/collection-room → pokemon-service /collection-room
 *
 * 我的收藏室
 *   GET    /collection-room                          获取（首次自动创建）：房间、展示精灵、装饰、等级/容量、可用主题与背景
 *   PUT    /collection-room                          设置 {roomName, themeId, backgroundId, backgroundImageUrl, isPublic, layoutConfig}
 *   GET    /collection-room/stats                    收藏统计（数量、稀有度分布、闪光、图鉴完成度、近 7 天访客）
 *   GET    /collection-room/themes | /backgrounds    主题/背景（含解锁状态）；POST …/:id/purchase 金币购买付费项
 *   POST   /collection-room/pokemon                  展示精灵 {pokemonId, x?, y?, displayMode, pedestalType, scale, rotation, label}
 *   PUT    /collection-room/pokemon/:pokemonId       移动/缩放/切换展示模式；DELETE 撤下
 *   PUT    /collection-room/layout                   拖拽编辑器批量保存 {pokemon:[…], decorations:[…]}
 * 装饰
 *   GET    /collection-room/decorations/catalog      全部装饰（?category=&rarity=）
 *   GET    /collection-room/decorations/inventory    我的装饰库存（数量/已摆放/可摆放）
 *   POST   /collection-room/decorations/:itemCode/purchase   商店购买 {quantity}
 *   POST   /collection-room/decorations              摆放 {itemCode|itemId, x, y, rotation, scale, zIndex}
 *   PUT    /collection-room/decorations/:id          移动/旋转；DELETE 收回
 * 访问与互动
 *   GET    /collection-room/popular?sort=likes|visitors|level|recent   热门收藏室排行
 *   GET    /collection-room/users/:userId            按玩家访问（REQ-00403 GET /room/:userId）
 *   GET    /collection-room/:roomId/visit            按房间访问（REQ-00359）；POST /collection-room/:roomId/visit/end {durationSeconds}
 *   POST   /collection-room/:roomId/like             点赞；DELETE 取消
 *   GET|POST /collection-room/:roomId/comments       留言；DELETE /collection-room/:roomId/comments/:commentId
 */
'use strict';

const express = require('express');
const svc = require('../collectionRoom/roomService');
const { requireAuth, successResp } = require('../../../../shared/auth');

const router = express.Router();
router.use(requireAuth);

const uid = (req) => req.user.sub || req.user.id;
const lang = (req) => req.query.lang || req.headers['x-language'] || req.headers['accept-language'];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 我的收藏室（首次自动创建）
router.get('/', wrap(async (req, res) => res.json(successResp(await svc.getMyRoom(uid(req), lang(req))))));
// 修改收藏室设置（名称、主题、背景、公开、网格）
router.put('/', wrap(async (req, res) => {
  await svc.updateRoom(uid(req), req.body);
  res.json(successResp(await svc.getMyRoom(uid(req), lang(req)), '收藏室已更新'));
}));
// 收藏统计
router.get('/stats', wrap(async (req, res) => res.json(successResp(await svc.stats(uid(req))))));
// 热门收藏室排行
router.get('/popular', wrap(async (req, res) => res.json(successResp(await svc.popular({ sort: req.query.sort, limit: req.query.limit })))));

// 收藏室主题（含解锁状态）
router.get('/themes', wrap(async (req, res) => res.json(successResp(await svc.listThemes(uid(req), 'theme', lang(req))))));
// 收藏室背景（含解锁状态）
router.get('/backgrounds', wrap(async (req, res) => res.json(successResp(await svc.listThemes(uid(req), 'background', lang(req))))));
// 金币购买付费主题
router.post('/themes/:id/purchase', wrap(async (req, res) => res.json(successResp(await svc.purchaseTheme(uid(req), 'theme', req.params.id)))));
// 金币购买付费背景
router.post('/backgrounds/:id/purchase', wrap(async (req, res) => res.json(successResp(await svc.purchaseTheme(uid(req), 'background', req.params.id)))));

// 展示精灵
router.post('/pokemon', wrap(async (req, res) => res.status(201).json(successResp(await svc.displayPokemon(uid(req), req.body)))));
// 移动/缩放/切换展示模式
router.put('/pokemon/:pokemonId', wrap(async (req, res) => res.json(successResp(await svc.updateDisplayedPokemon(uid(req), req.params.pokemonId, req.body)))));
// 撤下展示的精灵
router.delete('/pokemon/:pokemonId', wrap(async (req, res) => res.json(successResp(await svc.removeDisplayedPokemon(uid(req), req.params.pokemonId)))));
// 批量保存布局（拖拽编辑器）
router.put('/layout', wrap(async (req, res) => res.json(successResp(await svc.saveLayout(uid(req), req.body)))));

// 装饰物品目录
router.get('/decorations/catalog', wrap(async (req, res) => {
  res.json(successResp(await svc.catalog({ category: req.query.category, rarity: req.query.rarity, lang: lang(req) })));
}));
// 我的装饰库存
router.get('/decorations/inventory', wrap(async (req, res) => res.json(successResp(await svc.inventory(uid(req), lang(req))))));
// 商店购买装饰
router.post('/decorations/:itemCode/purchase', wrap(async (req, res) => {
  res.json(successResp(await svc.purchaseDecoration(uid(req), req.params.itemCode, (req.body || {}).quantity ?? 1), '购买成功'));
}));
// 摆放装饰
router.post('/decorations', wrap(async (req, res) => res.status(201).json(successResp(await svc.placeDecoration(uid(req), req.body)))));
// 移动/旋转装饰
router.put('/decorations/:id', wrap(async (req, res) => res.json(successResp(await svc.moveDecoration(uid(req), req.params.id, req.body)))));
// 收回装饰
router.delete('/decorations/:id', wrap(async (req, res) => res.json(successResp(await svc.removeDecoration(uid(req), req.params.id)))));

// 按玩家访问收藏室
router.get('/users/:userId', wrap(async (req, res) => {
  const room = await svc.roomByUser(req.params.userId);
  res.json(successResp(await svc.visit(uid(req), room, lang(req))));
}));
// 按房间访问收藏室（记录访问）
router.get('/:roomId/visit', wrap(async (req, res) => {
  const room = await svc.roomById(req.params.roomId);
  res.json(successResp(await svc.visit(uid(req), room, lang(req))));
}));
// 上报本次访问时长
router.post('/:roomId/visit/end', wrap(async (req, res) => {
  res.json(successResp(await svc.endVisit(uid(req), req.params.roomId, (req.body || {}).durationSeconds)));
}));
// 点赞收藏室
router.post('/:roomId/like', wrap(async (req, res) => res.json(successResp(await svc.like(uid(req), req.params.roomId)))));
// 取消点赞
router.delete('/:roomId/like', wrap(async (req, res) => res.json(successResp(await svc.unlike(uid(req), req.params.roomId)))));
// 收藏室留言列表
router.get('/:roomId/comments', wrap(async (req, res) => {
  res.json(successResp(await svc.listComments(uid(req), req.params.roomId, { limit: req.query.limit, before: req.query.before })));
}));
// 发表留言
router.post('/:roomId/comments', wrap(async (req, res) => {
  res.status(201).json(successResp(await svc.addComment(uid(req), req.params.roomId, (req.body || {}).content)));
}));
// 删除留言（作者或房主）
router.delete('/:roomId/comments/:commentId', wrap(async (req, res) => {
  res.json(successResp(await svc.deleteComment(uid(req), req.params.roomId, req.params.commentId)));
}));

module.exports = router;
