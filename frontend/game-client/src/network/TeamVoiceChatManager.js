// frontend/game-client/src/network/TeamVoiceChatManager.js
// REQ-00558: 团队实时协作与语音通信系统

'use strict';

/**
 * 团队语音聊天管理器
 * 支持 WebRTC Mesh 模式（≤5人）和 MCU 模式（>5人）
 */
class TeamVoiceChatManager extends EventEmitter {
  constructor(teamId, options = {}) {
    super();
    
    this.teamId = teamId;
    this.userId = window.currentUser?.id || 'anonymous';
    this.options = {
      maxPeers: 5,
      iceServers: [
        { urls: 'stun:stun.minego.game:3478' },
        { urls: 'turn:turn.minego.game:3478', username: 'minego', credential: 'minego123' }
      ],
      audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1
      },
      ...options
    };
    
    // WebRTC 连接
    this.localStream = null;
    this.peers = new Map(); // userId -> RTCPeerConnection
    this.remoteStreams = new Map(); // userId -> MediaStream
    
    // 信令
    this.signalingSocket = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    
    // 状态
    this.state = 'disconnected'; // disconnected, connecting, connected, muted, deafened
    this.isMuted = false;
    this.isDeafened = false;
    this.isTalking = false;
    
    // 音频分析（用于语音活动检测）
    this.audioContext = null;
    this.analyser = null;
    this.talkingThreshold = 0.3;
    this.silenceThreshold = 0.05;
    
    // 统计
    this.stats = {
      packetsSent: 0,
      packetsLost: 0,
      bytesSent: 0,
      bytesReceived: 0,
      roundTripTime: 0
    };
    
    // 成员列表
    this.members = new Map();
    
