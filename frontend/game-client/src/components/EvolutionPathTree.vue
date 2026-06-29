/**
 * REQ-00355: 精灵进化路径可视化系统
 * Vue 组件 - 进化路径树形图
 */

<template>
  <div class="evolution-path-tree">
    <!-- 标题 -->
    <div class="evolution-header">
      <h3>进化路径</h3>
      <div class="evolution-legend">
        <span class="legend-item" v-for="type in evolutionTypes" :key="type.code">
          <span class="legend-dot" :class="type.code"></span>
          {{ type.name }}
        </span>
      </div>
    </div>

    <!-- 进化树 SVG 画布 -->
    <svg class="evolution-svg" :width="svgWidth" :height="svgHeight">
      <!-- 连接线 -->
      <g class="evolution-links">
        <path
          v-for="link in links"
          :key="link.id"
          :d="link.path"
          :class="['evolution-link', link.evolutionType]"
          :marker-end="`url(#arrow-${link.evolutionType})`"
          @click="showEvolutionDetails(link)"
        />
      </g>

      <!-- 节点 -->
      <g class="evolution-nodes">
        <g
          v-for="node in visibleNodes"
          :key="node.id"
          :transform="`translate(${node.x}, ${node.y})`"
          :class="['evolution-node', { 
            current: node.speciesId === currentSpeciesId,
            clickable: node.evolutionPaths.length > 0 
          }]"
          @click="selectNode(node)"
        >
          <!-- 精灵头像 -->
          <image
            :href="node.sprite"
            :x="-30"
            :y="-30"
            :width="60"
            :height="60"
            class="node-image"
          />
          
          <!-- 当前精灵标记 -->
          <circle
            v-if="node.speciesId === currentSpeciesId"
            r="35"
            class="current-marker"
          />
          
          <!-- 新精灵标记 -->
          <circle
            v-if="node.isNew"
            r="32"
            class="new-marker"
          />
          
          <!-- 精灵名字 -->
          <text :y="45" class="node-name">{{ node.name }}</text>
          
          <!-- 类型标签 -->
          <g :y="55" class="node-types">
            <rect
              v-for="(type, idx) in node.types"
              :key="type"
              :x="-15 + idx * 35"
              :y="55"
              :width="30"
              :height="16"
              :class="['type-badge', type.toLowerCase()]"
              rx="3"
            />
            <text
              v-for="(type, idx) in node.types"
              :key="type"
              :x="idx * 35"
              :y="66"
              class="type-text"
            >
              {{ type }}
            </text>
          </g>
        </g>
      </g>

      <!-- 箭头标记定义 -->
      <defs>
        <marker
          v-for="type in evolutionTypes"
          :key="type.code"
          :id="`arrow-${type.code}`"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" :class="`${type.code}-arrow`" />
        </marker>
      </defs>
    </svg>

    <!-- 进化详情弹窗 -->
    <div v-if="selectedEvolution" class="evolution-details-modal">
      <div class="modal-content">
        <button class="close-btn" @click="selectedEvolution = null">✕</button>
        
        <h4>进化详情</h4>
        
        <div class="evolution-info">
          <div class="evolution-type-badge" :class="selectedEvolution.evolutionType">
            {{ selectedEvolution.evolutionTypeName }}
          </div>
          
          <div class="evolution-conditions">
            <h5>进化条件</h5>
            <ul>
              <li v-if="selectedEvolution.conditions.min_level">
                等级达到 {{ selectedEvolution.conditions.min_level }}
              </li>
              <li v-if="selectedEvolution.conditions.candy_required">
                需要 {{ selectedEvolution.conditions.candy_required }} 糖果
              </li>
              <li v-if="selectedEvolution.conditions.min_friendship">
                亲密度达到 {{ selectedEvolution.conditions.min_friendship }}
              </li>
              <li v-if="selectedEvolution.conditions.item_id">
                需要特定道具
              </li>
              <li v-if="selectedEvolution.conditions.time_range">
                时间：{{ formatTimeRange(selectedEvolution.conditions.time_range) }}
              </li>
            </ul>
          </div>
          
          <div class="stat-changes" v-if="selectedEvolution.statChanges">
            <h5>属性变化</h5>
            <div class="stat-change-item" v-for="(change, stat) in selectedEvolution.statChanges" :key="stat">
              <span class="stat-name">{{ formatStatName(stat) }}</span>
              <span :class="['stat-value', change >= 0 ? 'positive' : 'negative']">
                {{ change >= 0 ? '+' : '' }}{{ change }}
              </span>
            </div>
          </div>
          
          <div v-if="selectedEvolution.hint" class="evolution-hint">
            💡 {{ selectedEvolution.hint }}
          </div>
        </div>
      </div>
    </div>

    <!-- 进化预览按钮（如果有进化路径） -->
    <button
      v-if="canEvolve && userPokemonId"
      class="preview-evolution-btn"
      @click="showEvolutionPreview"
    >
      预览进化效果
    </button>
  </div>
