-- ============================================================
-- Pocket Monster Go - Seed Data v1
-- Gen 1 Pokemon (151 species) - representative sample
-- ============================================================

INSERT INTO pokemon_species (id,name_zh,name_en,type1,type2,rarity,base_attack,base_defense,base_hp,base_catch_rate,base_flee_rate,candy_to_evolve,evolves_to,biomes,sprite_url,description_zh) VALUES
-- STARTERS
(1,  '妙蛙种子','Bulbasaur',  'GRASS','POISON','UNCOMMON', 118,111,128, 0.20,0.10, 25, 2,  ARRAY['FOREST','URBAN'],'/sprites/1.png',  '奇怪的种子从出生就种在背上'),
(2,  '妙蛙草',  'Ivysaur',   'GRASS','POISON','RARE',     151,143,155, 0.10,0.07, 100,3,  ARRAY['FOREST'],       '/sprites/2.png',  '背上的球茎不断吸收阳光'),
(3,  '妙蛙花',  'Venusaur',  'GRASS','POISON','EPIC',     198,189,190, 0.05,0.05, NULL,NULL,ARRAY['FOREST'],     '/sprites/3.png',  '进化的最终形态，鲜花盛开'),
(4,  '小火龙',  'Charmander','FIRE', NULL,    'UNCOMMON', 116,93, 118, 0.20,0.10, 25, 5,  ARRAY['URBAN','MOUNTAIN'],'/sprites/4.png','尾巴尖上有火焰，这是生命力的象征'),
(5,  '火恐龙',  'Charmeleon','FIRE', NULL,    'RARE',     158,126,151, 0.10,0.07, 100,6,  ARRAY['MOUNTAIN'],    '/sprites/5.png',  '性格残暴，会主动攻击强大的敌人'),
(6,  '喷火龙',  'Charizard', 'FIRE','FLYING', 'EPIC',     223,173,186, 0.05,0.05, NULL,NULL,ARRAY['MOUNTAIN'],  '/sprites/6.png',  '振翅可飞上1400m高空'),
(7,  '杰尼龟',  'Squirtle',  'WATER',NULL,   'UNCOMMON', 94, 121,127, 0.20,0.10, 25, 8,  ARRAY['WATER','URBAN'],'/sprites/7.png', '壳是坚硬的防护盾，也可以高速喷水'),
(8,  '卡咪龟',  'Wartortle', 'WATER',NULL,   'RARE',     126,155,153, 0.10,0.07, 100,9,  ARRAY['WATER'],       '/sprites/8.png',  '毛绒绒的耳朵和尾巴可以保持平衡'),
(9,  '水箭龟',  'Blastoise', 'WATER',NULL,   'EPIC',     171,207,188, 0.05,0.05, NULL,NULL,ARRAY['WATER'],     '/sprites/9.png',  '背上的炮台可以发射强力水柱'),

