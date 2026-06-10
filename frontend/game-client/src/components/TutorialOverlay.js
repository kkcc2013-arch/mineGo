/**
 * REQ-00059: 新手引导与教程系统
 * 教程覆盖层组件
 */

class TutorialOverlay {
  constructor() {
    this.currentStep = null;
    this.overlay = null;
    this.tooltip = null;
    this.totalSteps = 7;
    this.init();
  }

  async init() {
    await this.loadCurrentStep();
    this.createOverlay();
    if (this.currentStep) {
      this.showStep();
    }
  }

  async loadCurrentStep() {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      
      const response = await fetch('/api/tutorial/current-step', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (response.ok) {
        const result = await response.json();
        this.currentStep = result.data;
      }
    } catch (error) {
      console.error('Load tutorial step error:', error);
    }
  }

  createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'tutorial-overlay';
    this.overlay.innerHTML = `
      <style>
        .tutorial-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          z-index: 10000;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.3s ease;
        }
        
        .tutorial-overlay.visible {
          opacity: 1;
          pointer-events: auto;
        }
        
        .tutorial-backdrop {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.7);
        }
        
        .tutorial-tooltip {
          position: absolute;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 16px;
          padding: 20px;
          max-width: 350px;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
          color: white;
          pointer-events: auto;
          animation: tooltipPulse 2s ease-in-out infinite;
        }
        
        @keyframes tooltipPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.02); }
        }
        
        .tooltip-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }
        
        .tooltip-title {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }
        
        .skip-btn {
          background: rgba(255, 255, 255, 0.2);
          border: none;
          color: white;
          padding: 6px 12px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 12px;
          transition: background 0.2s;
        }
        
        .skip-btn:hover {
          background: rgba(255, 255, 255, 0.3);
        }
        
        .tooltip-content {
          margin-bottom: 16px;
        }
        
        .tooltip-description {
          margin: 0;
          font-size: 14px;
          line-height: 1.5;
          opacity: 0.9;
        }
        
        .tooltip-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .progress-indicator {
          font-size: 12px;
          opacity: 0.8;
        }
        
        .next-btn {
          background: white;
          color: #667eea;
          border: none;
          padding: 10px 20px;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
          transition: transform 0.2s, box-shadow 0.2s;
        }
        
        .next-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        }
        
        .highlight-box {
          position: absolute;
          border: 3px solid #FFD700;
          border-radius: 12px;
          background: transparent;
          pointer-events: none;
          box-shadow: 0 0 20px rgba(255, 215, 0, 0.5);
          opacity: 0;
          transition: all 0.3s ease;
        }
        
        .highlight-box.visible {
          opacity: 1;
        }
        
        .tutorial-complete-modal {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.8);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 10001;
        }
        
        .modal-content {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 24px;
          padding: 40px;
          text-align: center;
          color: white;
          max-width: 400px;
          animation: modalBounce 0.5s ease;
        }
        
        @keyframes modalBounce {
          0% { transform: scale(0.5); opacity: 0; }
          100% { transform: scale(1); opacity: 1; }
        }
        
        .celebration-animation {
          font-size: 60px;
          animation: celebrate 1s ease infinite;
        }
        
        @keyframes celebrate {
          0%, 100% { transform: rotate(-10deg); }
          50% { transform: rotate(10deg); }
        }
        
        .start-adventure-btn {
          background: #FFD700;
          color: #333;
          border: none;
          padding: 15px 30px;
          border-radius: 12px;
          font-size: 18px;
          font-weight: 600;
          cursor: pointer;
          margin-top: 20px;
          transition: transform 0.2s;
        }
        
        .start-adventure-btn:hover {
          transform: scale(1.05);
        }
      </style>
      
      <div class="tutorial-backdrop"></div>
      <div class="tutorial-tooltip">
        <div class="tooltip-header">
          <h3 class="tooltip-title"></h3>
          <button class="skip-btn">跳过教程</button>
        </div>
        <div class="tooltip-content">
          <p class="tooltip-description"></p>
        </div>
        <div class="tooltip-footer">
          <div class="progress-indicator"></div>
          <button class="next-btn">下一步</button>
        </div>
      </div>
      <div class="highlight-box"></div>
    `;

    document.body.appendChild(this.overlay);

    // 绑定事件
    this.overlay.querySelector('.skip-btn').addEventListener('click', () => {
      this.skipTutorial();
    });

