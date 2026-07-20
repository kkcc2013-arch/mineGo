/**
 * 战斗房间管理器
 * REQ-00262: 实时对战 WebSocket 连接系统
 * 
 * 功能：
 * - 房间创建和管理
 * - 玩家加入/离开
 * - 战斗动作处理
 * - 断线状态管理
 * - 房间超时清理
 */

const { v4: uuidv4 } = require('uuid');
const { logger } = require('../../../../shared');

class BattleRoomManager {
  constructor(wsServer) {
    this.wsServer = wsServer;
    this.rooms = new Map(); // roomId -> BattleRoom
    this.userRooms = new Map(); // userId -> roomId
    
    // 配置
    this.maxRooms = parseInt(process.env.MAX_BATTLE_ROOMS) || 1000;
    this.roomTimeout = parseInt(process.env.ROOM_TIMEOUT_MS) || 30 * 60 * 1000; // 30分钟
    this.reconnectWindow = parseInt(process.env.RECONNECT_WINDOW_MS) || 5 * 60 * 1000; // 5分钟
    
    // 启动定期清理
    this.startCleanupTask();
  }

  async joinRoom(ws, payload) {
    const { roomId, battleType, pokemonTeam } = payload;
    
    // 验证房间 ID
    if (!roomId || typeof roomId !== 'string') {
      throw new Error('Invalid roomId');
    }
    
    // 检查房间容量
    if (this.rooms.size >= this.maxRooms && !this.rooms.has(roomId)) {
      throw new Error('Maximum rooms reached');
    }
    
    // 获取或创建房间
    let room = this.rooms.get(roomId);
    if (!room) {
      room = this.createRoom(roomId, battleType);
    }
    
    // 检查房间是否已满
    if (room.isFull()) {
      throw new Error('Room is full');
    }
    
    // 检查玩家是否已在其他房间
    const existingRoomId = this.userRooms.get(ws.userId);
    if (existingRoomId && existingRoomId !== roomId) {
      // 自动离开旧房间
      const oldWs = { userId: ws.userId };
      await this.leaveRoom(oldWs, { roomId: existingRoomId });
    }
    
    // 加入房间
    const sessionId = await room.addPlayer(ws.userId, ws, pokemonTeam);
    this.userRooms.set(ws.userId, roomId);
    
    // 发送加入成功消息
    this.sendToClient(ws, {
      type: 'JOINED_ROOM',
      payload: {
        roomId,
        sessionId,
        battleType: room.battleType,
        players: room.getPlayers(),
        gameState: room.getGameState(),
        yourPosition: room.getPlayerPosition(ws.userId)
      }
    });
    
    // 广播给其他玩家
    this.broadcastToRoom(roomId, {
      type: 'PLAYER_JOINED',
      payload: {
        userId: ws.userId,
        playerInfo: room.getPlayerInfo(ws.userId)
      }
    }, ws.userId);
    
    logger.info({ 
      roomId, 
      userId: ws.userId, 
      battleType,
      playerCount: room.getPlayerCount()
    }, 'Player joined room');
    
    // 如果房间满了，开始战斗
    if (room.isFull() && room.state === 'WAITING') {
      await this.startBattle(roomId);
    }
  }

  async leaveRoom(ws, payload) {
    const roomId = payload?.roomId || this.userRooms.get(ws.userId);
    
    if (!roomId) {
      throw new Error('Player not in a room');
    }
    
    const room = this.rooms.get(roomId);
    if (!room) {
      this.userRooms.delete(ws.userId);
      throw new Error('Room not found');
    }
    
    const playerInfo = room.getPlayerInfo(ws.userId);
    await room.removePlayer(ws.userId);
    this.userRooms.delete(ws.userId);
    
    // 广播离开消息
    this.broadcastToRoom(roomId, {
      type: 'PLAYER_LEFT',
      payload: { 
        userId: ws.userId,
        reason: payload?.reason || 'voluntary'
      }
    });
    
    // 如果房间为空，删除房间
    if (room.isEmpty()) {
      this.rooms.delete(roomId);
      logger.info({ roomId }, 'Room deleted (empty)');
    } else if (room.state === 'IN_PROGRESS') {
      // 战斗中断，对方获胜
      await this.endBattle(roomId, {
        winner: Array.from(room.players.keys())[0],
        reason: 'opponent_left'
      });
    }
    
    logger.info({ 
      roomId, 
      userId: ws.userId 
    }, 'Player left room');
  }

  async handleBattleAction(ws, payload) {
    const { action, data } = payload;
    const roomId = this.userRooms.get(ws.userId);
    
    if (!roomId) {
      throw new Error('Player not in a room');
    }
    
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error('Room not found');
    }
    
    if (room.state !== 'IN_PROGRESS') {
      throw new Error('Battle not in progress');
    }
    
