/**
 * 部署看板前端交互
 * REQ-00492: 部署流水线可视化看板与状态追踪系统
 */

// 全局状态
let currentEnv = 'production';
let socket = null;
let apiBase = '/api/deployments';

// 初始化
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // 连接 WebSocket
  connectWebSocket();
  
  // 加载初始数据
  await loadOverview();
  await loadActiveDeployments();
  await loadHistory();
  
  // 设置环境切换
  document.querySelectorAll('.env-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      document.querySelectorAll('.env-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentEnv = e.target.dataset.env;
      
      // 重新订阅 WebSocket
      socket.emit('unsubscribe', currentEnv === 'production' ? 'staging' : 'production');
      socket.emit('subscribe', currentEnv);
      
      // 刷新数据
      await loadOverview();
      await loadActiveDeployments();
      await loadHistory();
    });
  });
  
  // 设置过滤器
  document.getElementById('service-filter').addEventListener('change', loadHistory);
  document.getElementById('status-filter').addEventListener('change', loadHistory);
}

// WebSocket 连接
function connectWebSocket() {
  socket = io('/deployments', {
    transports: ['websocket'],
    upgrade: false
  });
  
  socket.on('connected', (data) => {
    console.log('[WS] Connected:', data);
  });
  
  socket.on('update', (data) => {
    console.log('[WS] Update:', data);
    handleUpdate(data);
  });
  
  socket.on('global-update', (data) => {
    console.log('[WS] Global update:', data);
  });
  
  // 初始订阅
  socket.emit('subscribe', currentEnv);
}

// 处理实时更新
function handleUpdate(data) {
  const { type, deployment, step, alert } = data;
  
  switch (type) {
    case 'created':
      addActiveDeployment(deployment);
      break;
    case 'status_update':
      updateDeploymentStatus(deployment);
      break;
    case 'step_started':
    case 'step_completed':
      updateStep(step);
      break;
    case 'alert':
      addAlert(alert);
      break;
  }
}

// 加载服务概览
async function loadOverview() {
  try {
    const res = await fetch(`${apiBase}/overview?environment=${currentEnv}`);
    const data = await res.json();
    
    if (data.success) {
      renderServicesGrid(data.services);
    }
  } catch (error) {
    console.error('Load overview error:', error);
  }
}

// 渲染服务网格
function renderServicesGrid(services) {
  const grid = document.getElementById('services-grid');
  
  if (!services || services.length === 0) {
    grid.innerHTML = '<div class="empty">暂无服务数据</div>';
    return;
  }
  
  grid.innerHTML = services.map(s => `
    <div class="service-card" data-service="${s.service}">
      <div class="service-name">${s.service}</div>
      <div class="service-version">v${s.version || 'N/A'}</div>
      <div class="service-status status-${s.status || 'success'}">
        ${getStatusText(s.status)}
      </div>
      <div style="color: #888; font-size: 11px; margin-top: 8px;">
        ${s.completed_at ? formatTime(s.completed_at) : '运行中'}
      </div>
    </div>
  `).join('');
}

// 加载活跃部署
async function loadActiveDeployments() {
  try {
    const res = await fetch(`${apiBase}/active?environment=${currentEnv}`);
    const data = await res.json();
    
    if (data.success) {
      renderActiveDeployments(data.deployments);
    }
  } catch (error) {
    console.error('Load active error:', error);
  }
}

// 渲染活跃部署
function renderActiveDeployments(deployments) {
  const list = document.getElementById('active-list');
  
  if (!deployments || deployments.length === 0) {
    list.innerHTML = '<div class="empty">暂无进行中的部署</div>';
    return;
  }
  
  list.innerHTML = deployments.map(d => `
    <div class="active-card" data-deployment="${d.deployment_id}">
      <div class="active-header">
        <div class="active-service">${d.service}</div>
        <div class="active-time">${formatTime(d.started_at)}</div>
      </div>
      <div style="margin-top: 10px; color: #888;">
        版本: v${d.version} | 触发者: ${d.triggered_by}
      </div>
      <div class="active-steps" id="steps-${d.deployment_id}">
        加载步骤中...
      </div>
      <button class="btn" onclick="showDetails('${d.deployment_id}')">查看详情</button>
    </div>
  `).join('');
  
  // 加载每个部署的步骤
  deployments.forEach(d => loadSteps(d.deployment_id));
}

