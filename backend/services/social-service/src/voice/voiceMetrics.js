/**
 * Voice Metrics - Prometheus 指标定义
 * 监控语音聊天系统的各项指标
 */

const client = require('prom-client');

// 避免重复注册指标
const registerMetric = (name, metric) => {
  try {
    return client.register.getSingleMetric(name) || metric;
  } catch (e) {
    return metric;
  }
};

const voiceMetrics = {
  // 活跃语音房间数
  activeVoiceRooms: registerMetric('voice_active_rooms', new client.Gauge({
    name: 'voice_active_rooms',
    help: 'Number of active voice rooms',
    labelNames: ['type'] // temporary, persistent
  })),

  // 活跃语音用户数
  activeVoiceUsers: registerMetric('voice_active_users', new client.Gauge({
    name: 'voice_active_users',
    help: 'Number of users in voice rooms'
  })),

  // 语音房间创建数
  roomsCreated: registerMetric('voice_rooms_created_total', new client.Counter({
    name: 'voice_rooms_created_total',
    help: 'Total number of voice rooms created',
    labelNames: ['type']
  })),

  // 语音通话时长
  callDuration: registerMetric('voice_call_duration_seconds', new client.Histogram({
    name: 'voice_call_duration_seconds',
    help: 'Duration of voice calls in seconds',
    labelNames: ['room_type'],
    buckets: [60, 300, 600, 1800, 3600, 7200] // 1m, 5m, 10m, 30m, 1h, 2h
  })),

  // WebRTC 连接质量
  webrtcConnectionQuality: registerMetric('voice_webrtc_connection_quality', new client.Histogram({
    name: 'voice_webrtc_connection_quality',
    help: 'WebRTC connection quality score (0-100)',
    buckets: [20, 40, 60, 80, 100]
  })),

  // 丢包率
  packetLoss: registerMetric('voice_packet_loss_rate', new client.Histogram({
    name: 'voice_packet_loss_rate',
    help: 'Packet loss rate in voice calls',
    buckets: [0.01, 0.05, 0.1, 0.2, 0.5]
  })),

  // TURN 服务器使用量
  turnUsage: registerMetric('voice_turn_usage_total', new client.Counter({
    name: 'voice_turn_usage_total',
    help: 'Total TURN server usage',
    labelNames: ['type'] // relay, direct
  })),

  // 信令消息数
  signalingMessages: registerMetric('voice_signaling_messages_total', new client.Counter({
    name: 'voice_signaling_messages_total',
    help: 'Total signaling messages',
    labelNames: ['type'] // connection, offer, answer, ice-candidate
  })),

  // WebSocket 连接数
  websocketConnections: registerMetric('voice_websocket_connections', new client.Gauge({
    name: 'voice_websocket_connections',
    help: 'Current WebSocket connections'
  })),

  // 房间成员数分布
  roomMemberCount: registerMetric('voice_room_member_count', new client.Histogram({
    name: 'voice_room_member_count',
    help: 'Distribution of member count in voice rooms',
    buckets: [1, 2, 5, 10, 20, 30, 50]
  })),

  // 错误计数
  errors: registerMetric('voice_errors_total', new client.Counter({
    name: 'voice_errors_total',
    help: 'Total voice system errors',
    labelNames: ['type'] // signaling, webrtc, turn
  })),

  // API 请求延迟
  apiLatency: registerMetric('voice_api_latency_seconds', new client.Histogram({
    name: 'voice_api_latency_seconds',
    help: 'Voice API request latency',
    labelNames: ['endpoint', 'method'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2]
  }))
};

/**
 * 记录通话统计
 */
voiceMetrics.recordCallStats = function(stats) {
  const { duration, roomType, packetLoss, quality } = stats;

  if (duration) {
    this.callDuration.observe({ room_type: roomType || 'temporary' }, duration);
  }

  if (packetLoss !== undefined) {
    this.packetLoss.observe(packetLoss);
  }

  if (quality !== undefined) {
    this.webrtcConnectionQuality.observe(quality);
  }
};

/**
 * 更新房间统计
 */
voiceMetrics.updateRoomStats = function(rooms) {
  let totalUsers = 0;
  let temporaryRooms = 0;
  let persistentRooms = 0;

  for (const room of rooms) {
    const memberCount = room.members?.size || 0;
    totalUsers += memberCount;

    this.roomMemberCount.observe(memberCount);

    if (room.persistent) {
      persistentRooms++;
    } else {
      temporaryRooms++;
    }
  }

  this.activeVoiceRooms.set({ type: 'temporary' }, temporaryRooms);
  this.activeVoiceRooms.set({ type: 'persistent' }, persistentRooms);
  this.activeVoiceUsers.set(totalUsers);
};

module.exports = voiceMetrics;