</template>

<script>
import { ref, computed, onMounted, watch } from 'vue';
import axios from 'axios';

export default {
  name: 'EvolutionPathTree',
  props: {
    speciesId: { type: Number, required: true },
    userPokemonId: { type: Number, default: null },
    language: { type: String, default: 'zh' }
  },
  
  setup(props) {
    const evolutionChain = ref(null);
    const selectedEvolution = ref(null);
    const evolutionPreview = ref(null);
    
    const NODE_SIZE = 60;
    const NODE_SPACING_X = 180;
    const NODE_SPACING_Y = 120;
    
    const evolutionTypes = [
      { code: 'level', name: '等级进化' },
      { code: 'item', name: '道具进化' },
      { code: 'friendship', name: '亲密度进化' },
      { code: 'time', name: '时间进化' },
      { code: 'trade', name: '交换进化' },
      { code: 'special', name: '特殊进化' }
    ];
    
    // 加载进化链数据
    const loadEvolutionChain = async () => {
      try {
        const response = await axios.get(
          `/api/pokemon/species/${props.speciesId}/evolution-chain`,
          { headers: { 'X-Language': props.language } }
        );
        evolutionChain.value = response.data.data;
      } catch (error) {
        console.error('Failed to load evolution chain:', error);
      }
    };
    
    // 计算节点位置
    const layoutNodes = (nodes) => {
      const root = nodes.find(n => n.isRoot);
      if (!root) return nodes;
      
      const positioned = new Set();
      const queue = [root];
      root.x = svgWidth.value / 2;
      root.y = 50;
      positioned.add(root.id);
      
      while (queue.length > 0) {
        const current = queue.shift();
        
        current.evolutionPaths.forEach((path, idx) => {
          const target = nodes.find(n => n.id === path.targetNodeId);
          if (target && !positioned.has(target.id)) {
            const offsetX = (idx - (current.evolutionPaths.length - 1) / 2) * NODE_SPACING_X;
            target.x = current.x + offsetX;
            target.y = current.y + NODE_SPACING_Y;
            positioned.add(target.id);
            queue.push(target);
          }
        });
      }
      
      return nodes;
    };
    
    const visibleNodes = computed(() => {
      if (!evolutionChain.value) return [];
      return layoutNodes([...evolutionChain.value.nodes]);
    });
    
    const links = computed(() => {
      if (!evolutionChain.value) return [];
      
      const result = [];
      visibleNodes.value.forEach(node => {
        node.evolutionPaths.forEach(path => {
          const target = visibleNodes.value.find(n => n.id === path.targetNodeId);
          if (target) {
            result.push({
              id: `${node.id}-${target.id}`,
              source: node,
              target,
              evolutionType: path.evolutionType,
              path: `M ${node.x} ${node.y + 30} L ${target.x} ${target.y - 30}`,
              conditions: path.conditions,
              statChanges: path.statChanges,
              evolutionTypeName: path.evolutionTypeName,
              hint: path.hint,
              isHidden: path.isHidden
            });
          }
        });
      });
      
      return result;
    });
    
    const svgWidth = computed(() => {
      const maxX = Math.max(...visibleNodes.value.map(n => n.x || 0), 0);
      return Math.max(400, maxX + 200);
    });
    
    const svgHeight = computed(() => {
      const maxY = Math.max(...visibleNodes.value.map(n => n.y || 0), 0);
      return Math.max(300, maxY + 150);
    });
    
    const canEvolve = computed(() => {
      if (!evolutionChain.value) return false;
      const currentNode = evolutionChain.value.nodes.find(
        n => n.speciesId === props.speciesId
      );
      return currentNode && currentNode.evolutionPaths.length > 0;
    });
    
    const currentSpeciesId = computed(() => props.speciesId);
    
    const showEvolutionDetails = (link) => {
      selectedEvolution.value = link;
    };
    
    const selectNode = (node) => {
      // 发送事件通知父组件
      emit('node-selected', node);
    };
    
    const showEvolutionPreview = async () => {
      if (!props.userPokemonId || !evolutionChain.value) return;
      
      const currentNode = evolutionChain.value.nodes.find(
        n => n.speciesId === props.speciesId
      );
      
      if (currentNode && currentNode.evolutionPaths.length > 0) {
        const targetPath = currentNode.evolutionPaths[0];
        
        try {
          const response = await axios.get(
            `/api/pokemon/my/${props.userPokemonId}/evolution-preview`,
            {
              params: { target: targetPath.targetSpeciesId },
              headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            }
          );
          
          evolutionPreview.value = response.data.data;
          emit('preview-available', evolutionPreview.value);
        } catch (error) {
          console.error('Failed to get evolution preview:', error);
        }
      }
    };
    
    const formatStatName = (stat) => {
      const names = {
        hp: 'HP',
        attack: '攻击',
        defense: '防御',
        speed: '速度',
        sp_attack: '特攻',
        sp_defense: '特防'
      };
      return names[stat] || stat;
    };
    
    const formatTimeRange = (range) => {
      if (Array.isArray(range)) {
        return range.map(t => {
          const names = { day: '白天', night: '夜晚' };
          return names[t] || t;
        }).join('/');
      }
      return range;
    };
    
    onMounted(() => {
      loadEvolutionChain();
    });
    
    watch(() => props.speciesId, () => {
      loadEvolutionChain();
    });
    
    return {
      evolutionChain,
      selectedEvolution,
      evolutionTypes,
      visibleNodes,
      links,
      svgWidth,
      svgHeight,
      canEvolve,
      currentSpeciesId,
      showEvolutionDetails,
      selectNode,
      showEvolutionPreview,
      formatStatName,
      formatTimeRange
    };
  }
};
</script>