-- ICONIC
(25, '皮卡丘',  'Pikachu',   'ELECTRIC',NULL,'RARE',    112,96, 111, 0.16,0.10, 50, 26, ARRAY['URBAN','FOREST'],'/sprites/25.png','两颊的红色电力袋会释放电流'),
(26, '雷丘',    'Raichu',    'ELECTRIC',NULL,'EPIC',    193,151,155, 0.08,0.06, NULL,NULL,ARRAY['URBAN'],      '/sprites/26.png', '储存了大量电力，甚至能击倒大象'),
(39, '胖丁',    'Jigglypuff','NORMAL','FAIRY','COMMON', 80, 41, 251, 0.35,0.15, 25, 40, ARRAY['URBAN','GRASS'],'/sprites/39.png','歌声有催眠效果，自己也会睡着'),
(40, '胖可丁',  'Wigglytuff','NORMAL','FAIRY','UNCOMMON',156,90,295, 0.15,0.08, NULL,NULL,ARRAY['URBAN'],     '/sprites/40.png', '毛茸茸的身体柔软无比'),
(52, '喵喵',    'Meowth',    'NORMAL',NULL,  'COMMON',  92, 78, 120, 0.40,0.15, 50, 53, ARRAY['URBAN'],       '/sprites/52.png', '额头的金币是它的宝贝'),
(53, '猫老大',  'Persian',   'NORMAL',NULL,  'UNCOMMON',150,136,163, 0.15,0.08, NULL,NULL,ARRAY['URBAN'],     '/sprites/53.png', '动作优雅迅捷，深受上流社会喜爱'),
(54, '可达鸭',  'Psyduck',   'WATER', NULL,  'COMMON',  122,96, 130, 0.30,0.12, 50, 55, ARRAY['WATER'],       '/sprites/54.png', '总是头痛，头痛时反而能发挥超能力'),
(74, '小拳石',  'Geodude',   'ROCK', 'GROUND','COMMON', 132,132,120, 0.40,0.12, 25, 75, ARRAY['MOUNTAIN'],    '/sprites/74.png', '半埋在地里，常被误踢而大发雷霆'),
(79, '呆呆兽',  'Slowpoke',  'WATER','PSYCHIC','COMMON',109,98, 207, 0.40,0.10, 50, 80, ARRAY['WATER'],       '/sprites/79.png', '反应极慢，被咬了几秒后才知道'),
(94, '耿鬼',    'Gengar',    'GHOST','POISON','RARE',   261,149,155, 0.12,0.07, NULL,NULL,ARRAY['URBAN'],     '/sprites/94.png', '躲在阴暗处偷走人的体温'),
(131,'巨拉多',  'Lapras',    'WATER','ICE',  'EPIC',    165,174,277, 0.06,0.04, NULL,NULL,ARRAY['WATER'],     '/sprites/131.png','温顺的大型精灵，可以背人渡海'),
(132,'百变怪',  'Ditto',     'NORMAL',NULL,  'RARE',    91, 91, 134, 0.12,0.08, NULL,NULL,ARRAY['URBAN'],     '/sprites/132.png','可以变成任何物体，连细胞结构都能复制'),
(133,'伊布',    'Eevee',     'NORMAL',NULL,  'UNCOMMON',104,114,146, 0.18,0.09, 25, NULL,ARRAY['URBAN'],     '/sprites/133.png','不稳定的基因使它可以进化成多种形态'),
(143,'卡比兽',  'Snorlax',   'NORMAL',NULL,  'EPIC',    190,169,330, 0.04,0.03, NULL,NULL,ARRAY['URBAN'],     '/sprites/143.png','每天要吃400kg食物才满足，之后就睡觉'),

-- LEGENDARY
(144,'急冻鸟',  'Articuno',  'ICE',  'FLYING','LEGENDARY',192,236,207,0.02,0.02,NULL,NULL,ARRAY['MOUNTAIN'], '/sprites/144.png','传说中的冰之鸟，展翅时空气凝结'),
(145,'闪电鸟',  'Zapdos',    'ELECTRIC','FLYING','LEGENDARY',253,188,207,0.02,0.02,NULL,NULL,ARRAY['MOUNTAIN'],'/sprites/145.png','传说中的雷之鸟，伴随雷云飞行'),
(146,'火焰鸟',  'Moltres',   'FIRE','FLYING','LEGENDARY',251,181,207,0.02,0.02,NULL,NULL,ARRAY['MOUNTAIN'],  '/sprites/146.png','传说中的火之鸟，受伤时火焰更盛'),
(150,'超梦',    'Mewtwo',    'PSYCHIC',NULL, 'LEGENDARY',300,182,214,0.02,0.02,NULL,NULL,ARRAY['URBAN'],     '/sprites/150.png','用基因工程创造出的最强精灵'),
(151,'梦幻',    'Mew',       'PSYCHIC',NULL, 'LEGENDARY',210,210,225,0.02,0.02,NULL,NULL,ARRAY['URBAN'],     '/sprites/151.png','传说中拥有所有精灵基因的神秘精灵');

