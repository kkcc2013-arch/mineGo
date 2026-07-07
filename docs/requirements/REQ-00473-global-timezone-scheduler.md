# REQ-00473: 全球化环境下多时区动态调度补偿系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00473 |
| 标题 | 全球化环境下多时区动态调度补偿系统 |
| 类别 | 国际化/本地化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | scheduler-service/shared/timezone-lib |
| 创建时间 | 2026-07-07 11:00 |

## 需求描述

随着 mineGo 全球化扩张，玩家位于全球不同时区。目前的定时任务（如每日任务结算、活动过期）依赖服务器本地时间或单一 UTC 时间，导致部分地区玩家体验不佳（例如：下午 3 点结算“每日凌晨”任务）。本项目需要建立一个动态调度补偿系统，根据玩家所属时区动态计算任务结算时间，并确保同一活动在不同地区能触发合适的补偿逻辑。

## 技术方案

### 1. 时区感知模型
- 在 `user-service` 中增加 `user_timezone` 属性存储。
- 建立时区偏移补偿机制，将 UTC 活动时间转化为用户本地时间。

### 2. 调度引擎改造
- 调度中心支持按 `zone_id` 分组的 Job 执行流。
- 引入 `JobCompensationManager`，处理跨时区触发冲突。

### 3. 代码示例（伪代码）
```python
def get_scheduled_time(user_tz, activity_utc_time):
    # 将活动UTC时间转换为玩家本地时区时间
    local_time = convert_timezone(activity_utc_time, user_tz)
    return local_time

def process_compensation(user_id, task_id):
    # 逻辑：检查用户是否因为时区变动错过了领取窗口
    if is_eligible_for_compensation(user_id, task_id):
        grant_compensation(user_id, task_id)
```

## 验收标准

- [ ] 实现用户时区存储与读取接口
- [ ] 调度引擎支持按时区参数化任务触发
- [ ] 针对错过的任务实现自动补偿机制
- [ ] 编写对应的单元测试覆盖不同时区的临界点测试

## 影响范围

- `scheduler-service`
- `user-service`
- `shared/timezone-lib`

## 参考

- [国际化设计最佳实践](https://example.com/i18n-design)
