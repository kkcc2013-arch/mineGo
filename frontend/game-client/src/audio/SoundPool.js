/**
 * SoundPool - 音效池管理
 * 管理音效的缓存、加载、播放
 */

class SoundPool {
  constructor(maxSize = 50) {
    this.pool = new Map();
    this.maxSize = maxSize;
    this.loadingPromises = new Map();
  }

  /**
   * 获取音效
   * @param {string} name - 音效名称
   */
  get(name) {
    return this.pool.get(name);
  }

  /**
   * 设置音效
   * @param {string} name - 音效名称
   * @param {AudioBuffer} buffer - 音频缓冲区
   */
  set(name, buffer) {
    // 检查池大小限制
    if (this.pool.size >= this.maxSize && !this.pool.has(name)) {
      // 移除最旧的音效（简单的 LRU 策略）
      const firstKey = this.pool.keys().next().value;
      this.pool.delete(firstKey);
    }

    this.pool.set(name, buffer);
  }

  /**
   * 检查音效是否存在
   * @param {string} name - 音效名称
   */
  has(name) {
    return this.pool.has(name);
  }

  /**
   * 删除音效
   * @param {string} name - 音效名称
   */
  delete(name) {
    return this.pool.delete(name);
  }

  /**
   * 清空池
   */
  clear() {
    this.pool.clear();
    this.loadingPromises.clear();
  }

  /**
   * 获取池大小
   */
  size() {
    return this.pool.size;
  }

  /**
   * 获取所有音效名称
   */
  keys() {
    return Array.from(this.pool.keys());
  }

  /**
   * 预加载音效
   * @param {Object} audioContext - AudioContext 实例
   * @param {Object} soundList - 音效列表 { name: path }
   */
  async preload(audioContext, soundList) {
    const promises = [];

    for (const [name, path] of Object.entries(soundList)) {
      // 如果已存在，跳过
      if (this.pool.has(name)) {
        continue;
      }

      // 如果正在加载，等待加载完成
      if (this.loadingPromises.has(name)) {
        promises.push(this.loadingPromises.get(name));
        continue;
      }

      // 开始加载
      const loadPromise = this.loadSound(audioContext, name, path);
      this.loadingPromises.set(name, loadPromise);
      promises.push(loadPromise);
    }

    await Promise.all(promises);
  }

  /**
   * 加载单个音效
   * @param {Object} audioContext - AudioContext 实例
   * @param {string} name - 音效名称
   * @param {string} path - 文件路径
   */
  async loadSound(audioContext, name, path) {
    try {
      const response = await fetch(path);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      this.set(name, audioBuffer);
      this.loadingPromises.delete(name);

      console.log(`[SoundPool] Loaded: ${name}`);
      return audioBuffer;
    } catch (error) {
      this.loadingPromises.delete(name);
      console.error(`[SoundPool] Failed to load ${name}:`, error);
      throw error;
    }
  }

  /**
   * 批量释放未使用的音效
   * @param {string[]} keepList - 需要保留的音效名称
   */
  releaseUnused(keepList) {
    const keepSet = new Set(keepList);
    
    for (const name of this.pool.keys()) {
      if (!keepSet.has(name)) {
        this.pool.delete(name);
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalSounds: this.pool.size,
      maxSize: this.maxSize,
      loadingCount: this.loadingPromises.size,
      sounds: this.keys()
    };
  }
}

module.exports = SoundPool;