-- ============================================================
-- ACHIEVEMENT DEFINITIONS
-- ============================================================
INSERT INTO achievement_definitions (id,name_zh,description_zh,category,tiers) VALUES
('catch_total',      '精灵收集家','累计捕获精灵数量','COLLECT',
  '[{"tier":1,"target":10,"badge":"bronze"},{"tier":2,"target":100,"badge":"silver"},{"tier":3,"target":1000,"badge":"gold"}]'),
('walk_total',       '探险家',    '累计步行距离（km）','EXPLORE',
  '[{"tier":1,"target":10},{"tier":2,"target":100},{"tier":3,"target":1000}]'),
('pokestop_spins',   '补给达人',  '累计旋转补给站次数','EXPLORE',
  '[{"tier":1,"target":100},{"tier":2,"target":1000},{"tier":3,"target":2000}]'),
('gym_battles',      '道馆挑战者','累计参与道馆挑战次数','BATTLE',
  '[{"tier":1,"target":10},{"tier":2,"target":100},{"tier":3,"target":1000}]'),
('raid_participated','突破能手',  '累计参与突破（Raid）次数','BATTLE',
  '[{"tier":1,"target":10},{"tier":2,"target":100},{"tier":3,"target":1000}]'),
('shiny_caught',     '闪光猎手',  '捕获闪光精灵数量','SPECIAL',
  '[{"tier":1,"target":1},{"tier":2,"target":10},{"tier":3,"target":50}]'),
('friend_count',     '社交达人',  '拥有好友数量','SOCIAL',
  '[{"tier":1,"target":10},{"tier":2,"target":50},{"tier":3,"target":200}]'),
('pokedex_complete',  '图鉴收集者','图鉴完成百分比（×100）','COLLECT',
  '[{"tier":1,"target":25},{"tier":2,"target":50},{"tier":3,"target":100}]');

-- ============================================================
-- SAMPLE POKESTOPS (demo locations - Shanghai)
-- ============================================================
INSERT INTO pokestops (id,name,lat,lng,location,image_url) VALUES
(uuid_generate_v4(),'外滩观光平台',31.2397,121.4905,ST_SetSRID(ST_MakePoint(121.4905,31.2397),4326),'/stops/waitan.jpg'),
(uuid_generate_v4(),'人民广场喷泉',31.2304,121.4737,ST_SetSRID(ST_MakePoint(121.4737,31.2304),4326),'/stops/renmin.jpg'),
(uuid_generate_v4(),'豫园老城隍庙',31.2269,121.4918,ST_SetSRID(ST_MakePoint(121.4918,31.2269),4326),'/stops/yuyuan.jpg'),
(uuid_generate_v4(),'陆家嘴金融广场',31.2398,121.5014,ST_SetSRID(ST_MakePoint(121.5014,31.2398),4326),'/stops/lujiazui.jpg'),
(uuid_generate_v4(),'复兴公园玫瑰园',31.2198,121.4631,ST_SetSRID(ST_MakePoint(121.4631,31.2198),4326),'/stops/fuxing.jpg');

-- ============================================================
-- SAMPLE GYMS
-- ============================================================
INSERT INTO gyms (id,name,lat,lng,location,controlling_team) VALUES
(uuid_generate_v4(),'外滩道馆',31.2400,121.4900,ST_SetSRID(ST_MakePoint(121.4900,31.2400),4326),'VALOR'),
(uuid_generate_v4(),'陆家嘴道馆',31.2395,121.5010,ST_SetSRID(ST_MakePoint(121.5010,31.2395),4326),'MYSTIC'),
(uuid_generate_v4(),'人民广场道馆',31.2310,121.4740,ST_SetSRID(ST_MakePoint(121.4740,31.2310),4326),NULL);