<style scoped>
.evolution-path-tree {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 12px;
  padding: 20px;
  color: white;
}

.evolution-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.evolution-legend {
  display: flex;
  gap: 15px;
  font-size: 12px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.legend-dot.level { background: #4CAF50; }
.legend-dot.item { background: #2196F3; }
.legend-dot.friendship { background: #E91E63; }
.legend-dot.time { background: #FF9800; }
.legend-dot.trade { background: #9C27B0; }
.legend-dot.special { background: #607D8B; }

.evolution-svg {
  display: block;
  margin: 0 auto;
}

.evolution-link {
  fill: none;
  stroke-width: 3;
  opacity: 0.7;
  cursor: pointer;
  transition: opacity 0.3s;
}

.evolution-link:hover {
  opacity: 1;
}

.evolution-link.level { stroke: #4CAF50; }
.evolution-link.item { stroke: #2196F3; }
.evolution-link.friendship { stroke: #E91E63; }
.evolution-link.time { stroke: #FF9800; }
.evolution-link.trade { stroke: #9C27B0; }
.evolution-link.special { stroke: #607D8B; }

.evolution-node {
  cursor: pointer;
  transition: transform 0.3s;
}

.evolution-node:hover {
  transform: scale(1.1);
}

.node-image {
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.5);
}

.current-marker {
  fill: none;
  stroke: #FFD700;
  stroke-width: 4;
  stroke-dasharray: 5 5;
  animation: rotate 3s linear infinite;
}

@keyframes rotate {
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: 100; }
}

.new-marker {
  fill: none;
  stroke: #4CAF50;
  stroke-width: 3;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.node-name {
  text-anchor: middle;
  font-size: 14px;
  font-weight: bold;
  fill: white;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.8);
}

.type-badge {
  opacity: 0.9;
}

.type-text {
  text-anchor: middle;
  font-size: 10px;
  fill: white;
  font-weight: bold;
}

.evolution-details-modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: white;
  border-radius: 12px;
  padding: 30px;
  max-width: 500px;
  color: #333;
  position: relative;
}

.close-btn {
  position: absolute;
  top: 15px;
  right: 15px;
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
}

.evolution-type-badge {
  display: inline-block;
  padding: 5px 15px;
  border-radius: 20px;
  color: white;
  font-weight: bold;
  margin-bottom: 15px;
}

.evolution-type-badge.level { background: #4CAF50; }
.evolution-type-badge.item { background: #2196F3; }
.evolution-type-badge.friendship { background: #E91E63; }

.evolution-conditions ul {
  list-style: none;
  padding-left: 0;
}

.evolution-conditions li {
  padding: 8px 0;
  border-bottom: 1px solid #eee;
}

.stat-change-item {
  display: flex;
  justify-content: space-between;
  padding: 5px 0;
}

.stat-value.positive {
  color: #4CAF50;
}

.stat-value.negative {
  color: #f44336;
}

.evolution-hint {
  background: #FFF3E0;
  padding: 10px;
  border-radius: 6px;
  margin-top: 15px;
}

.preview-evolution-btn {
  width: 100%;
  padding: 15px;
  background: #4CAF50;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  margin-top: 20px;
  transition: background 0.3s;
}

.preview-evolution-btn:hover {
  background: #45a049;
}
</style>
