const express = require('express');
const { pluginManager } = require('../plugins/PluginManager');

const router = express.Router();

/**
 * GET /admin/plugins
 * 列出所有插件
 */
router.get('/', async (req, res) => {
  try {
    const status = pluginManager.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/plugins/:name
 * 获取插件详情
 */
router.get('/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const status = pluginManager.getStatus();
    const plugin = status.plugins.find(p => p.name === name);
    
    if (!plugin) {
      return res.status(404).json({ error: 'Plugin not found' });
    }
    
    res.json(plugin);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/plugins/:name/enable
 * 启用插件
 */
router.post('/:name/enable', async (req, res) => {
  try {
    const { name } = req.params;
    const config = req.body || {};
    
    await pluginManager.enable(name, config);
    
    res.json({
      success: true,
      message: `Plugin "${name}" enabled`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /admin/plugins/:name/disable
 * 禁用插件
 */
router.post('/:name/disable', async (req, res) => {
  try {
    const { name } = req.params;
    
    await pluginManager.disable(name);
    
    res.json({
      success: true,
      message: `Plugin "${name}" disabled`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /admin/plugins/:name/config
 * 更新插件配置
 */
router.put('/:name/config', async (req, res) => {
  try {
    const { name } = req.params;
    const newConfig = req.body;
    
    await pluginManager.updateConfig(name, newConfig);
    
    res.json({
      success: true,
      message: `Plugin "${name}" config updated`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /admin/plugins/:name/health
 * 健康检查
 */
router.get('/:name/health', async (req, res) => {
  try {
    const { name } = req.params;
    const health = await pluginManager.healthCheck(name);
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/plugins/health
 * 所有插件健康检查
 */
router.get('/health/all', async (req, res) => {
  try {
    const health = await pluginManager.healthCheck();
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