    this.overlay.querySelector('.next-btn').addEventListener('click', () => {
      this.completeCurrentStep();
    });
  }

  showStep() {
    if (!this.currentStep) return;

    const step = this.currentStep;

    // 更新内容
    this.overlay.querySelector('.tooltip-title').textContent = step.title;
    this.overlay.querySelector('.tooltip-description').textContent = step.description || '';

    // 定位tooltip
    if (step.target_element) {
      const targetElement = document.querySelector(step.target_element);
      if (targetElement) {
        this.positionTooltip(targetElement, step.position || 'bottom');
        this.highlightElement(targetElement);
      } else {
        this.centerTooltip();
      }
    } else {
      this.centerTooltip();
    }

    // 更新进度指示器
    const completedSteps = step.completedSteps || [];
    this.overlay.querySelector('.progress-indicator').textContent = 
      `步骤 ${completedSteps.length + 1} / ${this.totalSteps}`;

    // 显示overlay
    this.overlay.classList.add('visible');

    // 根据步骤类型显示/隐藏下一步按钮
    const nextBtn = this.overlay.querySelector('.next-btn');
    if (step.step_type === 'instruction' || step.step_type === 'dialogue') {
      nextBtn.style.display = 'block';
    } else {
      nextBtn.style.display = 'none';
    }
  }

  positionTooltip(targetElement, position) {
    const targetRect = targetElement.getBoundingClientRect();
    const tooltip = this.overlay.querySelector('.tutorial-tooltip');
    const tooltipRect = tooltip.getBoundingClientRect();
    
    let top, left;
    const margin = 15;

    switch (position) {
      case 'top':
        top = targetRect.top - tooltipRect.height - margin;
        left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
        break;
      case 'bottom':
        top = targetRect.bottom + margin;
        left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
        break;
      case 'left':
        top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
        left = targetRect.left - tooltipRect.width - margin;
        break;
      case 'right':
        top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
        left = targetRect.right + margin;
        break;
      default:
        top = targetRect.bottom + margin;
        left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
    }

    // 边界检查
    top = Math.max(10, Math.min(top, window.innerHeight - tooltipRect.height - 10));
    left = Math.max(10, Math.min(left, window.innerWidth - tooltipRect.width - 10));

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.transform = 'none';
  }

  centerTooltip() {
    const tooltip = this.overlay.querySelector('.tutorial-tooltip');
    tooltip.style.top = '50%';
    tooltip.style.left = '50%';
    tooltip.style.transform = 'translate(-50%, -50%)';
    
    // 隐藏高亮框
    this.overlay.querySelector('.highlight-box').classList.remove('visible');
  }

  highlightElement(element) {
    const rect = element.getBoundingClientRect();
    const highlightBox = this.overlay.querySelector('.highlight-box');
    const padding = 8;
    
    highlightBox.style.top = `${rect.top - padding}px`;
    highlightBox.style.left = `${rect.left - padding}px`;
    highlightBox.style.width = `${rect.width + padding * 2}px`;
    highlightBox.style.height = `${rect.height + padding * 2}px`;
    highlightBox.classList.add('visible');
  }

  async completeCurrentStep() {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/tutorial/complete-step', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ stepKey: this.currentStep.stepKey })
      });

      const result = await response.json();

      if (result.success) {
        if (result.data.rewards && Object.keys(result.data.rewards).length > 0) {
          this.showRewardAnimation(result.data.rewards);
        }

        if (result.data.nextStep) {
          await this.loadCurrentStep();
          this.showStep();
        } else {
          this.onTutorialComplete();
        }
      }
    } catch (error) {
      console.error('Complete step error:', error);
      alert('完成步骤失败，请重试');
    }
  }

  async skipTutorial() {
    if (confirm('确定要跳过新手教程吗？你可以稍后在设置中重新查看。')) {
      try {
        const token = localStorage.getItem('token');
        await fetch('/api/tutorial/skip', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        this.hideOverlay();
      } catch (error) {
        console.error('Skip tutorial error:', error);
      }
    }
  }

  onTutorialComplete() {
    this.hideOverlay();
    this.showCompletionModal();
  }

  showCompletionModal() {
    const modal = document.createElement('div');
    modal.className = 'tutorial-complete-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="celebration-animation">🎉</div>
        <h2 style="margin: 20px 0 10px;">恭喜完成新手教程!</h2>
        <p style="opacity: 0.9;">你已经准备好开始真正的冒险了</p>
        <div style="margin-top: 20px; padding: 15px; background: rgba(255,255,255,0.2); border-radius: 12px;">
          <p style="margin: 0; font-size: 14px;">🎁 完成奖励已发放</p>
        </div>
        <button class="start-adventure-btn">开始冒险</button>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.start-adventure-btn').addEventListener('click', () => {
      modal.remove();
      // 刷新页面或跳转
      window.location.reload();
    });
  }

  showRewardAnimation(rewards) {
    const rewardText = Object.entries(rewards)
      .map(([type, amount]) => `${type}: ${amount}`)
      .join(', ');
    
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 100px;
      left: 50%;
      transform: translateX(-50%);
      background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%);
      color: #333;
      padding: 15px 25px;
      border-radius: 12px;
      font-weight: 600;
      z-index: 10002;
      animation: slideUp 0.3s ease;
    `;
    toast.textContent = `🎁 ${rewardText}`;
    
    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideUp {
        from { transform: translateX(-50%) translateY(20px); opacity: 0; }
        to { transform: translateX(-50%) translateY(0); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(toast);
    
    setTimeout(() => toast.remove(), 3000);
  }

  hideOverlay() {
    if (this.overlay) {
      this.overlay.classList.remove('visible');
    }
  }

  destroy() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }
}

// 自动初始化
if (typeof window !== 'undefined') {
  window.TutorialOverlay = TutorialOverlay;
  
  // 页面加载后自动启动
  document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    if (token) {
      window.tutorialOverlay = new TutorialOverlay();
    }
  });
}

module.exports = TutorialOverlay;
