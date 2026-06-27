/**
 * MusicPlayer - 背景音乐播放器
 * 管理背景音乐的播放、淡入淡出、循环控制
 */

class MusicPlayer {
  constructor() {
    this.audioElement = null;
    this.currentTrack = null;
    this.isPlaying = false;
    this.volume = 0.6;
    this.targetVolume = 0.6;
    this.fadeDuration = 1000;
    this.crossfadeEnabled = true;
    
    this.createAudioElement();
  }

  /**
   * 创建 Audio 元素
   */
  createAudioElement() {
    this.audioElement = new Audio();
    this.audioElement.loop = true;
    this.audioElement.volume = 0;
    
    // 监听事件
    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
      this.currentTrack = null;
    });

    this.audioElement.addEventListener('error', (e) => {
      console.error('[MusicPlayer] Audio error:', e);
      this.isPlaying = false;
    });
  }

  /**
   * 播放音乐
   * @param {string} track - 音乐文件路径
   * @param {Object} options - 播放选项
   */
  async play(track, options = {}) {
    const {
      fadeIn = true,
      loop = true,
      restart = false
    } = options;

    // 如果正在播放同一首且不强制重新开始
    if (this.currentTrack === track && this.isPlaying && !restart) {
      return;
    }

    // 淡出当前音乐
    if (this.isPlaying && fadeIn) {
      await this.fadeOut(this.fadeDuration);
    }

    // 停止当前播放
    this.stop();

    // 设置新音乐
    this.audioElement.src = track;
    this.audioElement.loop = loop;
    this.currentTrack = track;

    try {
      // 播放
      await this.audioElement.play();
      this.isPlaying = true;

      // 淡入
      if (fadeIn) {
        await this.fadeIn(this.fadeDuration);
      } else {
        this.audioElement.volume = this.volume;
      }

      console.log('[MusicPlayer] Playing:', track);
    } catch (error) {
      console.error('[MusicPlayer] Failed to play:', error);
      this.isPlaying = false;
      throw error;
    }
  }

  /**
   * 暂停
   */
  pause() {
    if (this.audioElement && this.isPlaying) {
      this.audioElement.pause();
      this.isPlaying = false;
    }
  }

  /**
   * 恢复
   */
  async resume() {
    if (this.audioElement && this.currentTrack && !this.isPlaying) {
      try {
        await this.audioElement.play();
        this.isPlaying = true;
        console.log('[MusicPlayer] Resumed');
      } catch (error) {
        console.error('[MusicPlayer] Failed to resume:', error);
      }
    }
  }

  /**
   * 停止
   */
  stop() {
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
      this.isPlaying = false;
      this.currentTrack = null;
    }
  }

  /**
   * 设置音量
   * @param {number} value - 音量值 (0-1)
   */
  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    this.targetVolume = this.volume;
    
    if (this.audioElement && this.isPlaying) {
      this.audioElement.volume = this.volume;
    }
  }

  /**
   * 淡入
   * @param {number} duration - 淡入时长（毫秒）
   */
  fadeIn(duration) {
    return new Promise((resolve) => {
      if (!this.audioElement || !this.isPlaying) {
        resolve();
        return;
      }

      const targetVolume = this.volume;
      const startTime = Date.now();
      const startVolume = this.audioElement.volume;

      const fadeInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // 使用缓动函数
        const easedProgress = this.easeInOutCubic(progress);
        this.audioElement.volume = startVolume + (targetVolume - startVolume) * easedProgress;

        if (progress >= 1) {
          clearInterval(fadeInterval);
          this.audioElement.volume = targetVolume;
          resolve();
        }
      }, 16); // 约 60fps
    });
  }

  /**
   * 淡出
   * @param {number} duration - 淡出时长（毫秒）
   */
  fadeOut(duration) {
    return new Promise((resolve) => {
      if (!this.audioElement || !this.isPlaying) {
        resolve();
        return;
      }

      const startTime = Date.now();
      const startVolume = this.audioElement.volume;

      const fadeInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // 使用缓动函数
        const easedProgress = this.easeInOutCubic(progress);
        this.audioElement.volume = startVolume * (1 - easedProgress);

        if (progress >= 1) {
          clearInterval(fadeInterval);
          this.audioElement.pause();
          this.isPlaying = false;
          resolve();
        }
      }, 16);
    });
  }

  /**
   * 缓动函数（缓入缓出）
   * @param {number} t - 进度 (0-1)
   */
  easeInOutCubic(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /**
   * 交叉淡入淡出到新音乐
   * @param {string} newTrack - 新音乐文件路径
   * @param {number} duration - 交叉淡入淡出时长（毫秒）
   */
  async crossfade(newTrack, duration = 2000) {
    if (!this.crossfadeEnabled) {
      await this.play(newTrack, { fadeIn: true });
      return;
    }

    // 同时淡出当前音乐和淡入新音乐
    const fadeOutPromise = this.fadeOut(duration / 2);
    
    setTimeout(async () => {
      await this.play(newTrack, { fadeIn: true, restart: true });
    }, duration / 2);

    await fadeOutPromise;
  }

  /**
   * 获取当前播放状态
   */
  getStatus() {
    return {
      isPlaying: this.isPlaying,
      currentTrack: this.currentTrack,
      volume: this.volume,
      currentTime: this.audioElement ? this.audioElement.currentTime : 0,
      duration: this.audioElement ? this.audioElement.duration : 0
    };
  }

  /**
   * 跳转到指定时间
   * @param {number} time - 时间（秒）
   */
  seek(time) {
    if (this.audioElement && time >= 0 && time <= this.audioElement.duration) {
      this.audioElement.currentTime = time;
    }
  }
}

module.exports = MusicPlayer;
