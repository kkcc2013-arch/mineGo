/**
 * 截图捕获引擎
 * REQ-00153: 游戏内截图分享与社交传播系统
 */

class ScreenshotCapture {
  constructor(options = {}) {
    this.quality = options.quality || 0.92;
    this.format = options.format || 'jpeg';
    this.maxWidth = options.maxWidth || 1920;
    this.maxHeight = options.maxHeight || 1080;
    this.watermarkOptions = {
      text: 'mineGo',
      position: 'bottom-right',
      opacity: 0.6,
      fontSize: 16,
      color: '#ffffff',
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      padding: 8
    };
  }

  /**
   * 捕获整个游戏画面
   */
  async captureGameCanvas() {
    const canvas = document.getElementById('game-canvas');
    if (!canvas) {
      throw new Error('Game canvas not found');
    }
    return this._processCanvas(canvas);
  }

  /**
   * 捕获指定区域
   */
  async captureRegion(x, y, width, height) {
    const sourceCanvas = document.getElementById('game-canvas');
    if (!sourceCanvas) {
      throw new Error('Game canvas not found');
    }

    const regionCanvas = document.createElement('canvas');
    regionCanvas.width = width;
    regionCanvas.height = height;
    const ctx = regionCanvas.getContext('2d');
    ctx.drawImage(sourceCanvas, x, y, width, height, 0, 0, width, height);
    
    return this._processCanvas(regionCanvas);
  }

  /**
   * 捕获精灵详情页
   */
  async capturePokemonDetail(pokemonId) {
    const detailElement = document.querySelector(`.pokemon-detail-${pokemonId}`);
    if (!detailElement) {
      throw new Error(`Pokemon detail element not found: ${pokemonId}`);
    }
    return this._captureElement(detailElement);
  }

  /**
   * 捕获成就页面
   */
  async captureAchievement(achievementId) {
    const achievementElement = document.querySelector(`.achievement-${achievementId}`);
    if (!achievementElement) {
      throw new Error(`Achievement element not found: ${achievementId}`);
    }
    return this._captureElement(achievementElement);
  }

  /**
   * 捕获战斗结果页面
   */
  async captureBattleResult() {
    const battleResultElement = document.querySelector('.battle-result');
    if (!battleResultElement) {
      throw new Error('Battle result element not found');
    }
    return this._captureElement(battleResultElement);
  }

  /**
   * 捕获图鉴页面
   */
  async capturePokedex() {
    const pokedexElement = document.querySelector('.pokedex-container');
    if (!pokedexElement) {
      throw new Error('Pokedex element not found');
    }
    return this._captureElement(pokedexElement);
  }

  /**
   * 捕获 DOM 元素
   */
  async _captureElement(element) {
    // 使用 html2canvas 或手动截图
    const rect = element.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d');

    // 尝试从游戏 canvas 截取对应区域
    const gameCanvas = document.getElementById('game-canvas');
    if (gameCanvas) {
      ctx.drawImage(
        gameCanvas,
        rect.left, rect.top, rect.width, rect.height,
        0, 0, rect.width, rect.height
      );
    } else {
      // 回退：绘制背景色
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = '#ffffff';
      ctx.font = '24px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('mineGo Screenshot', rect.width / 2, rect.height / 2);
    }

    return this._processCanvas(canvas);
  }

  /**
   * 处理 Canvas：缩放、压缩、格式转换
   */
  async _processCanvas(canvas) {
    // 缩放
    const scaledCanvas = this._scaleCanvas(canvas);
    
    // 转换为 Blob
    return new Promise((resolve, reject) => {
      scaledCanvas.toBlob(
        (blob) => {
          if (blob) {
            resolve({
              blob,
              dataUrl: scaledCanvas.toDataURL(`image/${this.format}`, this.quality),
              width: scaledCanvas.width,
              height: scaledCanvas.height,
              format: this.format
            });
          } else {
            reject(new Error('Failed to create blob'));
          }
        },
        `image/${this.format}`,
        this.quality
      );
    });
  }

  /**
   * 缩放 Canvas
   */
  _scaleCanvas(canvas) {
    let { width, height } = canvas;
    
    if (width > this.maxWidth || height > this.maxHeight) {
      const ratio = Math.min(this.maxWidth / width, this.maxHeight / height);
      width = Math.floor(width * ratio);
      height = Math.floor(height * ratio);
    }

    if (width === canvas.width && height === canvas.height) {
      return canvas;
    }

    const scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = width;
    scaledCanvas.height = height;
    const ctx = scaledCanvas.getContext('2d');
    ctx.drawImage(canvas, 0, 0, width, height);
    
    return scaledCanvas;
  }

