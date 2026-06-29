'use strict';

/**
 * CAPTCHA 挑战生成器
 * 支持滑动验证、图形点选、数字计算等多种验证类型
 */

class CaptchaChallengeGenerator {
  constructor(config = {}) {
    this.config = {
      slideGridSizes: { low: 3, medium: 3, high: 4 },
      clickGridSizes: { low: 5, medium: 5, high: 6 },
      calculateRanges: {
        low: { min: 1, max: 10 },
        medium: { min: 10, max: 50 },
        high: { min: 50, max: 100 }
      },
      charSets: {
        low: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
        medium: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz',
        high: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz!@#$%&*'
      },
      sessionTimeout: 300, // 5分钟
      ...config
    };
  }

  /**
   * 生成验证挑战
   * @param {string} difficulty - 难度级别 (low|medium|high)
   * @returns {Object} 挑战数据
   */
  generate(difficulty) {
    const validDifficulties = ['low', 'medium', 'high'];
    if (!validDifficulties.includes(difficulty)) {
      difficulty = 'medium';
    }

    // 根据难度选择验证类型
    const typeMap = {
      low: ['slide'],
      medium: ['slide', 'click'],
      high: ['slide', 'click', 'calculate']
    };

    const availableTypes = typeMap[difficulty];
    const selectedType = availableTypes[Math.floor(Math.random() * availableTypes.length)];

    switch (selectedType) {
      case 'slide':
        return this.generateSlideChallenge(difficulty);
      case 'click':
        return this.generateClickChallenge(difficulty);
      case 'calculate':
        return this.generateCalculateChallenge(difficulty);
      default:
        return this.generateSlideChallenge(difficulty);
    }
  }

  /**
   * 生成滑动验证挑战
   */
  generateSlideChallenge(difficulty) {
    const gridSize = this.config.slideGridSizes[difficulty];
    const pieces = [];
    const correctSequence = [];

    // 生成拼图块
    for (let i = 0; i < gridSize * gridSize; i++) {
      pieces.push({
        id: i,
        correctPosition: i,
        currentRow: Math.floor(i / gridSize),
        currentCol: i % gridSize
      });
    }

    // 打乱拼图（确保可解）
    let shuffled = [...pieces];
    const emptyPosition = gridSize * gridSize - 1;
    
    // 随机移动模拟打乱
    const moves = this._generateSolvableMoves(gridSize, difficulty);
    for (const move of moves) {
      shuffled = this._applyMove(shuffled, move, emptyPosition, gridSize);
    }

    // 记录正确序列
    shuffled.forEach((p, i) => {
      if (p.id !== i) {
        correctSequence.push({ pieceId: p.id, targetPosition: i });
      }
    });

    // 加密答案
    const crypto = require('crypto');
    const answerHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(pieces.map(p => p.correctPosition)))
      .digest('hex');

