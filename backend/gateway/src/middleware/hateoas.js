/**
 * HATEOAS 中间件
 * REQ-00518: API 超媒体链接（HATEOAS）与资源发现系统
 * 
 * 自动为 API 响应添加 HATEOAS 链接
 */

'use strict';

const { createLogger } = require('../../../shared/logger');
const { defaultLinkBuilder } = require('../../../shared/utils/LinkBuilder');
const { defaultHalFormatter } = require('../../../shared/utils/HalFormatter');

const logger = createLogger('hateoas-middleware');

/**
 * HATEOAS 中间件配置
 */
const defaultConfig = {
  enabled: true,
  autoAddLinks: true,
  autoAddPagination: true,
  includeActions: true,
  discoverPath: '/api/discover'
};

/**
 * 创建 HATEOAS 中间件
 * @param {Object} config - 配置
 * @returns {Function} Express 中间件
 */
function createHateoasMiddleware(config = {}) {
  const options = { ...defaultConfig, ...config };
  
  return (req, res, next) => {
    // 如果禁用，跳过
    if (!options.enabled) {
      return next();
    }
    
    // 添加 Link header 到响应
    res.on('finish', () => {
      if (res._links) {
        const linkHeader = _formatLinkHeader(res._links);
        res.setHeader('Link', linkHeader);
      }
    });
    
    // 保存原始 json 方法
    const originalJson = res.json.bind(res);
    
    // 重写 json 方法以自动添加链接
    res.json = function (data) {
      // 检查是否需要添加链接
      if (options.autoAddLinks && _shouldAddLinks(req, data)) {
        const resourceType = _inferResourceType(req);
        
        if (resourceType) {
          // 添加 self 链接
          if (!data._links) {
            data._links = {};
          }
          
          if (!data._links.self) {
            data._links.self = {
              href: req.originalUrl,
              method: req.method,
              title: `${resourceType} resource`
            };
          }
          
          // 添加发现链接
          if (!data._links.discover) {
            data._links.discover = {
              href: options.discoverPath,
              method: 'GET',
              title: 'API Resource Discovery'
            };
          }
          
          // 分页数据添加分页链接
          if (options.autoAddPagination && data.pagination) {
            const paginationLinks = _buildPaginationLinks(req, resourceType, data.pagination);
            Object.assign(data._links, paginationLinks);
          }
          
          // 添加操作链接（根据资源类型）
          if (options.includeActions && !req._skipActions) {
            const actionLinks = _buildActionLinks(resourceType, req.params.id);
            Object.assign(data._links, actionLinks);
          }
          
          // 保存链接用于 Link header
          res._links = data._links;
        }
      }
      
      return originalJson(data);
    };
    
    next();
  };
}

/**
 * 判断是否需要添加链接
 */
function _shouldAddLinks(req, data) {
  // 跳过错误响应
  if (data && data.error) return false;
  
  // 跳过已包含 _links 的响应
  if (data && data._links) return true;
  
  // 跳过数组响应（需要特定处理）
  if (Array.isArray(data)) return false;
  
  // 只处理 GET 请求
  if (req.method !== 'GET') return false;
  
  // 跳过非 API 路径
  if (!req.path.startsWith('/api/')) return false;
  
  return true;
}

/**
 * 推断资源类型
 */
function _inferResourceType(req) {
  const path = req.path;
  
  // 解析路径：/api/v1/pokemon/123 -> pokemon
  const parts = path.split('/').filter(p => p);
  
  // 跳过 api 和版本号
  if (parts.length < 3) return null;
  
  // 第三个部分是资源类型
  return parts[2];
}

/**
 * 构建分页链接
 */
function _buildPaginationLinks(req, resourceType, pagination) {
  const baseUrl = req.baseUrl || req.path.replace(/\?.*$/, '');
  
  return defaultLinkBuilder.buildPaginationLinks(baseUrl, pagination, req.query);
}