  /**
   * 添加水印
   */
  async addWatermark(imageData, options = {}) {
    const { text, position, opacity, logo } = { ...this.watermarkOptions, ...options };
    
    const img = await this._loadImage(imageData.dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');

    // 绘制原图
    ctx.drawImage(img, 0, 0);

    // 设置水印样式
    ctx.globalAlpha = opacity;
    ctx.font = `${this.watermarkOptions.fontSize}px Arial`;
    
    const textWidth = ctx.measureText(text).width;
    const padding = this.watermarkOptions.padding;
    const boxWidth = textWidth + padding * 2;
    const boxHeight = this.watermarkOptions.fontSize + padding * 2;

    // 计算位置
    let x, y;
    switch (position) {
      case 'top-left':
        x = padding;
        y = padding;
        break;
      case 'top-right':
        x = canvas.width - boxWidth - padding;
        y = padding;
        break;
      case 'bottom-left':
        x = padding;
        y = canvas.height - boxHeight - padding;
        break;
      case 'bottom-right':
      default:
        x = canvas.width - boxWidth - padding;
        y = canvas.height - boxHeight - padding;
        break;
    }

    // 绘制背景
    ctx.fillStyle = this.watermarkOptions.backgroundColor;
    ctx.fillRect(x, y, boxWidth, boxHeight);

    // 绘制文字
    ctx.fillStyle = this.watermarkOptions.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padding, y + boxHeight / 2);

    ctx.globalAlpha = 1;

    return {
      dataUrl: canvas.toDataURL(`image/${this.format}`, this.quality),
      width: canvas.width,
      height: canvas.height
    };
  }

  /**
   * 添加玩家信息栏
   */
  async addPlayerInfo(imageData, playerInfo) {
    const { username, level, timestamp = Date.now() } = playerInfo;
    
    const img = await this._loadImage(imageData.dataUrl);
    const canvas = document.createElement('canvas');
    const infoBarHeight = 60;
    canvas.width = img.width;
    canvas.height = img.height + infoBarHeight;
    const ctx = canvas.getContext('2d');

    // 绘制原图
    ctx.drawImage(img, 0, 0);

    // 绘制信息栏背景
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, img.height, canvas.width, infoBarHeight);

    // 绘制玩家信息
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    
    const dateStr = new Date(timestamp).toLocaleString();
    ctx.fillText(`${username} | Lv.${level} | ${dateStr}`, 16, img.height + infoBarHeight / 2);

    // 绘制 mineGo logo
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#00d4ff';
    ctx.fillText('mineGo', canvas.width - 16, img.height + infoBarHeight / 2);

    return {
      dataUrl: canvas.toDataURL(`image/${this.format}`, this.quality),
      width: canvas.width,
      height: canvas.height
    };
  }

  /**
   * 加载图片
   */
  _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  /**
   * 获取分享场景预设
   */
  getScenePreset(scene) {
    const presets = {
      catch: {
        watermark: { text: 'mineGo Catch!', position: 'bottom-right' },
        showPlayerInfo: true,
        format: 'jpeg',
        quality: 0.92
      },
      achievement: {
        watermark: { text: 'mineGo Achievement', position: 'top-right' },
        showPlayerInfo: true,
        format: 'png',
        quality: 1
      },
      battle: {
        watermark: { text: 'mineGo Battle', position: 'bottom-left' },
        showPlayerInfo: true,
        format: 'jpeg',
        quality: 0.90
      },
      pokedex: {
        watermark: { text: 'mineGo Pokedex', position: 'bottom-right' },
        showPlayerInfo: true,
        format: 'jpeg',
        quality: 0.88
      },
      friend: {
        watermark: { text: 'mineGo Friends', position: 'bottom-right' },
        showPlayerInfo: true,
        format: 'jpeg',
        quality: 0.90
      },
      custom: {
        watermark: { text: 'mineGo', position: 'bottom-right' },
        showPlayerInfo: false,
        format: 'jpeg',
        quality: 0.92
      }
    };
    return presets[scene] || presets.custom;
  }
}

// 导出单例
module.exports = new ScreenshotCapture();
module.exports.ScreenshotCapture = ScreenshotCapture;