    return {
      type: 'slide',
      difficulty,
      gridSize,
      pieces: shuffled.map((p, i) => ({
        id: p.id,
        currentRow: Math.floor(i / gridSize),
        currentCol: i % gridSize
      })),
      emptySlot: emptyPosition,
      challengeToken: crypto.randomBytes(16).toString('hex'),
      answerHash,
      expiresAt: new Date(Date.now() + this.config.sessionTimeout * 1000)
    };
  }

  /**
   * 生成图形点选挑战
   */
  generateClickChallenge(difficulty) {
    const gridSize = this.config.clickGridSizes[difficulty];
    const charSet = this.config.charSets[difficulty];
    const targetCount = difficulty === 'high' ? 4 : 3;
    
    // 随机选择目标字符
    const targetChars = [];
    for (let i = 0; i < targetCount; i++) {
      const char = charSet[Math.floor(Math.random() * charSet.length)];
      targetChars.push(char);
    }

    // 生成网格字符
    const grid = [];
    for (let i = 0; i < gridSize * gridSize; i++) {
      grid.push(charSet[Math.floor(Math.random() * charSet.length)]);
    }

    // 确保目标字符存在
    targetChars.forEach(char => {
      const existingPositions = [];
      grid.forEach((c, i) => {
        if (c === char) existingPositions.push(i);
      });
      
      if (existingPositions.length === 0) {
        const randomPos = Math.floor(Math.random() * grid.length);
        grid[randomPos] = char;
      }
    });

    // 计算正确答案位置
    const correctPositions = [];
    targetChars.forEach((char, idx) => {
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] === char && !correctPositions.includes(i)) {
          correctPositions.push(i);
          break;
        }
      }
    });

    const crypto = require('crypto');
    const answerHash = crypto
      .createHash('sha256')
      .update(correctPositions.join(','))
      .digest('hex');

    return {
      type: 'click',
      difficulty,
      gridSize,
      grid,
      targetChars,
      sequence: true, // 需要按顺序点击
      challengeToken: crypto.randomBytes(16).toString('hex'),
      answerHash,
      expiresAt: new Date(Date.now() + this.config.sessionTimeout * 1000)
    };
  }

  /**
   * 生成数字计算挑战
   */
  generateCalculateChallenge(difficulty) {
    const range = this.config.calculateRanges[difficulty];
    const operators = difficulty === 'high' ? ['+', '-', '*'] : ['+', '-'];
    
    const a = Math.floor(Math.random() * (range.max - range.min)) + range.min;
    const b = Math.floor(Math.random() * (range.max - range.min)) + range.min;
    const op = operators[Math.floor(Math.random() * operators.length)];

    let answer;
    let question;
    
    switch (op) {
      case '+':
        answer = a + b;
        question = `${a} + ${b} = ?`;
        break;
      case '-':
        // 确保结果为正数
        const [larger, smaller] = a > b ? [a, b] : [b, a];
        answer = larger - smaller;
        question = `${larger} - ${smaller} = ?`;
        break;
      case '*':
        // 限制乘法难度
        const smallA = Math.min(a, 12);
        const smallB = Math.min(b, 12);
        answer = smallA * smallB;
        question = `${smallA} × ${smallB} = ?`;
        break;
    }

    const crypto = require('crypto');
    const answerHash = crypto
      .createHash('sha256')
      .update(String(answer))
      .digest('hex');

    // 生成干扰选项
    const options = [answer];
    while (options.length < 4) {
      const offset = Math.floor(Math.random() * 10) - 5;
      const distractor = answer + offset;
      if (distractor !== answer && !options.includes(distractor) && distractor > 0) {
        options.push(distractor);
      }
    }

    // 打乱选项顺序
    const shuffledOptions = this._shuffleArray(options);
    const correctOptionIndex = shuffledOptions.indexOf(answer);

    return {
      type: 'calculate',
      difficulty,
      question,
      options: shuffledOptions,
      challengeToken: crypto.randomBytes(16).toString('hex'),
      answerHash,
      correctOptionIndex,
      expiresAt: new Date(Date.now() + this.config.sessionTimeout * 1000)
    };
  }

  /**
   * 生成可解的移动序列
   */
  _generateSolvableMoves(gridSize, difficulty) {
    const moveCount = {
      low: 10,
      medium: 20,
      high: 30
    };
    
    const moves = [];
    const directions = ['up', 'down', 'left', 'right'];
    let lastMove = null;
    
    for (let i = 0; i < moveCount[difficulty]; i++) {
      // 避免来回移动
      const available = directions.filter(d => 
        d !== this._oppositeDirection(lastMove)
      );
      moves.push(available[Math.floor(Math.random() * available.length)]);
      lastMove = moves[moves.length - 1];
    }
    
    return moves;
  }

  /**
   * 获取相反方向
   */
  _oppositeDirection(dir) {
    const opposites = { up: 'down', down: 'up', left: 'right', right: 'left' };
    return opposites[dir];
  }

  /**
   * 应用移动
   */
  _applyMove(pieces, move, emptyPos, gridSize) {
    const emptyRow = Math.floor(emptyPos / gridSize);
    const emptyCol = emptyPos % gridSize;
    
    let swapRow = emptyRow;
    let swapCol = emptyCol;
    
    switch (move) {
      case 'up': swapRow = emptyRow + 1; break;
      case 'down': swapRow = emptyRow - 1; break;
      case 'left': swapCol = emptyCol + 1; break;
      case 'right': swapCol = emptyCol - 1; break;
    }
    
    if (swapRow < 0 || swapRow >= gridSize || swapCol < 0 || swapCol >= gridSize) {
      return pieces;
    }
    
    const swapPos = swapRow * gridSize + swapCol;
    const newPieces = [...pieces];
    [newPieces[emptyPos], newPieces[swapPos]] = [newPieces[swapPos], newPieces[emptyPos]];
    
    return newPieces;
  }

  /**
   * 打乱数组
   */
  _shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
}

module.exports = CaptchaChallengeGenerator;
