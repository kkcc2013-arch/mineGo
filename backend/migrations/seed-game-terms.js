'use strict';

/**
 * 游戏术语词典初始数据
 * REQ-00551: 跨语言实时聊天翻译系统
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const gameTerms = [
      // Pokemon 类别
      {
        term_key: 'pokemon',
        source_language: 'en-US',
        source_term: 'Pokémon',
        translations: {
          'zh-CN': '精灵',
          'ja-JP': 'ポケモン',
          'ko-KR': '포켓몬',
          'es-ES': 'Pokémon',
          'fr-FR': 'Pokémon',
          'de-DE': 'Pokémon'
        },
        category: 'pokemon',
        context_hint: 'General term for creatures in the game',
        is_official: true
      },
      {
        term_key: 'poke_ball',
        source_language: 'en-US',
        source_term: 'Poké Ball',
        translations: {
          'zh-CN': '精灵球',
          'ja-JP': 'モンスターボール',
          'ko-KR': '몬스터볼',
          'es-ES': 'Poké Ball',
          'fr-FR': 'Poké Ball',
          'de-DE': 'Pokéball'
        },
        category: 'item',
        context_hint: 'Basic item for catching Pokémon',
        is_official: true
      },
      {
        term_key: 'great_ball',
        source_language: 'en-US',
        source_term: 'Great Ball',
        translations: {
          'zh-CN': '超级球',
          'ja-JP': 'スーパーボール',
          'ko-KR': '슈퍼볼',
          'es-ES': 'Super Ball',
          'fr-FR': 'Super Ball',
          'de-DE': 'Superball'
        },
        category: 'item',
        is_official: true
      },
      {
        term_key: 'ultra_ball',
        source_language: 'en-US',
        source_term: 'Ultra Ball',
        translations: {
          'zh-CN': '高级球',
          'ja-JP': 'ハイパーボール',
          'ko-KR': '하이퍼볼',
          'es-ES': 'Ultra Ball',
          'fr-FR': 'Hyper Ball',
          'de-DE': 'Hyperball'
        },
        category: 'item',
        is_official: true
      },
      {
        term_key: 'master_ball',
        source_language: 'en-US',
        source_term: 'Master Ball',
        translations: {
          'zh-CN': '大师球',
          'ja-JP': 'マスターボール',
          'ko-KR': '마스터볼',
          'es-ES': 'Master Ball',
          'fr-FR': 'Master Ball',
          'de-DE': 'Meisterball'
        },
        category: 'item',
        is_official: true
      },
      
      // 游戏机制类别
      {
        term_key: 'gym',
        source_language: 'en-US',
        source_term: 'Gym',
        translations: {
          'zh-CN': '道馆',
          'ja-JP': 'ジム',
          'ko-KR': '체육관',
          'es-ES': 'Gimnasio',
          'fr-FR': 'Arène',
          'de-DE': 'Arena'
        },
        category: 'location',
        is_official: true
      },
      {
        term_key: 'raid',
        source_language: 'en-US',
        source_term: 'Raid',
        translations: {
          'zh-CN': '突袭',
          'ja-JP': 'レイド',
          'ko-KR': '레이드',
          'es-ES': 'Incursión',
          'fr-FR': 'Raid',
          'de-DE': 'Raid'
        },
        category: 'mechanic',
        is_official: true
      },
      {
        term_key: 'raid_battle',
        source_language: 'en-US',
        source_term: 'Raid Battle',
        translations: {
          'zh-CN': '突袭战斗',
          'ja-JP': 'レイドバトル',
          'ko-KR': '레이드 배틀',
          'es-ES': 'Batalla de Incursión',
          'fr-FR': 'Combat de Raid',
          'de-DE': 'Raid-Kampf'
        },
        category: 'mechanic',
        is_official: true
      },
      {
        term_key: 'spawn',
        source_language: 'en-US',
        source_term: 'Spawn',
        translations: {
          'zh-CN': '刷新',
          'ja-JP': 'スポーン',
          'ko-KR': '스폰',
          'es-ES': 'Aparición',
          'fr-FR': 'Apparition',
          'de-DE': 'Spawn'
        },
        category: 'mechanic',
        is_official: true
      },
      {
        term_key: 'catch',
        source_language: 'en-US',
        source_term: 'Catch',
        translations: {
          'zh-CN': '捕捉',
          'ja-JP': '捕獲',
          'ko-KR': '포획',
          'es-ES': 'Capturar',
          'fr-FR': 'Capturer',
          'de-DE': 'Fangen'
        },
        category: 'mechanic',
        is_official: true
      },
      {
        term_key: 'cp',
        source_language: 'en-US',
        source_term: 'CP',
        translations: {
          'zh-CN': '战斗力',
          'ja-JP': 'CP',
          'ko-KR': 'CP',
          'es-ES': 'PC',
          'fr-FR': 'PC',
          'de-DE': 'WP'
        },
        category: 'mechanic',
        context_hint: 'Combat Power',
        is_official: true
      },
      {
        term_key: 'hp',
        source_language: 'en-US',
        source_term: 'HP',
        translations: {
          'zh-CN': '生命值',
          'ja-JP': 'HP',
          'ko-KR': 'HP',
          'es-ES': 'PS',
          'fr-FR': 'PV',
          'de-DE': 'KP'
        },
        category: 'mechanic',
        context_hint: 'Health Points',
        is_official: true
      },
      
      // 物品类別
      {
        term_key: 'potion',
        source_language: 'en-US',
        source_term: 'Potion',
        translations: {
          'zh-CN': '药水',
          'ja-JP': 'キズぐすり',
          'ko-KR': '상처약',
          'es-ES': 'Poción',
          'fr-FR': 'Potion',
          'de-DE': 'Trank'
        },
        category: 'item',
        is_official: true
      },
      {
        term_key: 'revive',
        source_language: 'en-US',
        source_term: 'Revive',
        translations: {
          'zh-CN': '复活药',
          'ja-JP': 'げんきのかたまり',
          'ko-KR': '부활약',
          'es-ES': 'Revivir',
          'fr-FR': 'Rappel',
          'de-DE': 'Beleber'
        },
        category: 'item',
        is_official: true
      },
      {
        term_key: 'berry',
        source_language: 'en-US',
        source_term: 'Berry',
        translations: {
          'zh-CN': '浆果',
          'ja-JP': 'きのみ',
          'ko-KR': '나무열매',
          'es-ES': 'Bayas',
          'fr-FR': 'Baie',
          'de-DE': 'Beere'
        },
        category: 'item',
        is_official: true
      },
      {
        term_key: 'razz_berry',
        source_language: 'en-US',
        source_term: 'Razz Berry',
        translations: {
          'zh-CN': '红蔓莓',
          'ja-JP': 'ラズのみ',
          'ko-KR': '라즈열매',
          'es-ES': 'Baya Frambu',
          'fr-FR': 'Baie Framby',
          'de-DE': 'Himmihbeere'
        },
        category: 'item',
        is_official: true
      },
      
      // 技能类别
      {
        term_key: 'fast_move',
        source_language: 'en-US',
        source_term: 'Fast Move',
        translations: {
          'zh-CN': '快速技能',
          'ja-JP': 'ノーマル技',
          'ko-KR': '일반 기술',
          'es-ES': 'Ataque Rápido',
          'fr-FR': 'Attaque Rapide',
          'de-DE': 'Schneller Angriff'
        },
        category: 'skill',
        is_official: true
      },
      {
        term_key: 'charged_move',
        source_language: 'en-US',
        source_term: 'Charged Move',
        translations: {
          'zh-CN': '充能技能',
          'ja-JP': 'スペシャル技',
          'ko-KR': '특수 기술',
          'es-ES': 'Ataque Cargado',
          'fr-FR': 'Attaque Chargée',
          'de-DE': 'Lade-Angriff'
        },
        category: 'skill',
        is_official: true
      },
      
      // 社交类别
      {
        term_key: 'friend',
        source_language: 'en-US',
        source_term: 'Friend',
        translations: {
          'zh-CN': '好友',
          'ja-JP': 'フレンド',
          'ko-KR': '친구',
          'es-ES': 'Amigo',
          'fr-FR': 'Ami',
          'de-DE': 'Freund'
        },
        category: 'social',
        is_official: true
      },
      {
        term_key: 'trade',
        source_language: 'en-US',
        source_term: 'Trade',
        translations: {
          'zh-CN': '交换',
          'ja-JP': '交換',
          'ko-KR': '교환',
          'es-ES': 'Intercambio',
          'fr-FR': 'Échange',
          'de-DE': 'Tausch'
        },
        category: 'social',
        is_official: true
      },
      {
        term_key: 'gift',
        source_language: 'en-US',
        source_term: 'Gift',
        translations: {
          'zh-CN': '礼物',
          'ja-JP': 'プレゼント',
          'ko-KR': '선물',
          'es-ES': 'Regalo',
          'fr-FR': 'Cadeau',
          'de-DE': 'Geschenk'
        },
        category: 'social',
        is_official: true
      },
      {
        term_key: 'team',
        source_language: 'en-US',
        source_term: 'Team',
        translations: {
          'zh-CN': '队伍',
          'ja-JP': 'チーム',
          'ko-KR': '팀',
          'es-ES': 'Equipo',
          'fr-FR': 'Équipe',
          'de-DE': 'Team'
        },
        category: 'social',
        is_official: true
      },
      
      // 奖励类别
      {
        term_key: 'quest',
        source_language: 'en-US',
        source_term: 'Quest',
        translations: {
          'zh-CN': '任务',
          'ja-JP': 'クエスト',
          'ko-KR': '퀘스트',
          'es-ES': 'Tarea',
          'fr-FR': 'Quête',
          'de-DE': 'Quest'
        },
        category: 'reward',
        is_official: true
      },
      {
        term_key: 'achievement',
        source_language: 'en-US',
        source_term: 'Achievement',
        translations: {
          'zh-CN': '成就',
          'ja-JP': '実績',
          'ko-KR': '업적',
          'es-ES': 'Logro',
          'fr-FR': 'Succès',
          'de-DE': 'Erfolg'
        },
        category: 'reward',
        is_official: true
      },
      {
        term_key: 'stardust',
        source_language: 'en-US',
        source_term: 'Stardust',
        translations: {
          'zh-CN': '星尘',
          'ja-JP': 'ほしのすな',
          'ko-KR': '별의모래',
          'es-ES': 'Polvo Estelar',
          'fr-FR': 'Poussière Étoile',
          'de-DE': 'Sternenstaub'
        },
        category: 'reward',
        is_official: true
      },
      {
        term_key: 'candy',
        source_language: 'en-US',
        source_term: 'Candy',
        translations: {
          'zh-CN': '糖果',
          'ja-JP': 'アメ',
          'ko-KR': '사탕',
          'es-ES': 'Caramelo',
          'fr-FR': 'Bonbon',
          'de-DE': 'Bonbon'
        },
        category: 'reward',
        is_official: true
      },
      
      // 系统类别
      {
        term_key: 'player',
        source_language: 'en-US',
        source_term: 'Player',
        translations: {
          'zh-CN': '玩家',
          'ja-JP': 'プレイヤー',
          'ko-KR': '플레이어',
          'es-ES': 'Jugador',
          'fr-FR': 'Joueur',
          'de-DE': 'Spieler'
        },
        category: 'system',
        is_official: true
      },
      {
        term_key: 'trainer',
        source_language: 'en-US',
        source_term: 'Trainer',
        translations: {
          'zh-CN': '训练师',
          'ja-JP': 'トレーナー',
          'ko-KR': '트레이너',
          'es-ES': 'Entrenador',
          'fr-FR': 'Dresseur',
          'de-DE': 'Trainer'
        },
        category: 'system',
        is_official: true
      },
      {
        term_key: 'level',
        source_language: 'en-US',
        source_term: 'Level',
        translations: {
          'zh-CN': '等级',
          'ja-JP': 'レベル',
          'ko-KR': '레벨',
          'es-ES': 'Nivel',
          'fr-FR': 'Niveau',
          'de-DE': 'Level'
        },
        category: 'system',
        is_official: true
      },
      {
        term_key: 'experience',
        source_language: 'en-US',
        source_term: 'Experience',
        translations: {
          'zh-CN': '经验值',
          'ja-JP': '経験値',
          'ko-KR': '경험치',
          'es-ES': 'Experiencia',
          'fr-FR': 'Expérience',
          'de-DE': 'Erfahrung'
        },
        category: 'system',
        is_official: true
      },
      
      // 位置类别
      {
        term_key: 'pokestop',
        source_language: 'en-US',
        source_term: 'PokéStop',
        translations: {
          'zh-CN': '补给站',
          'ja-JP': 'ポケストップ',
          'ko-KR': '포켓스톱',
          'es-ES': 'Poképarada',
          'fr-FR': 'PokéStop',
          'de-DE': 'PokéStop'
        },
        category: 'location',
        is_official: true
      },
      {
        term_key: 'lure_module',
        source_language: 'en-US',
        source_term: 'Lure Module',
        translations: {
          'zh-CN': '诱饵模块',
          'ja-JP': 'おとしモジュール',
          'ko-KR': '유인 모듈',
          'es-ES': 'Módulo Cebo',
          'fr-FR': 'Module Leurre',
          'de-DE': 'Lockmodul'
        },
        category: 'item',
        is_official: true
      },
      
      // 战斗类别
      {
        term_key: 'battle',
        source_language: 'en-US',
        source_term: 'Battle',
        translations: {
          'zh-CN': '战斗',
          'ja-JP': 'バトル',
          'ko-KR': '배틀',
          'es-ES': 'Batalla',
          'fr-FR': 'Combat',
          'de-DE': 'Kampf'
        },
        category: 'mechanic',
        is_official: true
      },
      {
        term_key: 'pvp',
        source_language: 'en-US',
        source_term: 'PvP',
        translations: {
          'zh-CN': '玩家对战',
          'ja-JP': 'PvP',
          'ko-KR': 'PvP',
          'es-ES': 'JcJ',
          'fr-FR': 'JcJ',
          'de-DE': 'PvP'
        },
        category: 'mechanic',
        context_hint: 'Player versus Player',
        is_official: true
      },
      {
        term_key: 'pve',
        source_language: 'en-US',
        source_term: 'PvE',
        translations: {
          'zh-CN': '玩家对环境',
          'ja-JP': 'PvE',
          'ko-KR': 'PvE',
          'es-ES': 'JcE',
          'fr-FR': 'JcE',
          'de-DE': 'PvE'
        },
        category: 'mechanic',
        context_hint: 'Player versus Environment',
        is_official: true
      }
    ];

    await queryInterface.bulkInsert('game_term_dictionary', 
      gameTerms.map(term => ({
        ...term,
        translations: JSON.stringify(term.translations),
        created_at: new Date(),
        updated_at: new Date()
      })),
      {}
    );

    console.log(`✅ Inserted ${gameTerms.length} game terms`);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.bulkDelete('game_term_dictionary', null, {});
    console.log('✅ Game terms cleared');
  }
};