    // 验证是否轮到该玩家
    if (!room.isPlayerTurn(ws.userId)) {
      throw new Error('Not your turn');
    }
    
    // 处理动作
    const result = await room.processAction(ws.userId, action, data);
    
    // 广播战斗结果
    this.broadcastToRoom(roomId, {
      type: 'BATTLE_ACTION_RESULT',
      payload: {
        playerId: ws.userId,
        action,
        result,
        gameState: room.getGameState()
      }
    });
    
    // 检查战斗是否结束
    if (result.battleEnded) {
      await this.endBattle(roomId, result.battleResult);
    }
  }

  handleDisconnect(ws) {
    const roomId = this.userRooms.get(ws.userId);
    if (!roomId) return;
    
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    // 标记玩家为断线状态
    room.markDisconnected(ws.userId);
    
    // 广播断线事件
    this.broadcastToRoom(roomId, {
      type: 'PLAYER_DISCONNECTED',
      payload: { 
        userId: ws.userId,
        reconnectWindow: this.reconnectWindow
      }
    }, ws.userId);
    
    logger.info({ 
      roomId, 
      userId: ws.userId 
    }, 'Player disconnected from room');
  }

  createRoom(roomId, battleType) {
    const room = new BattleRoom(roomId, battleType, this.reconnectWindow);
    this.rooms.set(roomId, room);
    
    // 设置房间超时
    const timeoutId = setTimeout(() => {
      if (this.rooms.has(roomId)) {
        this.closeRoom(roomId, 'TIMEOUT');
      }
    }, this.roomTimeout);
    
    room.timeoutId = timeoutId;
    
    logger.info({ roomId, battleType }, 'Room created');
    return room;
  }

  async startBattle(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    room.state = 'IN_PROGRESS';
    room.startedAt = Date.now();
    
    // 广播战斗开始
    this.broadcastToRoom(roomId, {
      type: 'BATTLE_STARTED',
      payload: {
        roomId,
        players: room.getPlayers(),
        gameState: room.getGameState(),
        startTime: room.startedAt
      }
    });
    
    logger.info({ roomId }, 'Battle started');
  }

  async endBattle(roomId, result) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    room.state = 'ENDED';
    room.endedAt = Date.now();
    room.result = result;
    
    // 广播战斗结束
    this.broadcastToRoom(roomId, {
      type: 'BATTLE_ENDED',
      payload: {
        roomId,
        result,
        duration: room.endedAt - room.startedAt
      }
    });
    
    logger.info({ roomId, result }, 'Battle ended');
    
    // 延迟删除房间（给玩家查看结果的时间）
    setTimeout(() => {
      if (this.rooms.has(roomId)) {
        this.closeRoom(roomId, 'BATTLE_ENDED');
      }
    }, 60000);
  }

  closeRoom(roomId, reason) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    // 清除超时定时器
    if (room.timeoutId) {
      clearTimeout(room.timeoutId);
    }
    
    // 通知所有玩家
    this.broadcastToRoom(roomId, {
      type: 'ROOM_CLOSED',
      payload: { reason }
    });
    
    // 清理用户映射
    for (const userId of room.players.keys()) {
      this.userRooms.delete(userId);
    }
    
    this.rooms.delete(roomId);
    logger.info({ roomId, reason }, 'Room closed');
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  getRoomCount() {
    return this.rooms.size;
  }

  broadcastToRoom(roomId, message, excludeUserId = null) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    for (const [userId, player] of room.players) {
      if (excludeUserId && userId === excludeUserId) continue;
      
      if (player.ws && player.ws.readyState === 1) { // WebSocket.OPEN
        this.sendToClient(player.ws, message);
      }
    }
  }

  sendToClient(ws, message) {
    if (this.wsServer && typeof this.wsServer.sendMessage === 'function') {
      this.wsServer.sendMessage(ws, message);
    } else if (ws.send) {
      ws.send(JSON.stringify(message));
    }
  }

  startCleanupTask() {
    // 每分钟检查一次过期房间
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleRooms();
    }, 60000);
  }

  cleanupStaleRooms() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [roomId, room] of this.rooms) {
      // 检查是否所有玩家都断线超过重连时间
      const allDisconnected = Array.from(room.players.values())
        .every(p => !p.connected && 
                    p.disconnectedAt && 
                    (now - p.disconnectedAt) > this.reconnectWindow);
      
      if (allDisconnected) {
        this.closeRoom(roomId, 'ALL_DISCONNECTED');
        cleaned++;
      }
      
      // 检查房间是否超时
      if (room.createdAt && (now - room.createdAt) > this.roomTimeout) {
        this.closeRoom(roomId, 'TIMEOUT');
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale rooms');
    }
  }

  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // 关闭所有房间
    for (const roomId of this.rooms.keys()) {
      this.closeRoom(roomId, 'SERVER_SHUTDOWN');
    }
  }
}

