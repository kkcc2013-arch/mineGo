/**
 * REQ-00054: 道馆战斗系统 - 前端战斗场景组件
 * 创建时间: 2026-06-09 16:00
 * 
 * 功能:
 * - 战斗场景渲染
 * - 精灵 HP 显示
 * - 技能选择
 * - 战斗日志
 * - 队伍状态
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import './BattleScene.css';

const BattleScene = ({ gymId, teamIds, onBattleEnd }) => {
  const [battleState, setBattleState] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedMove, setSelectedMove] = useState(null);
  const [battleLog, setBattleLog] = useState([]);
  const [currentHp, setCurrentHp] = useState({ attacker: 0, defender: 0 });
  const [animating, setAnimating] = useState(false);
  const logEndRef = useRef(null);

  // 开始战斗
  useEffect(() => {
    const startBattle = async () => {
      try {
        setIsLoading(true);
        setError(null);
        
        const response = await fetch('/api/gym/' + gymId + '/battle/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamIds })
        });
        
        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || '开始战斗失败');
        }
        
        const data = await response.json();
        setBattleState(data);
        setCurrentHp({
          attacker: data.attacker.currentPokemon.currentHp,
          defender: data.defender.currentPokemon.currentHp
        });
        setBattleLog(['战斗开始！']);
        
      } catch (err) {
        console.error('Failed to start battle:', err);
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    if (gymId && teamIds) {
      startBattle();
    }
  }, [gymId, teamIds]);

  // 自动滚动战斗日志
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [battleLog]);

  // 执行回合
  const executeTurn = useCallback(async (moveId) => {
    if (!battleState || isLoading || animating) return;

    setIsLoading(true);
    setSelectedMove(moveId);

    try {
      const response = await fetch('/api/battle/' + battleState.battleId + '/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moveId })
      });
      
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || '执行回合失败');
      }
      
      const data = await response.json();
      
      // 添加战斗日志
      if (data.actions && data.actions.length > 0) {
        const newLogs = data.actions.map(action => action.message).filter(Boolean);
        setBattleLog(prev => [...prev, ...newLogs]);
      }
      
      // 动画效果
      setAnimating(true);
      
      // 更新 HP（带动画）
      if (data.damage) {
        const newAttackerHp = Math.max(0, currentHp.attacker - data.damage.defender);
        const newDefenderHp = Math.max(0, currentHp.defender - data.damage.attacker);
        
        setCurrentHp({ attacker: newAttackerHp, defender: newDefenderHp });
      }
      
      setTimeout(() => {
        setAnimating(false);
        
        // 战斗结束
        if (data.battleEnded) {
          setBattleState(prev => ({ 
            ...prev, 
            ended: true, 
            result: data.battleResult 
          }));
          
          if (onBattleEnd) {
            onBattleEnd(data.battleResult);
          }
        }
        // 切换精灵
        else if (data.attackerFainted && data.nextPokemon) {
          setBattleLog(prev => [...prev, 
            `${battleState.attacker.currentPokemon.species} 倒下了！`,
            `派出 ${data.nextPokemon.species}！`
          ]);
          
          // 更新当前精灵
          setBattleState(prev => ({
            ...prev,
            attacker: {
              ...prev.attacker,
              currentPokemon: data.nextPokemon
            }
          }));
          
          setCurrentHp(prev => ({
            ...prev,
            attacker: data.nextPokemon.currentHp
          }));
        }
        // 防守方切换
        else if (data.defenderFainted && data.nextDefender) {
          setBattleLog(prev => [...prev, 
            `${battleState.defender.currentPokemon.species} 被击败了！`,
            `对方派出了 ${data.nextDefender.species}！`
          ]);
          
          setBattleState(prev => ({
            ...prev,
            defender: {
              ...prev.defender,
              currentPokemon: data.nextDefender
            }
          }));
          
          setCurrentHp(prev => ({
            ...prev,
            defender: data.nextDefender.currentHp
          }));
        }
      }, 500);
      
    } catch (err) {
      console.error('Failed to execute turn:', err);
      setBattleLog(prev => [...prev, `错误: ${err.message}`]);
    } finally {
      setIsLoading(false);
      setSelectedMove(null);
    }
  }, [battleState, isLoading, animating, currentHp, onBattleEnd]);

  // 切换精灵
  const switchPokemon = useCallback(async (pokemonId) => {
    if (!battleState || isLoading) return;
    
    try {
      const response = await fetch('/api/battle/' + battleState.battleId + '/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pokemonId })
      });
      
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || '切换精灵失败');
      }
      
      const data = await response.json();
      
      setBattleState(prev => ({
        ...prev,
        attacker: {
          ...prev.attacker,
          currentPokemon: data.currentPokemon
        }
      }));
      
      setCurrentHp(prev => ({
        ...prev,
        attacker: data.currentPokemon.currentHp
      }));
      
      setBattleLog(prev => [...prev, `切换为 ${data.currentPokemon.species}！`]);
      
    } catch (err) {
      console.error('Failed to switch pokemon:', err);
      setBattleLog(prev => [...prev, `切换失败: ${err.message}`]);
    }
  }, [battleState, isLoading]);

  // HP 条组件
  const HpBar = ({ current, max, label, isPlayer }) => {
    const percentage = Math.max(0, Math.min(100, (current / max) * 100));
    const color = percentage > 50 ? '#4CAF50' : percentage > 25 ? '#FFC107' : '#F44336';

    return (
      <div className={`hp-bar-container ${isPlayer ? 'player' : 'enemy'}`}>
        <span className="hp-label">{label}</span>
        <div className="hp-bar">
          <div 
            className="hp-fill" 
            style={{ width: `${percentage}%`, backgroundColor: color }}
          />
        </div>
        <span className="hp-text">{Math.max(0, Math.floor(current))} / {max}</span>
      </div>
    );
  };

  // 技能按钮组件
  const MoveButton = ({ move, disabled, onClick }) => {
    const typeColors = {
      normal: '#A8A878',
      fire: '#F08030',
      water: '#6890F0',
      electric: '#F8D030',
      grass: '#78C850',
      ice: '#98D8D8',
      fighting: '#C03028',
      poison: '#A040A0',
      ground: '#E0C068',
      flying: '#A890F0',
      psychic: '#F85888',
      bug: '#A8B820',
      rock: '#B8A038',
      ghost: '#705898',
      dragon: '#7038F8',
      dark: '#705848',
      steel: '#B8B8D0',
      fairy: '#EE99AC'
    };

    return (
      <button
        className={`move-button type-${move.type}`}
        style={{ borderColor: typeColors[move.type] || '#888' }}
        onClick={() => onClick(move.id)}
        disabled={disabled}
      >
        <span className="move-name">{move.name}</span>
        <div className="move-info">
          <span className="move-type">{move.type}</span>
          <span className="move-power">威力: {move.power || '-'}</span>
          <span className="move-accuracy">命中: {move.accuracy || 100}%</span>
        </div>
      </button>
    );
  };

  // 加载状态
  if (isLoading && !battleState) {
    return (
      <div className="battle-loading">
        <div className="spinner"></div>
        <p>正在加载战斗...</p>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className="battle-error">
        <h2>⚔️ 战斗加载失败</h2>
        <p>{error}</p>
        <button onClick={() => window.location.reload()}>重试</button>
      </div>
    );
  }

  // 战斗结束
  if (battleState?.ended) {
    const isWin = battleState.result?.result === 'win';
    
    return (
      <div className={`battle-result ${isWin ? 'win' : 'lose'}`}>
        <h2>{isWin ? '🎉 胜利！' : '💔 失败'}</h2>
        
        {battleState.result?.rewards && (
          <div className="rewards">
            <h3>奖励</h3>
            <div className="reward-item">
              <span>声望</span>
              <span>+{battleState.result.rewards.prestigeGained}</span>
            </div>
            <div className="reward-item">
              <span>经验</span>
              <span>+{battleState.result.rewards.experienceGained}</span>
            </div>
            <div className="reward-item">
              <span>金币</span>
              <span>+{battleState.result.rewards.coinsGained}</span>
            </div>
          </div>
        )}
        
        <div className="battle-stats">
          <p>回合数: {battleState.result?.turns || 0}</p>
          <p>战斗时长: {Math.floor((battleState.result?.duration || 0) / 1000)}秒</p>
        </div>
        
        <button className="return-button" onClick={() => window.history.back()}>
          返回地图
        </button>
      </div>
    );
  }

  // 战斗场景
  return (
    <div className="battle-scene">
      {/* 道馆信息 */}
      <div className="gym-info">
        <h3>{battleState?.gym?.name || '道馆'}</h3>
        <p>声望: {battleState?.gym?.prestige || 0}</p>
      </div>

      {/* 战斗场地 */}
      <div className="battle-field">
        {/* 防守方 */}
        <div className="defender-side">
          <HpBar
            current={currentHp.defender}
            max={battleState?.defender?.currentPokemon?.maxHp || 100}
            label={battleState?.defender?.currentPokemon?.species || '???'}
            isPlayer={false}
          />
          <div className={`pokemon-sprite defender ${animating ? 'shake' : ''}`}>
            <img
              src={`/assets/pokemon/${battleState?.defender?.currentPokemon?.id}.png`}
              alt={battleState?.defender?.currentPokemon?.species}
              onError={(e) => {
                e.target.src = '/assets/pokemon/default.png';
              }}
            />
            {battleState?.defender?.teamSize > 1 && (
              <div className="team-indicator">
                {Array.from({ length: battleState.defender.teamSize }, (_, i) => (
                  <span 
                    key={i} 
                    className={`team-dot ${i <= battleState.defender.currentDefenderIndex ? 'active' : ''}`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 攻击方 */}
        <div className="attacker-side">
          <div className={`pokemon-sprite attacker ${animating ? 'shake' : ''}`}>
            <img
              src={`/assets/pokemon/${battleState?.attacker?.currentPokemon?.id}.png`}
              alt={battleState?.attacker?.currentPokemon?.species}
              onError={(e) => {
                e.target.src = '/assets/pokemon/default.png';
              }}
            />
          </div>
          <HpBar
            current={currentHp.attacker}
            max={battleState?.attacker?.currentPokemon?.maxHp || 100}
            label={battleState?.attacker?.currentPokemon?.species || '???'}
            isPlayer={true}
          />
        </div>
      </div>

      {/* 战斗日志 */}
      <div className="battle-log">
        {battleLog.slice(-5).map((log, index) => (
          <p key={index} className="log-entry">{log}</p>
        ))}
        <div ref={logEndRef} />
      </div>

      {/* 技能选择 */}
      <div className="move-selection">
        <h4>选择技能</h4>
        <div className="moves-grid">
          {battleState?.attacker?.currentPokemon?.moves?.map(move => (
            <MoveButton
              key={move.id}
              move={move}
              disabled={isLoading || selectedMove === move.id}
              onClick={executeTurn}
            />
          ))}
          
          {(!battleState?.attacker?.currentPokemon?.moves || 
            battleState.attacker.currentPokemon.moves.length === 0) && (
            <p className="no-moves">该精灵没有可用的技能</p>
          )}
        </div>
      </div>

      {/* 队伍状态 */}
      <div className="team-status">
        {battleState?.attacker?.team?.map((pokemon, index) => {
          const isActive = pokemon.id === battleState?.attacker?.currentPokemon?.id;
          const isFainted = pokemon.currentHp <= 0;
          const hpPercent = (pokemon.currentHp / pokemon.maxHp) * 100;
          
          return (
            <div
              key={pokemon.id}
              className={`team-pokemon ${isActive ? 'active' : ''} ${isFainted ? 'fainted' : ''}`}
              onClick={() => !isActive && !isFainted && switchPokemon(pokemon.id)}
            >
              <img 
                src={`/assets/pokemon/${pokemon.id}.png`}
                alt={pokemon.species}
                onError={(e) => {
                  e.target.src = '/assets/pokemon/default.png';
                }}
              />
              <div className="quick-hp">
                <div 
                  className="quick-hp-bar" 
                  style={{ 
                    width: `${hpPercent}%`,
                    backgroundColor: hpPercent > 50 ? '#4CAF50' : 
                                    hpPercent > 25 ? '#FFC107' : '#F44336'
                  }}
                />
              </div>
              {isFainted && <div className="fainted-overlay">✕</div>}
            </div>
          );
        })}
      </div>

      {/* 加载遮罩 */}
      {isLoading && (
        <div className="loading-overlay">
          <div className="spinner"></div>
        </div>
      )}
    </div>
  );
};

export default BattleScene;
