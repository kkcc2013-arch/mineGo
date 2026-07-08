/**
 * 依赖解析器 - 拓扑排序解析插件初始化顺序
 * REQ-00505: 插件生命周期管理与热插拔系统
 */

class DependencyResolver {
  constructor() {
    this.graph = new Map(); // 邻接表：节点 → 依赖列表
  }

  /**
   * 添加节点及其依赖
   * @param {string} node 节点名称
   * @param {string[]} dependencies 依赖列表
   */
  addNode(node, dependencies = []) {
    if (!this.graph.has(node)) {
      this.graph.set(node, []);
    }
    this.graph.set(node, dependencies);
    
    // 确保依赖节点存在（空依赖）
    for (const dep of dependencies) {
      if (!this.graph.has(dep)) {
        this.graph.set(dep, []);
      }
    }
  }

  /**
   * 移除节点
   * @param {string} node 节点名称
   */
  removeNode(node) {
    this.graph.delete(node);
  }

  /**
   * 拓扑排序解析初始化顺序
   * @returns {string[]} 初始化顺序
   * @throws {Error} 如果存在循环依赖或缺失依赖
   */
  resolve() {
    const visited = new Set();
    const visiting = new Set();
    const result = [];

    const visit = (node) => {
      if (visited.has(node)) return;
      if (visiting.has(node)) {
        throw new Error(`Circular dependency detected involving: ${node}`);
      }

      visiting.add(node);

      const dependencies = this.graph.get(node) || [];
      for (const dep of dependencies) {
        if (!this.graph.has(dep)) {
          throw new Error(`Missing dependency: ${node} depends on ${dep} which is not registered`);
        }
        visit(dep);
      }

      visiting.delete(node);
      visited.add(node);
      result.push(node);
    };

    for (const node of this.graph.keys()) {
      visit(node);
    }

    return result;
  }

  /**
   * 获取依赖指定节点的所有节点（反向依赖）
   * @param {string} node 节点名称
   * @returns {string[]} 依赖此节点的节点列表
   */
  getDependents(node) {
    const dependents = [];
    for (const [name, deps] of this.graph) {
      if (deps.includes(node)) {
        dependents.push(name);
      }
    }
    return dependents;
  }

  /**
   * 检测循环依赖
   * @returns {string|null} 循环依赖描述，无循环则返回 null
   */
  detectCycle() {
    try {
      this.resolve();
      return null;
    } catch (error) {
      return error.message;
    }
  }

  /**
   * 获取所有节点
   * @returns {string[]}
   */
  getNodes() {
    return Array.from(this.graph.keys());
  }

  /**
   * 获取节点的直接依赖
   * @param {string} node 节点名称
   * @returns {string[]}
   */
  getDependencies(node) {
    return this.graph.get(node) || [];
  }

  /**
   * 清空图
   */
  clear() {
    this.graph.clear();
  }
}

module.exports = DependencyResolver;