// 加载部署步骤
async function loadSteps(deploymentId) {
  try {
    const res = await fetch(`${apiBase}/${deploymentId}`);
    const data = await res.json();
    
    if (data.success && data.steps) {
      renderSteps(deploymentId, data.steps);
    }
  } catch (error) {
    console.error('Load steps error:', error);
  }
}

// 渲染步骤
function renderSteps(deploymentId, steps) {
  const container = document.getElementById(`steps-${deploymentId}`);
  if (!container) return;
  
  container.innerHTML = steps.map(s => `
    <div class="step-item">
      <div class="step-dot step-${s.status}"></div>
      <div>${s.step_name}</div>
      <div style="color: #888; font-size: 12px;">
        ${s.completed_at ? formatTime(s.completed_at) : '进行中'}
      </div>
    </div>
  `).join('');
}

// 加载历史
async function loadHistory() {
  const service = document.getElementById('service-filter').value;
  const status = document.getElementById('status-filter').value;
  
  try {
    let url = `${apiBase}/history?limit=20&environment=${currentEnv}`;
    if (service) url += `&service=${service}`;
    if (status) url += `&status=${status}`;
    
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.success) {
      renderHistory(data.history);
    }
  } catch (error) {
    console.error('Load history error:', error);
  }
}

// 渲染历史表格
function renderHistory(history) {
  const tbody = document.getElementById('history-body');
  
  if (!history || history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无历史记录</td></tr>';
    return;
  }
  
  tbody.innerHTML = history.map(h => `
    <tr>
      <td>${h.service}</td>
      <td>v${h.version}</td>
      <td><span class="service-status status-${h.status}">${getStatusText(h.status)}</span></td>
      <td>${formatTime(h.started_at)}</td>
      <td>${h.duration_seconds ? formatDuration(h.duration_seconds) : 'N/A'}</td>
      <td>${h.triggered_by || 'system'}</td>
      <td><button class="btn" onclick="showDetails('${h.deployment_id}')">详情</button></td>
    </tr>
  `).join('');
}

// 显示详情模态框
async function showDetails(deploymentId) {
  try {
    const res = await fetch(`${apiBase}/${deploymentId}`);
    const data = await res.json();
    
    if (data.success) {
      renderDetails(data);
      document.getElementById('detail-modal').classList.remove('hidden');
      
      // 订阅 WebSocket 更新
      socket.emit('watch', deploymentId);
    }
  } catch (error) {
    console.error('Show details error:', error);
  }
}

// 渲染详情
function renderDetails(data) {
  const { deployment, steps, alerts } = data;
  
  // 基本信息
  document.getElementById('deployment-info').innerHTML = `
    <div style="padding: 10px; background: #3a3a5e; border-radius: 4px; margin-bottom: 20px;">
      <div><strong>服务:</strong> ${deployment.service}</div>
      <div><strong>版本:</strong> v${deployment.version}</div>
      <div><strong>状态:</strong> <span class="service-status status-${deployment.status}">${getStatusText(deployment.status)}</span></div>
      <div><strong>触发者:</strong> ${deployment.triggered_by}</div>
      <div><strong>开始时间:</strong> ${formatTime(deployment.started_at)}</div>
      <div><strong>耗时:</strong> ${deployment.duration_seconds ? formatDuration(deployment.duration_seconds) : '进行中'}</div>
    </div>
  `;
  
  // 步骤时间线
  document.getElementById('steps-timeline').innerHTML = steps.map(s => `
    <div class="timeline-step ${s.status}">
      <div>
        <div style="font-weight: bold;">${s.step_name}</div>
        <div style="color: #888; font-size: 12px;">
          ${s.status === 'running' ? '进行中' : formatTime(s.completed_at || s.started_at)}
        </div>
        ${s.error_message ? `<div style="color: #ff6b6b;">${s.error_message}</div>` : ''}
      </div>
    </div>
  `).join('');
  
  // 告警列表
  document.getElementById('alerts-list').innerHTML = alerts && alerts.length > 0 
    ? alerts.map(a => `
      <div class="alert-item alert-${a.alert_type}">
        <div>${a.message}</div>
        <div style="font-size: 12px; color: #888;">${formatTime(a.created_at)}</div>
        ${!a.acknowledged ? `<button class="btn" onclick="acknowledgeAlert(${a.id})">确认</button>` : '<div style="color: #4ecca3;">已确认</div>'}
      </div>
    `).join('')
    : '<div class="empty">暂无告警</div>';
}

