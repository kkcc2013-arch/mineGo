/**
 * mineGo 监控大屏前端逻辑
 */

class MonitoringDashboard {
    constructor() {
        this.socket = null;
        this.errorChart = null;
        this.latencyChart = null;
        this.topologyCanvas = null;
        this.topologyCtx = null;
        this.nodes = [];
        this.edges = [];
        
        this.init();
    }

    init() {
        // 初始化时间显示
        this.updateTime();
        setInterval(() => this.updateTime(), 1000);
        
        // 初始化图表
        this.initCharts();
        
        // 初始化拓扑图画布
        this.initTopologyCanvas();
        
        // 连接 WebSocket
        this.connectWebSocket();
    }

    updateTime() {
        const now = new Date();
        const timeStr = now.toLocaleString('zh-CN', {
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        document.getElementById('current-time').textContent = timeStr;
    }

    connectWebSocket() {
        const wsUrl = `ws://${window.location.hostname}:3001`;
        
        console.log('[Monitor] Connecting to WebSocket:', wsUrl);
        
        this.socket = io(wsUrl, {
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: 10
        });
        
        this.socket.on('connect', () => {
            console.log('[Monitor] WebSocket connected');
            this.updateConnectionStatus(true);
        });
        
        this.socket.on('disconnect', () => {
            console.log('[Monitor] WebSocket disconnected');
            this.updateConnectionStatus(false);
        });
        
        this.socket.on('initial-data', (data) => {
            console.log('[Monitor] Received initial data:', data);
            this.updateMetrics(data);
        });
        
        this.socket.on('metrics-update', (data) => {
            this.updateMetrics(data);
        });
        
        this.socket.on('alerts', (alerts) => {
            this.updateAlerts(alerts);
        });
        
        this.socket.on('new-alert', (alert) => {
            this.addNewAlert(alert);
        });
        
        this.socket.on('alert-acknowledged', ({ alertId, success }) => {
            if (success) {
                console.log('[Monitor] Alert acknowledged:', alertId);
            }
        });
    }

    updateConnectionStatus(connected) {
        const statusEl = document.getElementById('connection-status');
        if (connected) {
            statusEl.textContent = '已连接';
            statusEl.className = 'status-badge connected';
        } else {
            statusEl.textContent = '未连接';
            statusEl.className = 'status-badge disconnected';
        }
    }

    initCharts() {
        // 错误率图表
        const errorCtx = document.getElementById('error-chart').getContext('2d');
        this.errorChart = new Chart(errorCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: '错误率 (%)',
                    data: [],
                    borderColor: '#ff4757',
                    backgroundColor: 'rgba(255, 71, 87, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        display: true,
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        display: true,
                        beginAtZero: true,
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                },
                plugins: {
                    legend: {
                        labels: { color: '#a0a8b8' }
                    }
                }
            }
        });