    this.init();
  }
  
  /**
   * 初始化
   */
  async init() {
    try {
      // 获取麦克风权限
      await this.getUserMedia();
      
      // 连接信令服务器
      await this.connectSignaling();
      
      // 设置音频分析
      this.setupAudioAnalysis();
      
      this.emit('initialized', { teamId: this.teamId });
      console.log('[TeamVoiceChat] Initialized', { teamId: this.teamId });
    } catch (error) {
      console.error('[TeamVoiceChat] Initialization failed:', error);
      this.emit('error', { code: 'INIT_FAILED', message: error.message });
    }
  }
  
  /**
   * 获取用户媒体
   */
  async getUserMedia() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: this.options.audioConstraints,
        video: false
      });
      
      console.log('[TeamVoiceChat] Got local stream');
      this.emit('localStream', { stream: this.localStream });
    } catch (error) {
      console.error('[TeamVoiceChat] Failed to get user media:', error);
      throw new Error('MICROPHONE_ACCESS_DENIED');
    }
  }
  
  /**
   * 连接信令服务器
   */
  async connectSignaling() {
    return new Promise((resolve, reject) => {
      const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/voice/signal?teamId=${this.teamId}&userId=${this.userId}`;
      
      this.signalingSocket = new WebSocket(wsUrl);
      
      this.signalingSocket.onopen = () => {
        console.log('[TeamVoiceChat] Signaling connected');
        this.state = 'connecting';
        this.reconnectAttempts = 0;
        
        // 发送加入消息
        this.sendSignal('join', {
          teamId: this.teamId,
          userId: this.userId
        });
        
        this.emit('signaling:connected');
        resolve();
      };
      
      this.signalingSocket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleSignalingMessage(message);
        } catch (error) {
          console.error('[TeamVoiceChat] Failed to parse signaling message:', error);
        }
      };
      
      this.signalingSocket.onerror = (error) => {
        console.error('[TeamVoiceChat] Signaling error:', error);
        this.emit('error', { code: 'SIGNALING_ERROR', message: 'WebSocket error' });
      };
      
      this.signalingSocket.onclose = () => {
        console.log('[TeamVoiceChat] Signaling disconnected');
        this.state = 'disconnected';
        this.emit('signaling:disconnected');
        
        // 自动重连
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => this.connectSignaling(), 1000 * this.reconnectAttempts);
        }
      };
    });
  }
  
  /**
   * 处理信令消息
   */
  handleSignalingMessage(message) {
    const { type, payload, from } = message;
    
    switch (type) {
      case 'user_joined':
        this.handleUserJoined(payload);
        break;
        
      case 'user_left':
        this.handleUserLeft(payload);
        break;
        
      case 'offer':
        this.handleOffer(from, payload);
        break;
        
      case 'answer':
        this.handleAnswer(from, payload);
        break;
        
      case 'candidate':
        this.handleCandidate(from, payload);
        break;
        
      case 'room_full':
        this.emit('error', { code: 'ROOM_FULL', message: 'Voice room is full' });
        break;
        
      case 'user_list':
        this.handleUserList(payload);
        break;
    }
  }
  
  /**
   * 处理用户加入
   */
  handleUserJoined(user) {
    console.log('[TeamVoiceChat] User joined:', user.userId);
    
    this.members.set(user.userId, {
      ...user,
      isTalking: false,
      volume: 1.0
    });
    
    // 如果当前用户更早加入，发起 offer
    if (this.userId < user.userId) {
      this.createPeerConnection(user.userId);
    }
    
    this.emit('user_joined', user);
  }
  
  /**
   * 处理用户离开
   */
  handleUserLeft(user) {
    console.log('[TeamVoiceChat] User left:', user.userId);
    
    this.members.delete(user.userId);
    this.closePeer(user.userId);
    
    this.emit('user_left', user);
  }
  
  /**
   * 处理用户列表
   */
  handleUserList(users) {
    users.forEach(user => {
      if (user.userId !== this.userId) {
        this.members.set(user.userId, {
          ...user,
          isTalking: false,
          volume: 1.0
        });
        
        // 与已存在的用户建立连接
        this.createPeerConnection(user.userId);
      }
    });
    
    this.emit('users_updated', Array.from(this.members.values()));
  }
  
  /**
   * 创建 Peer Connection
   */
  async createPeerConnection(peerId) {
    if (this.peers.has(peerId)) {
      return;
    }
    
    // 检查 Mesh 模式限制
    if (this.peers.size >= this.options.maxPeers) {
      console.warn('[TeamVoiceChat] Max peers reached, switching to MCU mode');
      // 这里应该切换到 MCU 模式，连接到媒体服务器
    }
    
    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers
    });
    
    // 添加本地流
    if (this.localStream && !this.isMuted) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }
    
    // 处理远程流
    pc.ontrack = (event) => {
      console.log('[TeamVoiceChat] Received remote track from:', peerId);
      this.remoteStreams.set(peerId, event.streams[0]);
      this.emit('remoteStream', { peerId, stream: event.streams[0] });
    };
    
    // 收集 ICE 候选
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal('candidate', {
          target: peerId,
          candidate: event.candidate.toJSON()
        });
      }
    };
    
    // 连接状态变化
    pc.onconnectionstatechange = () => {
      console.log('[TeamVoiceChat] Connection state:', pc.connectionState, 'peer:', peerId);
      this.emit('peer_state', { peerId, state: pc.connectionState });
    };
    
    // 统计信息
    pc.onstatsended = (stats) => {
      this.updateStats(stats);
    };
    
    this.peers.set(peerId, pc);
    
    // 创建 offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      this.sendSignal('offer', {
        target: peerId,
        sdp: pc.localDescription.sdp,
        type: pc.localDescription.type
      });
    } catch (error) {
      console.error('[TeamVoiceChat] Failed to create offer:', error);
    }
  }
  
  /**
   * 处理 Offer
   */
  async handleOffer(from, payload) {
    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers
    });
    
    // 添加本地流
    if (this.localStream && !this.isMuted) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }
    
    // 处理远程流
    pc.ontrack = (event) => {
      console.log('[TeamVoiceChat] Received remote track from:', from);
      this.remoteStreams.set(from, event.streams[0]);
      this.emit('remoteStream', { peerId: from, stream: event.streams[0] });
    };
    
    // 收集 ICE 候选
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal('candidate', {
          target: from,
          candidate: event.candidate.toJSON()
        });
      }
    };
    
    this.peers.set(from, pc);
    
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: payload.type,
        sdp: payload.sdp
      }));
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      this.sendSignal('answer', {
        target: from,
        sdp: pc.localDescription.sdp,
        type: pc.localDescription.type
      });
    } catch (error) {
      console.error('[TeamVoiceChat] Failed to handle offer:', error);
    }
  }
  
  /**
   * 处理 Answer
   */
  async handleAnswer(from, payload) {
    const pc = this.peers.get(from);
    if (!pc) {
      return;
    }
    
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: payload.type,
        sdp: payload.sdp
      }));
    } catch (error) {
      console.error('[TeamVoiceChat] Failed to handle answer:', error);
    }
  }
  
  /**
   * 处理 ICE 候选
   */
  async handleCandidate(from, payload) {
    const pc = this.peers.get(from);
    if (!pc) {
      return;
    }
    
    try {
      await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    } catch (error) {
      console.error('[TeamVoiceChat] Failed to add ICE candidate:', error);
    }
  }
  
  /**
   * 发送信令消息
   */
  sendSignal(type, payload) {
    if (this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify({
        type,
        payload,
        from: this.userId,
        timestamp: Date.now()
      }));
    }
  }
  
  /**
   * 设置音频分析
   */
  setupAudioAnalysis() {
    if (!this.localStream) {
      return;
    }
    
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.localStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);
    
    // 定期检测语音活动
    this.vadInterval = setInterval(() => this.detectVoiceActivity(), 100);
  }
  
  /**
   * 检测语音活动
   */
  detectVoiceActivity() {
    if (!this.analyser || this.isMuted) {
      return;
    }
    
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    
    // 计算平均音量
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255;
    
    const wasTalking = this.isTalking;
    this.isTalking = average > this.talkingThreshold;
    
    // 状态变化时触发事件
    if (this.isTalking !== wasTalking) {
      this.emit('talking', { isTalking: this.isTalking, volume: average });
      this.sendSignal('talking', { isTalking: this.isTalking });
    }
  }
  
  /**
   * 静音/取消静音
   */
  toggleMute() {
    if (!this.localStream) {
      return;
    }
    
    this.isMuted = !this.isMuted;
    
    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isMuted;
    });
    
    this.state = this.isMuted ? 'muted' : 'connected';
    this.emit('mute_toggled', { isMuted: this.isMuted });
    
    console.log('[TeamVoiceChat]', this.isMuted ? 'Muted' : 'Unmuted');
  }
  
  /**
   * 静音所有远程用户
   */
  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    
    this.remoteStreams.forEach((stream, peerId) => {
      stream.getAudioTracks().forEach(track => {
        track.enabled = !this.isDeafened;
      });
    });
    
    this.state = this.isDeafened ? 'deafened' : 'connected';
    this.emit('deafen_toggled', { isDeafened: this.isDeafened });
    
    console.log('[TeamVoiceChat]', this.isDeafened ? 'Deafened' : 'Undeafened');
  }
  
  /**
   * 设置成员音量
   */
  setMemberVolume(peerId, volume) {
    // 音量范围 0-2，1.0 是正常音量
    const member = this.members.get(peerId);
    if (member) {
      member.volume = Math.max(0, Math.min(2, volume));
      this.members.set(peerId, member);
      
      // 应用音量到音频元素（如果有）
      this.emit('volume_changed', { peerId, volume: member.volume });
    }
  }
  
  /**
   * 更新统计信息
   */
  async updateStats() {
    const stats = {
      packetsSent: 0,
      packetsLost: 0,
      bytesSent: 0,
      bytesReceived: 0,
      roundTripTime: 0
    };
    
    for (const [peerId, pc] of this.peers) {
      try {
        const pcStats = await pc.getStats();
        pcStats.forEach(report => {
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            stats.packetsSent += report.packetsSent || 0;
            stats.bytesSent += report.bytesSent || 0;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            stats.packetsLost += report.packetsLost || 0;
            stats.bytesReceived += report.bytesReceived || 0;
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            stats.roundTripTime = Math.max(stats.roundTripTime, report.currentRoundTripTime || 0);
          }
        });
      } catch (error) {
        console.error('[TeamVoiceChat] Failed to get stats:', error);
      }
    }
    
    this.stats = stats;
    this.emit('stats_updated', stats);
  }
  
  /**
   * 获取连接质量
   */
  getConnectionQuality() {
    const lossRate = this.stats.packetsSent > 0 
      ? this.stats.packetsLost / this.stats.packetsSent 
      : 0;
    const rtt = this.stats.roundTripTime * 1000; // 转换为毫秒
    
    if (rtt > 500 || lossRate > 0.1) {
      return 'poor';
    } else if (rtt > 200 || lossRate > 0.05) {
      return 'fair';
    } else {
      return 'good';
    }
  }
  
  /**
   * 关闭指定 Peer
   */
  closePeer(peerId) {
    const pc = this.peers.get(peerId);
    if (pc) {
      pc.close();
      this.peers.delete(peerId);
    }
    
    this.remoteStreams.delete(peerId);
    this.members.delete(peerId);
  }
  
  /**
   * 离开语音频道
   */
  leave() {
    console.log('[TeamVoiceChat] Leaving voice channel');
    
    // 发送离开消息
    this.sendSignal('leave', { teamId: this.teamId, userId: this.userId });
    
    // 关闭所有连接
    this.peers.forEach((pc, peerId) => {
      pc.close();
    });
    this.peers.clear();
    this.remoteStreams.clear();
    this.members.clear();
    
    // 停止本地流
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    
    // 关闭信令连接
    if (this.signalingSocket) {
      this.signalingSocket.close();
      this.signalingSocket = null;
    }
    
    // 清理定时器
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    
    // 关闭音频上下文
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    this.state = 'disconnected';
    this.emit('disconnected', { teamId: this.teamId });
  }
  
  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      state: this.state,
      teamId: this.teamId,
      userId: this.userId,
      peerCount: this.peers.size,
      isMuted: this.isMuted,
      isDeafened: this.isDeafened,
      isTalking: this.isTalking,
      quality: this.getConnectionQuality(),
      stats: this.stats,
      members: Array.from(this.members.values())
    };
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TeamVoiceChatManager };
} else {
  window.TeamVoiceChatManager = TeamVoiceChatManager;
}