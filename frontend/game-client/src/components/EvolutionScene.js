/**
 * REQ-00065: 精灵进化与成长系统
 * 前端进化场景组件
 */

class EvolutionScene {
    constructor() {
        this.animationContainer = null;
        this.audioContext = null;
        this.isAnimating = false;
    }

    /**
     * 显示进化预览
     */
    async showEvolutionPreview(pokemon, evolutionData) {
        const modal = document.createElement('div');
        modal.className = 'evolution-preview-modal';
        modal.innerHTML = `
            <div class="evolution-preview-content">
                <h2>进化可用!</h2>
                
                <div class="evolution-comparison">
                    <div class="pokemon-before">
                        <img src="${pokemon.imageUrl}" alt="${pokemon.name}">
                        <h3>${pokemon.name}</h3>
                        <div class="stats">
                            <p>CP: ${pokemon.cp}</p>
                            <p>等级: ${pokemon.level || 1}</p>
                        </div>
                    </div>
                    
                    <div class="evolution-arrow">
                        <span class="arrow-icon">→</span>
                    </div>
                    
                    <div class="pokemon-after">
                        <img src="${evolutionData.preview.targetSpecies.imageUrl}" 
                             alt="${evolutionData.preview.targetSpecies.name}"
                             class="silhouette">
                        <h3>${evolutionData.preview.targetSpecies.name}</h3>
                        <div class="stats-preview">
                            <p>CP: ${pokemon.cp + evolutionData.preview.statsChange.cp} 
                               <span class="change positive">(+${evolutionData.preview.statsChange.cp})</span></p>
                        </div>
                    </div>
                </div>
                
                <div class="requirements">
                    ${this.renderRequirements(evolutionData.requirements)}
                </div>
                
                <div class="evolution-buttons">
                    <button class="btn-evolve" data-species="${evolutionData.toSpeciesId}">
                        立即进化
                    </button>
                    <button class="btn-cancel">稍后再说</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // 绑定事件
        modal.querySelector('.btn-evolve').addEventListener('click', async () => {
            await this.startEvolution(pokemon, evolutionData);
            modal.remove();
        });
        
        modal.querySelector('.btn-cancel').addEventListener('click', () => {
            modal.remove();
        });
    }

    /**
     * 渲染需求条件
     */
    renderRequirements(requirements) {
        if (!requirements) return '';
        
        let html = '<div class="requirements-list">';
        
        switch (requirements.type) {
            case 'level':
                html += `<p class="${requirements.met ? 'met' : 'unmet'}">
                    等级需求: ${requirements.required} 
                    ${requirements.met ? '✓' : `(当前: ${requirements.current})`}
                </p>`;
                break;
                
            case 'item':
                html += `<p class="${requirements.met ? 'met' : 'unmet'}">
                    需要道具: ${requirements.itemName}
                    ${requirements.met ? `✓ (${requirements.quantityOwned}个)` : '(缺少)'}
                </p>`;
                break;
                
            case 'condition':
                if (requirements.checks) {
                    requirements.checks.forEach(check => {
                        html += `<p class="${check.met ? 'met' : 'unmet'}">
                            ${this.getConditionLabel(check.type, check)}
                            ${check.met ? '✓' : ''}
                        </p>`;
                    });
                }
                break;
        }
        
        html += '</div>';
        return html;
    }

    /**
     * 获取条件标签
     */
    getConditionLabel(type, check) {
        const labels = {
            friendship: `亲密度: ${check.required} (当前: ${check.current})`,
            time: `时间: ${check.required === 'day' ? '白天' : '夜晚'} (当前: ${check.current === 'day' ? '白天' : '夜晚'})`,
            location: `地点: ${check.required}`,
            weather: `天气: ${check.required}`,
            moves: `招式: ${check.required?.join(', ')}`,
            attack_gt_defense: `攻击力 > 防御力`
        };
        return labels[type] || type;
    }

    /**
     * 开始进化动画
     */
    async startEvolution(pokemon, evolutionData) {
        if (this.isAnimating) return;
        this.isAnimating = true;
        
        // 创建进化场景
        const scene = document.createElement('div');
        scene.className = 'evolution-scene';
        scene.innerHTML = `
            <div class="evolution-bg"></div>
            <div class="evolution-pokemon-container">
                <div class="evolution-light-beams"></div>
                <img src="${pokemon.imageUrl}" class="evolution-pokemon from" alt="">
                <img src="${evolutionData.preview.targetSpecies.imageUrl}" 
                     class="evolution-pokemon to hidden" alt="">
                <div class="evolution-particles"></div>
            </div>
            <div class="evolution-text">
                <p class="evolving-text">什么？${pokemon.name}开始进化了！</p>
                <p class="evolved-text hidden">恭喜！你的${pokemon.name}进化成了${evolutionData.preview.targetSpecies.name}！</p>
            </div>
            <div class="evolution-progress">
                <div class="progress-bar"></div>
            </div>
        `;
        
        document.body.appendChild(scene);
        
        // 播放音效
        this.playEvolutionSound('start');
        
        // 执行动画序列
        await this.runEvolutionAnimation(scene, evolutionData);
        
        // 调用 API 执行进化
        try {
            const response = await fetch(`/api/pokemon/${pokemon.id}/evolution/execute`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-user-id': pokemon.userId
                },
                body: JSON.stringify({ 
                    targetSpeciesId: evolutionData.toSpeciesId 
                })
            });
            
            const result = await response.json();
            
            if (result.success) {
                // 显示进化结果
                await this.showEvolutionResult(scene, result.data);
                
                // 显示奖励
                if (result.data.rewards) {
                    this.showRewards(result.data.rewards);
                }
            } else {
                this.showError(scene, result.message);
            }
        } catch (error) {
            console.error('Evolution failed:', error);
            this.showError(scene, error.message);
        }
        
        this.isAnimating = false;
    }

    /**
     * 运行进化动画
     */
    async runEvolutionAnimation(scene, evolutionData) {
        const animation = evolutionData.animation || { duration: 3000, particles: 50 };
        const fromPokemon = scene.querySelector('.evolution-pokemon.from');
        const toPokemon = scene.querySelector('.evolution-pokemon.to');
        const particles = scene.querySelector('.evolution-particles');
        const progressBar = scene.querySelector('.progress-bar');
        
        // 阶段 1：闪烁（0-30%）
        for (let i = 0; i < 10; i++) {
            fromPokemon.style.filter = `brightness(${1 + Math.random() * 0.5})`;
            await this.sleep(100);
        }
        
        // 阶段 2：光芒爆发（30-60%）
        this.playEvolutionSound('flash');
        await this.createLightBeams(scene);
        
        // 阶段 3：形态转换（60-90%）
        fromPokemon.classList.add('transforming');
        
        // 创建粒子效果
        for (let i = 0; i < animation.particles; i++) {
            this.createParticle(particles);
        }
        
        // 渐变过渡
        await this.sleep(500);
        toPokemon.classList.remove('hidden');
        fromPokemon.style.opacity = '0';
        toPokemon.style.opacity = '1';
        
        this.playEvolutionSound('transform');
        
        // 阶段 4：完成（90-100%）
        await this.sleep(animation.duration * 0.1);
        
        // 更新进度条
        progressBar.style.width = '100%';
    }

    /**
     * 创建粒子
     */
    createParticle(container) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.cssText = `
            left: ${50 + (Math.random() - 0.5) * 100}%;
            top: ${50 + (Math.random() - 0.5) * 100}%;
            width: ${3 + Math.random() * 5}px;
            height: ${3 + Math.random() * 5}px;
            background: hsl(${Math.random() * 60 + 180}, 100%, 70%);
            animation: particle-float ${1 + Math.random() * 2}s ease-out forwards;
        `;
        container.appendChild(particle);
        
        setTimeout(() => particle.remove(), 3000);
    }

    /**
     * 创建光芒射线
     */
    async createLightBeams(scene) {
        const container = scene.querySelector('.evolution-light-beams');
        
        for (let i = 0; i < 12; i++) {
            const beam = document.createElement('div');
            beam.className = 'light-beam';
            beam.style.cssText = `
                transform: rotate(${i * 30}deg);
                animation: beam-pulse 0.5s ease-out ${i * 0.05}s;
            `;
            container.appendChild(beam);
        }
        
        await this.sleep(500);
    }

    /**
     * 播放进化音效
     */
    playEvolutionSound(phase) {
        if (!this.audioContext) {
            try {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                return; // 音频不可用
            }
        }
        
        const sounds = {
            start: { frequency: 440, duration: 0.5, type: 'sine' },
            flash: { frequency: 880, duration: 0.3, type: 'square' },
            transform: { frequency: 660, duration: 0.8, type: 'sine' },
            complete: { frequency: 523, duration: 1.2, type: 'sine' }
        };
        
        const sound = sounds[phase];
        if (!sound) return;
        
        try {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.frequency.value = sound.frequency;
            oscillator.type = sound.type;
            
            gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + sound.duration);
            
            oscillator.start();
            oscillator.stop(this.audioContext.currentTime + sound.duration);
        } catch (e) {
            // 音频播放失败，静默处理
        }
    }

    /**
     * 显示进化结果
     */
    async showEvolutionResult(scene, data) {
        const evolvingText = scene.querySelector('.evolving-text');
        const evolvedText = scene.querySelector('.evolved-text');
        
        evolvingText.classList.add('hidden');
        evolvedText.classList.remove('hidden');
        
        this.playEvolutionSound('complete');
        
        // 显示属性变化
        const statsPanel = document.createElement('div');
        statsPanel.className = 'evolution-stats-panel';
        statsPanel.innerHTML = `
            <h3>属性变化</h3>
            <div class="stats-grid">
                <div class="stat-row">
                    <span>CP</span>
                    <span class="old">${data.evolution.beforeStats.cp}</span>
                    <span class="arrow">→</span>
                    <span class="new">${data.evolution.afterStats.cp}</span>
                    <span class="change positive">+${data.evolution.statsChange.cp}</span>
                </div>
                <div class="stat-row">
                    <span>HP</span>
                    <span class="old">${data.evolution.beforeStats.hp}</span>
                    <span class="arrow">→</span>
                    <span class="new">${data.evolution.afterStats.totalHp}</span>
                    <span class="change positive">+${data.evolution.statsChange.hp}</span>
                </div>
                <div class="stat-row">
                    <span>攻击</span>
                    <span class="old">${data.evolution.beforeStats.attack}</span>
                    <span class="arrow">→</span>
                    <span class="new">${data.evolution.afterStats.attack}</span>
                    <span class="change positive">+${data.evolution.statsChange.attack}</span>
                </div>
                <div class="stat-row">
                    <span>防御</span>
                    <span class="old">${data.evolution.beforeStats.defense}</span>
                    <span class="arrow">→</span>
                    <span class="new">${data.evolution.afterStats.defense}</span>
                    <span class="change positive">+${data.evolution.statsChange.defense}</span>
                </div>
            </div>
        `;
        
        scene.appendChild(statsPanel);
        
        // 等待用户确认
        await new Promise(resolve => {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'btn-close-evolution';
            closeBtn.textContent = '太棒了！';
            closeBtn.onclick = () => {
                scene.remove();
                resolve();
            };
            scene.appendChild(closeBtn);
        });
    }

    /**
     * 显示错误
     */
    showError(scene, message) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'evolution-error';
        errorDiv.innerHTML = `
            <p>进化失败: ${message}</p>
            <button class="btn-close-error">关闭</button>
        `;
        scene.appendChild(errorDiv);
        
        errorDiv.querySelector('.btn-close-error').onclick = () => {
            scene.remove();
        };
    }

    /**
     * 显示奖励
     */
    showRewards(rewards) {
        const toast = document.createElement('div');
        toast.className = 'rewards-toast';
        toast.innerHTML = `
            <h4>进化奖励</h4>
            <p>星尘: +${rewards.stardust}</p>
            <p>糖果: +${rewards.candy}</p>
            <p>经验: +${rewards.experience}</p>
        `;
        document.body.appendChild(toast);
        
        setTimeout(() => toast.remove(), 5000);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { EvolutionScene };
}