        // 延迟图表
        const latencyCtx = document.getElementById('latency-chart').getContext('2d');
        this.latencyChart = new Chart(latencyCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: '延迟 P99 (ms)',
                    data: [],
                    borderColor: '#00d4ff',
                    backgroundColor: 'rgba(0, 212, 255, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        display: true,
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        display: true,
                        beginAtZero: true,
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    }
                },
                plugins: {
                    legend: {
                        labels: { color: '#a0a8b8' }
                    }
                }
            }
        });
    }

    initTopologyCanvas() {
        this.topologyCanvas = document.getElementById('topology-canvas');
        this.topologyCtx = this.topologyCanvas.getContext('2d');
        
        // 设置画布大小
        const container = document.getElementById('topology-container');
        this.topologyCanvas.width = container.offsetWidth;
        this.topologyCanvas.height = container.offsetHeight;
        
        // 监听窗口大小变化
        window.addEventListener('resize', () => {
            this.topologyCanvas.width = container.offsetWidth;
            this.topologyCanvas.height = container.offsetHeight;
            this.drawTopology();
        });
    }

    updateMetrics(data) {
        const { slo, anomalies, topology } = data;
        
        // 更新 SLO 指标
        if (slo) {
            for (const [link, metrics] of Object.entries(slo)) {
                this.updateSLOCard(link, metrics);
            }
        }
        
        // 更新拓扑图
        if (topology) {
            this.nodes = topology.nodes || [];
            this.edges = topology.edges || [];
            this.drawTopology();
        }
        
        // 更新图表
        if (anomalies) {
            this.updateCharts(anomalies);
        }
    }

    updateSLOCard(link, metrics) {
        const latencyEl = document.getElementById(`${link}-latency`);
        const errorEl = document.getElementById(`${link}-error`);
        const throughputEl = document.getElementById(`${link}-throughput`);
        
        if (latencyEl) {
            latencyEl.textContent = `${metrics.latency.toFixed(0)}ms`;
            latencyEl.className = 'metric-value ' + this.getValueClass(metrics.latency, 500, 300);
        }
        
        if (errorEl) {
            errorEl.textContent = `${metrics.errorRate.toFixed(2)}%`;
            errorEl.className = 'metric-value ' + this.getValueClass(metrics.errorRate, 5, 3, true);
        }
        
        if (throughputEl) {
            throughputEl.textContent = `${metrics.throughput.toFixed(1)} req/s`;
        }
    }

    getValueClass(value, threshold1, threshold2, inverse = false) {
        if (inverse) {
            if (value > threshold1) return 'danger';
            if (value > threshold2) return 'warning';
            return 'success';
        } else {
            if (value > threshold1) return 'danger';
            if (value > threshold2) return 'warning';
            return 'success';
        }
    }

    drawTopology() {
        const ctx = this.topologyCtx;
        const canvas = this.topologyCanvas;
        
        // 清空画布
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        if (this.nodes.length === 0) {
            ctx.fillStyle = '#a0a8b8';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('暂无服务拓扑数据', canvas.width / 2, canvas.height / 2);
            return;
        }
        
        // 计算节点位置（圆形布局）
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const radius = Math.min(canvas.width, canvas.height) * 0.35;
        
        const nodePositions = new Map();
        
        this.nodes.forEach((node, index) => {
            const angle = (index / this.nodes.length) * 2 * Math.PI - Math.PI / 2;
            const x = centerX + radius * Math.cos(angle);
            const y = centerY + radius * Math.sin(angle);
            nodePositions.set(node.id, { x, y, ...node });
        });
        
        // 绘制边
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.3)';
        ctx.lineWidth = 2;
        
        this.edges.forEach(edge => {
            const source = nodePositions.get(edge.source);
            const target = nodePositions.get(edge.target);
            
            if (source && target) {
                ctx.beginPath();
                ctx.moveTo(source.x, source.y);
                ctx.lineTo(target.x, target.y);
                ctx.stroke();
                
                // 绘制流量标签
                const midX = (source.x + target.x) / 2;
                const midY = (source.y + target.y) / 2;
                ctx.fillStyle = '#00d4ff';
                ctx.font = '10px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(edge.traffic.toFixed(1), midX, midY);
            }
        });
        
        // 绘制节点
        nodePositions.forEach((node, id) => {
            // 节点背景
            ctx.beginPath();
            ctx.arc(node.x, node.y, 30, 0, 2 * Math.PI);
            
            if (node.status === 'healthy') {
                ctx.fillStyle = 'rgba(0, 255, 136, 0.3)';
                ctx.strokeStyle = '#00ff88';
            } else if (node.status === 'unhealthy') {
                ctx.fillStyle = 'rgba(255, 71, 87, 0.3)';
                ctx.strokeStyle = '#ff4757';
            } else {
                ctx.fillStyle = 'rgba(255, 170, 0, 0.3)';
                ctx.strokeStyle = '#ffaa00';
            }
            
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.stroke();
            
            // 节点名称
            ctx.fillStyle = '#ffffff';
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(node.name, node.x, node.y + 45);
        });
    }

    updateCharts(anomalies) {
        const now = new Date();
        const timeLabel = now.toLocaleTimeString('zh-CN', { hour12: false });
        
        // 更新错误率图表
        const errorRate = anomalies.error_rate 
            ? anomalies.error_rate.reduce((sum, item) => sum + parseFloat(item.value[1] || 0), 0) 
            : 0;
        
        this.errorChart.data.labels.push(timeLabel);
        this.errorChart.data.datasets[0].data.push(errorRate * 100);
        
        if (this.errorChart.data.labels.length > 30) {
            this.errorChart.data.labels.shift();
            this.errorChart.data.datasets[0].data.shift();
        }
        this.errorChart.update('none');
        
        // 更新延迟图表
        const latency = anomalies.latency_p99 
            ? Math.max(...anomalies.latency_p99.map(item => parseFloat(item.value[1] || 0))) 
            : 0;
        
        this.latencyChart.data.labels.push(timeLabel);
        this.latencyChart.data.datasets[0].data.push(latency * 1000);
        
        if (this.latencyChart.data.labels.length > 30) {
            this.latencyChart.data.labels.shift();
            this.latencyChart.data.datasets[0].data.shift();
        }
        this.latencyChart.update('none');
    }

    updateAlerts(alerts) {
        const alertList = document.getElementById('alert-list');
        alertList.innerHTML = '';
        
        alerts.forEach(alert => {
            const alertEl = this.createAlertElement(alert);
            alertList.appendChild(alertEl);
        });
        
        this.updateAlertCount(alerts.filter(a => !a.acknowledged).length);
    }

    addNewAlert(alert) {
        const alertList = document.getElementById('alert-list');
        const alertEl = this.createAlertElement(alert);
        alertList.insertBefore(alertEl, alertList.firstChild);
        
        this.updateAlertCount(
            parseInt(document.getElementById('alert-count').textContent) + 1
        );
    }

    createAlertElement(alert) {
        const div = document.createElement('div');
        div.className = `alert-item ${alert.severity} ${alert.acknowledged ? 'acknowledged' : ''}`;
        div.id = `alert-${alert.id}`;
        
        const time = new Date(alert.timestamp).toLocaleString('zh-CN', { hour12: false });
        
        div.innerHTML = `
            <div class="alert-header">
                <span class="alert-type">${alert.type}</span>
                <span class="alert-time">${time}</span>
            </div>
            <div class="alert-message">${alert.message}</div>
            ${!alert.acknowledged ? `
                <div class="alert-actions">
                    <button class="btn-acknowledge" onclick="dashboard.acknowledgeAlert('${alert.id}')">确认</button>
                </div>
            ` : ''}
        `;
        
        return div;
    }

    acknowledgeAlert(alertId) {
        this.socket.emit('acknowledge-alert', alertId);
        
        const alertEl = document.getElementById(`alert-${alertId}`);
        if (alertEl) {
            alertEl.classList.add('acknowledged');
            const actionsEl = alertEl.querySelector('.alert-actions');
            if (actionsEl) {
                actionsEl.remove();
            }
        }
        
        this.updateAlertCount(
            parseInt(document.getElementById('alert-count').textContent) - 1
        );
    }

    updateAlertCount(count) {
        const countEl = document.getElementById('alert-count');
        countEl.textContent = count;
        countEl.style.display = count > 0 ? 'inline' : 'none';
    }
}

// 初始化
const dashboard = new MonitoringDashboard();