class BattleRoom {
  constructor(roomId, battleType, reconnectWindow) {
    this.roomId = roomId;
    this.battleType = battleType;
    this.reconnectWindow = reconnectWindow;
    this.players = new Map();
    this.sessions = new Map();
    this.state = 'WAITING'; // WAITING, IN_PROGRESS, ENDED
    this.createdAt = Date.now();
    this.startedAt = null;
    this.endedAt = null;
    this.result = null;
    this.timeoutId = null;
    this.maxPlayers = battleType === 'team_battle' ? 4 : 2;
    
    // 战斗状态
    this.gameState = {
      turn: 0,
      currentPlayer: 0,
      phase: 'select_action', // select_action, execute, result
      weather: null,
      terrain: null
    };
    
    // 动作队列
    this.actionQueue = [];
  }

  async addPlayer(userId, ws, pokemonTeam = []) {
    if (this.players.size >= this.maxPlayers) {
      throw new Error('Room is full');
    }
    
    const sessionId = uuidv4();
    const position = this.players.size;
    
    this.players.set(userId, {
      ws,
      sessionId,
      connected: true,
      joinedAt: Date.now(),
      position,
      pokemonTeam,
      activePokemon: pokemonTeam[0] || null,
      isReady: false
    });
    
    this.sessions.set(sessionId, { 
      userId,
      createdAt: Date.now()
    });
    
    return sessionId;
  }

  async removePlayer(userId) {
    this.players.delete(userId);
    
    // 清除相关会话
    for (const [sessionId, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(sessionId);
      }
    }
  }

  markDisconnected(userId) {
    const player = this.players.get(userId);
    if (player) {
      player.connected = false;
      player.ws = null;
      player.disconnectedAt = Date.now();
    }
  }

  async reconnectPlayer(ws, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    
    const player = this.players.get(session.userId);
    if (!player) {
      throw new Error('Player not found');
    }
    
    // 检查是否在重连窗口内
    if (player.disconnectedAt && 
        (Date.now() - player.disconnectedAt) > this.reconnectWindow) {
      throw new Error('Reconnect window expired');
    }
    
    player.ws = ws;
    player.connected = true;
    player.sessionId = sessionId;
    delete player.disconnectedAt;
    
    return player;
  }

  async processAction(userId, action, data) {
    const player = this.players.get(userId);
    if (!player) {
      throw new Error('Player not found');
    }
    
    const result = {
      action,
      success: true,
      data: {},
      battleEnded: false,
      battleResult: null
    };
    
    // 根据动作类型处理
    switch (action) {
      case 'SELECT_MOVE':
        // 选择技能
        result.data.selectedMove = data.moveId;
        break;
        
      case 'SELECT_POKEMON':
        // 切换精灵
        player.activePokemon = data.pokemonId;
        result.data.switchedTo = data.pokemonId;
        break;
        
      case 'USE_ITEM':
        // 使用道具
        result.data.itemUsed = data.itemId;
        break;
        
      case 'FLEE':
        // 逃跑
        result.battleEnded = true;
        result.battleResult = {
          winner: this.getOpponent(userId),
          reason: 'flee'
        };
        break;
        
      case 'READY':
        // 准备就绪
        player.isReady = true;
        break;
        
      default:
        result.success = false;
        result.data.error = 'Unknown action';
    }
    
    // 更新游戏状态
    this.gameState.turn++;
    
    return result;
  }

  getOpponent(userId) {
    for (const [id] of this.players) {
      if (id !== userId) return id;
    }
    return null;
  }

  isPlayerTurn(userId) {
    const player = this.players.get(userId);
    return player && this.gameState.currentPlayer === player.position;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getPlayers() {
    return Array.from(this.players.entries()).map(([userId, player]) => ({
      userId,
      connected: player.connected,
      position: player.position,
      isReady: player.isReady,
      activePokemon: player.activePokemon
    }));
  }

  getPlayerInfo(userId) {
    const player = this.players.get(userId);
    return player ? {
      userId,
      connected: player.connected,
      position: player.position,
      activePokemon: player.activePokemon
    } : null;
  }

  getPlayerPosition(userId) {
    const player = this.players.get(userId);
    return player ? player.position : -1;
  }

  getPlayerCount() {
    return this.players.size;
  }

  getGameState() {
    return {
      ...this.gameState,
      roomId: this.roomId,
      battleType: this.battleType,
      state: this.state
    };
  }

  isFull() {
    return this.players.size >= this.maxPlayers;
  }

  isEmpty() {
    return this.players.size === 0;
  }
}

module.exports = { BattleRoomManager, BattleRoom };
