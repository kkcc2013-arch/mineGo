/**
 * CAPTCHA Challenge Generator
 * 风险触发式人机验证挑战生成器
 * 
 * REQ-00064: 风险触发式人机验证（CAPTCHA）系统
 */

const crypto = require('crypto');

/**
 * 验证挑战生成器类
 */
class CaptchaChallengeGenerator {
  constructor() {
    // 字符集配置
    this.charSets = {
      low: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split(''),
      medium: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz'.split(''),
      high: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz!@#$%&*'.split('')
    };
    
    // 计算范围配置
    this.calculateRanges = {
      low: { min: 1, max: 10 },
      medium: { min: 10, max: 50 },
      high: { min: 50, max: 100 }
    };
    
    // 网格大小配置
    this.gridSizes = {
      low: 3,
      medium: 3,
      high: 4
    };
    
    // 目标字符数量配置
    this.targetCounts = {
      low: 3,
      medium: 3,
      high: 4
    };
  }

  /**
   * 生成验证挑战
   * @param {string} type - 验证类型 (slide, click, calculate)
   * @param {string} difficulty - 难度 (low, medium, high)
   * @returns {Object} 挑战数据
   */
  generate(type, difficulty) {
    switch (type) {
      case 'slide':
        return this.generateSlideChallenge(difficulty);
      case 'click':
        return this.generateClickChallenge(difficulty);
      case 'calculate':
        return this.generateCalculateChallenge(difficulty);
      default:
        throw new Error(`Unknown captcha type: ${type}`);
    }
  }

  /**
   * 生成滑动验证挑战
   * @param {string} difficulty - 难度
   * @returns {Object} 滑动挑战数据
   */
  generateSlideChallenge(difficulty) {
    const gridSize = this.gridSizes[difficulty];
    const totalPieces = gridSize * gridSize;
    const pieces = [];
    
    // 生成拼图块
    for (let i = 0; i < totalPieces; i++) {
      pieces.push({
        id: i,
        correctPosition: i
      });
    }
    
    // 打乱位置
    const shuffled = this.shuffleArray([...pieces]);
    shuffled.forEach((p, i) => p.shufflePosition = i);
    
    // 选择一个空位作为目标（通常选择最后一个）
    const emptySlotIndex = shuffled.length - 1;
    const emptySlot = shuffled[emptySlotIndex].correctPosition;
    
    // 生成验证答案：需要移动的块的正确顺序
    const expectedOrder = shuffled.slice(0, -1).map(p => p.id);
    
    return {
      type: 'slide',
      gridSize,
      pieces: shuffled.slice(0, -1), // 不包含最后一块
      emptySlot,
      difficulty,
      expectedAnswer: {
        pieceOrder: expectedOrder,
        emptyPosition: emptySlot
      }
    };
  }

  /**
   * 生成图形点选挑战
   * @param {string} difficulty - 难度
   * @returns {Object} 点选挑战数据
   */
  generateClickChallenge(difficulty) {
    const gridSize = this.gridSizes[difficulty] + 2; // 点选用稍大的网格
    const targetCount = this.targetCounts[difficulty];
    const chars = this.charSets[difficulty];
    
    // 随机选择目标字符（可能有重复）
    const targetChars = [];
    for (let i = 0; i < targetCount; i++) {
      targetChars.push(chars[Math.floor(Math.random() * chars.length)]);
    }
    
    // 生成网格
    const grid = [];
    for (let i = 0; i < gridSize * gridSize; i++) {
      grid.push(chars[Math.floor(Math.random() * chars.length)]);
    }
    
    // 确保目标字符存在于网格中
    const targetPositions = [];
    targetChars.forEach((char, idx) => {
      // 查找是否已存在
      let found = false;
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] === char && !targetPositions.includes(i)) {
          targetPositions.push(i);
          found = true;
          break;
        }
      }
      // 如果不存在，随机放置
      if (!found) {
        let pos;
        do {
          pos = Math.floor(Math.random() * grid.length);
        } while (targetPositions.includes(pos));
        grid[pos] = char;
        targetPositions.push(pos);
      }
    });
    
    return {
      type: 'click',
      gridSize,
      chars: grid,
      targetChars,
      sequence: difficulty !== 'low', // 中高难度需要按顺序
      difficulty,
      expectedAnswer: {
        positions: targetPositions,
        chars: targetChars
      }
    };
  }

  /**
   * 生成数字计算挑战
   * @param {string} difficulty - 难度
   * @returns {Object} 计算挑战数据
   */
  generateCalculateChallenge(difficulty) {
    const range = this.calculateRanges[difficulty];
    const operators = difficulty === 'high' ? ['+', '-', '*'] : ['+', '-'];
    
    const a = Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
    const b = Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
    const op = operators[Math.floor(Math.random() * operators.length)];
    
    let answer;
    switch (op) {
      case '+':
        answer = a + b;
        break;
      case '-':
        answer = a - b;
        break;
      case '*':
        answer = a * b;
        break;
    }
    
    const question = `${a} ${op} ${b} = ?`;
    
    // 生成干扰选项
    const options = [answer];
    while (options.length < 4) {
      const offset = Math.floor(Math.random() * 20) - 10;
      const wrongAnswer = answer + offset;
      if (wrongAnswer !== answer && !options.includes(wrongAnswer)) {
        options.push(wrongAnswer);
      }
    }
    
    // 打乱选项顺序
    const shuffledOptions = this.shuffleArray(options);
    const correctIndex = shuffledOptions.indexOf(answer);
    
    return {
      type: 'calculate',
      question,
      options: shuffledOptions,
      difficulty,
      expectedAnswer: {
        value: answer,
        optionIndex: correctIndex
      }
    };
  }

  /**
   * 根据难度获取验证类型
   * @param {string} difficulty - 难度
   * @returns {string[]} 验证类型列表
   */
  getTypesForDifficulty(difficulty) {
    const mapping = {
      low: ['slide'],
      medium: ['slide', 'click'],
      high: ['slide', 'click', 'calculate']
    };
    return mapping[difficulty] || mapping.low;
  }

  /**
   * 随机选择验证类型
   * @param {string} difficulty - 难度
   * @returns {string} 验证类型
   */
  selectRandomType(difficulty) {
    const types = this.getTypesForDifficulty(difficulty);
    return types[Math.floor(Math.random() * types.length)];
  }

  /**
   * 打乱数组
   * @param {Array} array - 原数组
   * @returns {Array} 打乱后的数组
   */
  shuffleArray(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /**
   * 加密挑战数据
   * @param {Object} data - 原始数据
   * @param {string} secret - 加密密钥
   * @returns {string} 加密后的数据
   */
  encryptChallengeData(data, secret) {
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(secret, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
  }

  /**
   * 解密挑战数据
   * @param {string} encryptedData - 加密数据
   * @param {string} secret - 解密密钥
   * @returns {Object} 解密后的数据
   */
  decryptChallengeData(encryptedData, secret) {
    const [ivHex, encrypted] = encryptedData.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.scryptSync(secret, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  }
}

module.exports = CaptchaChallengeGenerator;
