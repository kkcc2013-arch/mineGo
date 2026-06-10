/**
 * REQ-00057: MFA 设置组件
 * 前端 MFA 管理界面
 */

class MFASetup {
  constructor(container) {
    this.container = container;
    this.state = {
      step: 'status', // status, setup, verify, enabled
      mfaStatus: null,
      secret: null,
      qrCodeDataUrl: null,
      recoveryCodes: [],
      verificationCode: '',
      loading: false,
      error: null
    };

    this.init();
  }

  async init() {
    await this.loadMFAStatus();
    this.render();
  }

  /**
   * 加载 MFA 状态
   */
  async loadMFAStatus() {
    try {
      const response = await fetch('/api/users/me/mfa', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      const data = await response.json();
      
      if (data.success) {
        this.state.mfaStatus = data.data;
        this.state.step = data.data.enabled ? 'enabled' : 'status';
      }
    } catch (error) {
      console.error('Failed to load MFA status:', error);
    }
  }

  /**
   * 开始设置 MFA
   */
  async startSetup() {
    this.state.loading = true;
    this.state.error = null;
    this.render();

    try {
      const response = await fetch('/api/users/me/mfa/setup', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      const data = await response.json();

      if (data.success) {
        this.state.secret = data.data.secret;
        this.state.qrCodeDataUrl = data.data.qrCodeDataUrl;
        this.state.recoveryCodes = data.data.recoveryCodes;
        this.state.step = 'setup';
      } else {
        this.state.error = data.message;
      }
    } catch (error) {
      this.state.error = '设置失败，请稍后再试';
    } finally {
      this.state.loading = false;
      this.render();
    }
  }

  /**
   * 验证并启用 MFA
   */
  async verifyAndEnable() {
    if (!this.state.verificationCode || this.state.verificationCode.length !== 6) {
      this.state.error = '请输入 6 位验证码';
      this.render();
      return;
    }

    this.state.loading = true;
    this.state.error = null;
    this.render();

    try {
      const response = await fetch('/api/users/me/mfa/enable', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code: this.state.verificationCode })
      });

      const data = await response.json();

      if (data.success) {
        this.state.step = 'enabled';
        this.state.mfaStatus = { enabled: true };
        alert('MFA 启用成功！');
      } else {
        this.state.error = data.message;
      }
    } catch (error) {
      this.state.error = '验证失败，请稍后再试';
    } finally {
      this.state.loading = false;
      this.render();
    }
  }

  /**
   * 禁用 MFA
   */
  async disableMFA(code) {
    if (!code) {
      this.state.error = '请输入验证码或恢复码';
      return false;
    }

    this.state.loading = true;

    try {
      const response = await fetch('/api/users/me/mfa/disable', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code })
      });

      const data = await response.json();

      if (data.success) {
        this.state.step = 'status';
        this.state.mfaStatus = { enabled: false };
        this.render();
        return true;
      } else {
        this.state.error = data.message;
        this.render();
        return false;
      }
    } catch (error) {
      this.state.error = '禁用失败，请稍后再试';
      this.render();
      return false;
    } finally {
      this.state.loading = false;
    }
  }

  /**
   * 复制到剪贴板
   */
  copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      alert('已复制到剪贴板');
    }).catch(() => {
      // 降级方案
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      alert('已复制到剪贴板');
    });
  }

  /**
   * 下载恢复码
   */
  downloadRecoveryCodes() {
    const content = `mineGo MFA 恢复码
生成时间: ${new Date().toLocaleString()}
重要提示: 请妥善保管这些恢复码，每个恢复码只能使用一次

${this.state.recoveryCodes.join('\n')}

请将此文件保存在安全的地方`;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `minego-recovery-codes-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * 渲染组件
   */
  render() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="mfa-setup-container">
        <h2>多因素认证（MFA）</h2>
        
        ${this.renderContent()}
        
        ${this.state.error ? `
          <div class="mfa-error" role="alert">
            <span class="error-icon">⚠️</span>
            ${this.state.error}
          </div>
        ` : ''}
      </div>
    `;

    this.attachEventListeners();
  }

  /**
   * 渲染内容
   */
  renderContent() {
    switch (this.state.step) {
      case 'status':
        return this.renderStatusView();
      case 'setup':
        return this.renderSetupView();
      case 'verify':
        return this.renderVerifyView();
      case 'enabled':
        return this.renderEnabledView();
      default:
        return this.renderStatusView();
    }
  }

  /**
   * 状态视图
   */
  renderStatusView() {
    return `
      <div class="mfa-status-view">
        <div class="status-icon ${this.state.mfaStatus?.enabled ? 'enabled' : 'disabled'}">
          ${this.state.mfaStatus?.enabled ? '✅' : '❌'}
        </div>
        
        <p class="status-text">
          ${this.state.mfaStatus?.enabled 
            ? 'MFA 已启用，您的账号受到额外保护' 
            : 'MFA 未启用，建议启用以增强账号安全'}
        </p>
        
        ${!this.state.mfaStatus?.enabled ? `
          <button class="btn btn-primary" id="mfa-start-setup" ${this.state.loading ? 'disabled' : ''}>
            ${this.state.loading ? '加载中...' : '启用 MFA'}
          </button>
        ` : ''}
        
        <div class="mfa-benefits">
          <h3>启用 MFA 的好处</h3>
          <ul>
            <li>🔒 即使密码泄露，他人也无法登录您的账号</li>
            <li>💰 保护您的支付安全和游戏资产</li>
            <li>📊 符合 PCI-DSS 金融合规要求</li>
            <li>🎮 行业标准安全措施</li>
          </ul>
        </div>
      </div>
    `;
  }

  /**
   * 设置视图
   */
  renderSetupView() {
    return `
      <div class="mfa-setup-view">
        <div class="setup-steps">
          <div class="step active">
            <span class="step-number">1</span>
            <span class="step-text">扫描二维码</span>
          </div>
          <div class="step">
            <span class="step-number">2</span>
            <span class="step-text">验证设置</span>
          </div>
          <div class="step">
            <span class="step-number">3</span>
            <span class="step-text">保存恢复码</span>
          </div>
        </div>

        <div class="setup-content">
          <div class="qr-code-section">
            <h3>步骤 1: 扫描二维码</h3>
            <p>使用 Google Authenticator、Microsoft Authenticator 或其他 TOTP 应用扫描以下二维码：</p>
            
            <div class="qr-code">
              <img src="${this.state.qrCodeDataUrl}" alt="MFA QR Code" />
            </div>
            
            <p class="manual-entry">
              无法扫描？手动输入密钥：
              <code class="secret-key">${this.state.secret}</code>
              <button class="btn btn-small" id="copy-secret">复制</button>
            </p>
          </div>

          <div class="recovery-codes-section">
            <h3>步骤 2: 保存恢复码</h3>
            <p class="warning">⚠️ 请将以下恢复码保存在安全的地方。如果您丢失了 MFA 设备，可以使用这些恢复码登录。每个恢复码只能使用一次。</p>
            
            <div class="recovery-codes">
              ${this.state.recoveryCodes.map(code => `
                <div class="recovery-code">${code}</div>
              `).join('')}
            </div>
            
            <button class="btn btn-secondary" id="download-recovery-codes">
              📥 下载恢复码
            </button>
          </div>

          <div class="verify-section">
            <h3>步骤 3: 验证设置</h3>
            <p>输入您的验证器应用显示的 6 位数字：</p>
            
            <div class="verify-input">
              <input 
                type="text" 
                id="verification-code" 
                maxlength="6" 
                placeholder="000000"
                autocomplete="one-time-code"
                inputmode="numeric"
                pattern="[0-9]{6}"
              />
              <button class="btn btn-primary" id="verify-mfa" ${this.state.loading ? 'disabled' : ''}>
                ${this.state.loading ? '验证中...' : '验证并启用'}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * 已启用视图
   */
  renderEnabledView() {
    return `
      <div class="mfa-enabled-view">
        <div class="enabled-header">
          <div class="status-icon enabled">✅</div>
          <h3>MFA 已启用</h3>
        </div>
        
        <div class="mfa-info">
          ${this.state.mfaStatus?.recoveryCodesRemaining !== undefined ? `
            <div class="recovery-codes-status">
              <span class="label">剩余恢复码:</span>
              <span class="value">${this.state.mfaStatus.recoveryCodesRemaining} / 8</span>
              ${this.state.mfaStatus.recoveryCodesRemaining <= 2 ? `
                <span class="warning">⚠️ 恢复码不足，建议重新生成</span>
              ` : ''}
            </div>
          ` : ''}
          
          <div class="mfa-actions">
            <button class="btn btn-secondary" id="regenerate-recovery-codes">
              🔄 重新生成恢复码
            </button>
            <button class="btn btn-danger" id="disable-mfa">
              ❌ 禁用 MFA
            </button>
          </div>
        </div>
        
        <div class="mfa-notice">
          <p>💡 提示：禁用 MFA 需要当前 MFA 验证</p>
        </div>
      </div>
    `;
  }

  /**
   * 绑定事件监听器
   */
  attachEventListeners() {
    // 开始设置按钮
    const startBtn = document.getElementById('mfa-start-setup');
    if (startBtn) {
      startBtn.addEventListener('click', () => this.startSetup());
    }

    // 复制密钥按钮
    const copyBtn = document.getElementById('copy-secret');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        this.copyToClipboard(this.state.secret);
      });
    }

    // 下载恢复码按钮
    const downloadBtn = document.getElementById('download-recovery-codes');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        this.downloadRecoveryCodes();
      });
    }

    // 验证按钮
    const verifyBtn = document.getElementById('verify-mfa');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', () => {
        this.state.verificationCode = document.getElementById('verification-code')?.value || '';
        this.verifyAndEnable();
      });
    }

    // 验证码输入框
    const codeInput = document.getElementById('verification-code');
    if (codeInput) {
      codeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          this.state.verificationCode = codeInput.value;
          this.verifyAndEnable();
        }
      });

      // 自动聚焦
      codeInput.focus();
    }

    // 重新生成恢复码按钮
    const regenerateBtn = document.getElementById('regenerate-recovery-codes');
    if (regenerateBtn) {
      regenerateBtn.addEventListener('click', () => {
        const code = prompt('请输入当前 MFA 验证码或恢复码：');
        if (code) {
          this.regenerateRecoveryCodes(code);
        }
      });
    }

    // 禁用 MFA 按钮
    const disableBtn = document.getElementById('disable-mfa');
    if (disableBtn) {
      disableBtn.addEventListener('click', () => {
        const code = prompt('请输入当前 MFA 验证码或恢复码以禁用 MFA：');
        if (code) {
          this.disableMFA(code);
        }
      });
    }
  }

  /**
   * 重新生成恢复码
   */
  async regenerateRecoveryCodes(code) {
    this.state.loading = true;
    this.state.error = null;
    this.render();

    try {
      const response = await fetch('/api/users/me/mfa/recovery-codes/regenerate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code })
      });

      const data = await response.json();

      if (data.success) {
        this.state.recoveryCodes = data.data.recoveryCodes;
        alert('恢复码已重新生成！');
        this.downloadRecoveryCodes();
      } else {
        this.state.error = data.message;
      }
    } catch (error) {
      this.state.error = '重新生成失败，请稍后再试';
    } finally {
      this.state.loading = false;
      this.render();
    }
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MFASetup;
}

// 全局注册
if (typeof window !== 'undefined') {
  window.MFASetup = MFASetup;
}