/**
 * 构建操作链接
 */
function _buildActionLinks(resourceType, resourceId) {
  const actions = defaultLinkBuilder._getAvailableActions(resourceType);
  const links = {};
  
  for (const action of actions) {
    links[action] = defaultLinkBuilder.buildActionLink(resourceType, resourceId, action);
  }
  
  return links;
}

/**
 * 格式化 Link header
 */
function _formatLinkHeader(links) {
  if (!links || typeof links !== 'object') return '';
  
  return Object.entries(links)
    .map(([rel, link]) => {
      const href = link.href || link;
      const title = link.title ? `; title="${link.title}"` : '';
      return `<${href}>; rel="${rel}"${title}`;
    })
    .join(', ');
}

/**
 * 资源类型标记中间件
 * 用于显式指定资源类型
 */
function resourceTypeMiddleware(resourceType) {
  return (req, res, next) => {
    req._resourceType = resourceType;
    next();
  };
}

/**
 * 跳过操作链接中间件
 */
function skipActionsMiddleware() {
  return (req, res, next) => {
    req._skipActions = true;
    next();
  };
}

/**
 * HAL 响应中间件
 * 强制使用 HAL 格式
 */
function halResponseMiddleware(resourceType) {
  return (req, res, next) => {
    req._hal = true;
    req._resourceType = resourceType || _inferResourceType(req);
    
    // 保存原始 json 方法
    const originalJson = res.json.bind(res);
    
    // 重写为 HAL 格式
    res.json = function (data) {
      if (req._hal && req._resourceType && data) {
        // 使用 HAL 格式化
        data = defaultHalFormatter.formatResource(data, req._resourceType, {
          context: req._context || {}
        });
        
        // 添加发现链接
        if (!data._links.discover) {
          data._links.discover = {
            href: defaultConfig.discoverPath,
            method: 'GET',
            title: 'API Resource Discovery'
          };
        }
      }
      
      return originalJson(data);
    };
    
    next();
  };
}

/**
 * HAL 分页响应中间件
 */
function halPaginatedMiddleware(resourceType) {
  return (req, res, next) => {
    req._hal = true;
    req._halPaginated = true;
    req._resourceType = resourceType || _inferResourceType(req);
    
    // 保存原始 json 方法
    const originalJson = res.json.bind(res);
    
    // 重写为 HAL 分页格式
    res.json = function (data) {
      if (req._hal && req._halPaginated && req._resourceType && data) {
        if (data.data && Array.isArray(data.data) && data.pagination) {
          // 使用 HAL 分页格式化
          data = defaultHalFormatter.formatPaginatedResponse(
            data.data,
            req._resourceType,
            data.pagination,
            { query: req.query }
          );
          
          // 添加发现链接
          if (!data._links.discover) {
            data._links.discover = {
              href: defaultConfig.discoverPath,
              method: 'GET',
              title: 'API Resource Discovery'
            };
          }
        }
      }
      
      return originalJson(data);
    };
    
    next();
  };
}

/**
 * 上下文中间件
 * 用于传递额外的上下文信息
 */
function contextMiddleware(context) {
  return (req, res, next) => {
    req._context = context;
    next();
  };
}

/**
 * Link header 解析器
 * 用于客户端解析 Link header
 */
function parseLinkHeader(linkHeader) {
  if (!linkHeader) return {};
  
  const links = {};
  const parts = linkHeader.split(',');
  
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"(?:;\s*title="([^"]+)")?/);
    if (match) {
      links[match[2]] = {
        href: match[1],
        title: match[3] || null
      };
    }
  }
  
  return links;
}

module.exports = {
  createHateoasMiddleware,
  resourceTypeMiddleware,
  skipActionsMiddleware,
  halResponseMiddleware,
  halPaginatedMiddleware,
  contextMiddleware,
  parseLinkHeader,
  defaultConfig
};