/**
 * 分享模板系统
 * REQ-00153: 游戏内截图分享与社交传播系统
 */

class ShareTemplateManager {
  constructor() {
    this.templates = new Map();
    this._initDefaultTemplates();
  }

  /**
   * 初始化默认模板
   */
  _initDefaultTemplates() {
    // 捕捉分享模板
    this.registerTemplate('catch', {
      name: '捕捉分享',
      scene: 'catch',
      generateContent: (data) => ({
        title: `我捕捉到了 ${data.pokemonName}！`,
        description: data.isShiny 
          ? `✨ 闪光 ${data.pokemonName}！CP: ${data.cp}，IV: ${data.ivPercent}%`
          : `${data.pokemonName} | CP: ${data.cp}，IV: ${data.ivPercent}%`,
        hashtags: ['mineGo', 'PokemonGo', data.pokemonName, data.isShiny ? 'Shiny' : 'Catch'].filter(Boolean),
        extra: {
          pokemonId: data.pokemonId,
          cp: data.cp,
          iv: data.iv,
          isShiny: data.isShiny,
          location: data.location
        }
      }),
      platforms: ['wechat', 'weibo', 'twitter', 'facebook', 'system']
    });

    // 成就分享模板
    this.registerTemplate('achievement', {
      name: '成就分享',
      scene: 'achievement',
      generateContent: (data) => ({
        title: `我完成了成就：${data.achievementName}！`,
        description: `🏆 ${data.achievementDescription}\n奖励：${data.reward}`,
        hashtags: ['mineGo', 'Achievement', data.achievementName],
        extra: {
          achievementId: data.achievementId,
          achievementType: data.type,
          completedAt: data.completedAt
        }
      }),
      platforms: ['wechat', 'weibo', 'twitter', 'facebook', 'system']
    });

    // 战斗分享模板
    this.registerTemplate('battle', {
      name: '战斗分享',
      scene: 'battle',
      generateContent: (data) => ({
        title: data.isWin 
          ? `我在道馆战斗中获胜了！` 
          : `道馆战斗结束`,
        description: data.isWin
          ? `⚔️ 击败了 ${data.defenderName} 的 ${data.defenderPokemon}\n我的 ${data.myPokemon} 立下大功！`
          : `⚔️ 挑战 ${data.gymName} 失败，下次再来！`,
        hashtags: ['mineGo', 'GymBattle', data.isWin ? 'Victory' : 'Battle'],
        extra: {
          gymId: data.gymId,
          gymName: data.gymName,
          isWin: data.isWin,
          battleId: data.battleId
        }
      }),
      platforms: ['wechat', 'weibo', 'twitter', 'facebook', 'system']
    });

    // 图鉴分享模板
    this.registerTemplate('pokedex', {
      name: '图鉴分享',
      scene: 'pokedex',
      generateContent: (data) => ({
        title: `我的图鉴完成度：${data.completionPercent}%`,
        description: `📖 已收集 ${data.collected}/${data.total} 种精灵\n${data.recentCatch ? `最近捕捉：${data.recentCatch}` : ''}`,
        hashtags: ['mineGo', 'Pokedex', 'PokemonCollection'],
        extra: {
          completionPercent: data.completionPercent,
          collected: data.collected,
          total: data.total
        }
      }),
      platforms: ['wechat', 'weibo', 'twitter', 'facebook', 'system']
    });

    // 好友分享模板
    this.registerTemplate('friend', {
      name: '好友分享',
      scene: 'friend',
      generateContent: (data) => ({
        title: `我在 mineGo 有 ${data.friendCount} 个好友！`,
        description: `👥 一起探索精灵世界吧！\n我的好友码：${data.friendCode}`,
        hashtags: ['mineGo', 'Friends', 'PokemonGo'],
        extra: {
          friendCount: data.friendCount,
          friendCode: data.friendCode,
          userId: data.userId
        }
      }),
      platforms: ['wechat', 'weibo', 'twitter', 'facebook', 'system']
    });

    // 自定义分享模板
    this.registerTemplate('custom', {
      name: '自定义分享',
      scene: 'custom',
      generateContent: (data) => ({
        title: data.title || 'mineGo 游戏截图',
        description: data.description || '来自 mineGo 的分享',
        hashtags: data.hashtags || ['mineGo'],
        extra: data.extra || {}
      }),
      platforms: ['wechat', 'weibo', 'twitter', 'facebook', 'system']
    });
  }

  /**
   * 注册模板
   */
  registerTemplate(templateId, template) {
    this.templates.set(templateId, {
      id: templateId,
      ...template,
      createdAt: Date.now()
    });
  }

  /**
   * 获取模板
   */
  getTemplate(templateId) {
    return this.templates.get(templateId);
  }

  /**
   * 生成分享内容
   */
  generateContent(templateId, data) {
    const template = this.getTemplate(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }
    return template.generateContent(data);
  }

  /**
   * 获取支持的平台列表
   */
  getSupportedPlatforms(templateId) {
    const template = this.getTemplate(templateId);
    return template ? template.platforms : [];
  }

  /**
   * 获取所有模板
   */
  getAllTemplates() {
    return Array.from(this.templates.values());
  }

  /**
   * 格式化为平台特定内容
   */
  formatForPlatform(content, platform) {
    const hashtags = content.hashtags.map(h => `#${h}`).join(' ');
    const fullText = `${content.title}\n\n${content.description}\n\n${hashtags}`;

    switch (platform) {
      case 'wechat':
        return {
          title: content.title,
          desc: content.description,
          // 微信分享需要缩略图，由调用方提供
        };

      case 'weibo':
        return {
          text: fullText.substring(0, 140), // 微博字数限制
          // 图片由调用方提供
        };

      case 'twitter':
        return {
          text: fullText.substring(0, 280), // Twitter 字数限制
          // 图片由调用方提供
        };

      case 'facebook':
        return {
          quote: fullText,
          // 图片由调用方提供
        };

      case 'system':
        return {
          title: content.title,
          text: fullText,
          // 图片由调用方提供
        };

      default:
        return { text: fullText };
    }
  }
}

// 导出单例
module.exports = new ShareTemplateManager();
module.exports.ShareTemplateManager = ShareTemplateManager;
