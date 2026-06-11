# REQ-00123: pokemon-service showcase 路由挂载与集成

- 类别: 集成与修复
- 优先级: P0
- 父需求: REQ-00055（精灵收藏展示系统）

## 背景与价值

showcase.js 路由文件已存在（281 行，11 个端点），但从未挂载到 pokemon-service 的 index.js，导致 REQ-00055（精灵收藏展示系统）的功能无法使用。用户无法：
- 收藏精灵
- 查看其他玩家的展示页
- 点赞和评语互动
- 查看排行榜

挂载后立即可用，无需额外开发。

## 验收标准（必填，必须是可执行命令）

- [ ] `node --check backend/services/pokemon-service/src/index.js` 通过
- [ ] `grep -n "showcaseRouter" backend/services/pokemon-service/src/index.js` 返回匹配行
- [ ] `curl -sf http://localhost:8083/pokemon/favorites -H "Authorization: Bearer <token>"` 返回非 404
- [ ] `curl -sf http://localhost:8083/pokemon/showcase/leaderboard` 返回 200 或 401（无认证）

## 完成定义（DoD）

代码已提交 + 路由挂载验证 + CI 绿 = 完成。

## 涉及端点（共 11 个）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/pokemon/favorites` | 获取收藏列表 |
| POST | `/pokemon/favorites` | 添加收藏 |
| DELETE | `/pokemon/favorites/:pokemonId` | 移除收藏 |
| PUT | `/pokemon/favorites/reorder` | 重排序收藏 |
| POST | `/pokemon/:pokemonId/like` | 点赞精灵 |
| DELETE | `/pokemon/:pokemonId/like` | 取消点赞 |
| GET | `/pokemon/:pokemonId/liked` | 检查点赞状态 |
| POST | `/pokemon/:pokemonId/comments` | 添加评语 |
| GET | `/pokemon/:pokemonId/comments` | 获取评语列表 |
| DELETE | `/pokemon/comments/:commentId` | 删除评语 |
| GET | `/pokemon/showcase/leaderboard` | 获取排行榜 |

## 实现方案

### 1. 挂载路由到 pokemon-service

在 `/data/mineGo/backend/services/pokemon-service/src/index.js` 添加：

```javascript
// REQ-00123: 精灵收藏展示系统路由
const showcaseRouter = require('./routes/showcase');
app.use('/pokemon', showcaseRouter);
```

### 2. 验证依赖

确保 `showcaseService.js` 存在且可加载：

```bash
node -e "require('/data/mineGo/backend/services/pokemon-service/src/showcaseService')"
```

## 影响范围

- 修改文件：`backend/services/pokemon-service/src/index.js`（新增 2 行）
- 解锁功能：REQ-00055 的全部 11 个端点

## 参考

- REQ-00055: 精灵收藏展示系统
- GUIDELINES.md §6 欠账清单