// 关闭模态框
function closeModal() {
  document.getElementById('detail-modal').classList.add('hidden');
}

// 确认告警
async function acknowledgeAlert(alertId) {
  try {
    const res = await fetch(`${apiBase}/alerts/${alertId}/acknowledge`, {
      method: 'PATCH'
    });
    const data = await res.json();
    
    if (data.success) {
      alert('告警已确认');
    }
  } catch (error) {
    console.error('Acknowledge error:', error);
  }
}

// 实时更新函数
function addActiveDeployment(deployment) {
  if (deployment.environment !== currentEnv) return;
  
  const list = document.getElementById('active-list');
  const emptyDiv = list.querySelector('.empty');
  if (emptyDiv) emptyDiv.remove();
  
  const card = document.createElement('div');
  card.className = 'active-card';
  card.dataset.deployment = deployment.deployment_id;
  card.innerHTML = `
    <div class="active-header">
      <div class="active-service">${deployment.service}</div>
      <div class="active-time">${formatTime(deployment.started_at)}</div>
    </div>
    <div style="margin-top: 10px; color: #888;">
      版本: v${deployment.version} | 触发者: ${deployment.triggered_by}
    </div>
    <button class="btn" onclick="showDetails('${deployment.deployment_id}')">查看详情</button>
  `;
  
  list.prepend(card);
}

function updateDeploymentStatus(deployment) {
  const serviceCard = document.querySelector(`.service-card[data-service="${deployment.service}"]`);
  if (serviceCard) {
    const statusDiv = serviceCard.querySelector('.service-status');
    statusDiv.className = `service-status status-${deployment.status}`;
    statusDiv.textContent = getStatusText(deployment.status);
    
    const timeDiv = serviceCard.querySelector('div:last-child');
    timeDiv.textContent = formatTime(deployment.completed_at);
  }
  
  if (deployment.status === 'success' || deployment.status === 'failed') {
    const activeCard = document.querySelector(`.active-card[data-deployment="${deployment.deployment_id}"]`);
    if (activeCard) activeCard.remove();
    
    loadActiveDeployments();
    loadHistory();
  }
}

function updateStep(step) {
  const container = document.getElementById(`steps-${step.deployment_id}`);
  if (!container) return;
  
  loadSteps(step.deployment_id);
}

function addAlert(alert) {
  const alertsList = document.getElementById('alerts-list');
  if (!alertsList) return;
  
  const emptyDiv = alertsList.querySelector('.empty');
  if (emptyDiv) emptyDiv.remove();
  
  const alertItem = document.createElement('div');
  alertItem.className = `alert-item alert-${alert.alert_type}`;
  alertItem.innerHTML = `<div>${alert.message}</div><div style="font-size: 12px; color: #888;">${formatTime(alert.created_at)}</div>`;
  
  alertsList.prepend(alertItem);
}

// 工具函数
function getStatusText(status) {
  const map = {
    'pending': '等待中',
    'running': '运行中',
    'success': '成功',
    'failed': '失败',
    'rolled_back': '已回滚'
  };
  return map[status] || status;
}

function formatTime(timestamp) {
  if (!timestamp) return 'N/A';
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  if (seconds < 60) return `${seconds}秒`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}分${secs}秒`;
}
