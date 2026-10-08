'use strict';

// REQ-00076: one stored progress record, transactional updates and actual grants.
const db = require('../../../shared/db');
const {produceEvent} = require('../../../shared/kafka');
const {AppError} = require('../../../shared/auth');
const {register,Counter,Histogram}=require('../../../shared/metrics');
const achievementMetrics={
  unlocked:register.getSingleMetric('minego_achievement_unlocks_total')||new Counter({name:'minego_achievement_unlocks_total',help:'Committed modern achievement completions',labelNames:['category'],registers:[register]}),
  claimed:register.getSingleMetric('minego_achievement_reward_claims_total')||new Counter({name:'minego_achievement_reward_claims_total',help:'Committed achievement reward grants',registers:[register]}),
  progress:register.getSingleMetric('minego_achievement_progress_update_duration_seconds')||new Histogram({name:'minego_achievement_progress_update_duration_seconds',help:'Actual achievement progress transaction duration',buckets:[0.005,0.01,0.025,0.05,0.1,0.5,1],registers:[register]})
};
const ACHIEVEMENT_CATEGORIES = {CATCH:'catch',BREED:'breed',BATTLE:'battle',SOCIAL:'social',EXPLORE:'explore'};
const ACHIEVEMENT_RARITIES = {COMMON:'common',RARE:'rare',EPIC:'epic',LEGENDARY:'legendary'};
const ballColumns = {pokeball:'pokeball_count',poke_ball:'pokeball_count',great_ball:'greatball_count',ultra_ball:'ultraball_count',master_ball:'masterball_count'};
function failure(message,status=400){return new AppError(status===404?'NOT_FOUND':status===503?'REWARD_UNAVAILABLE':'INVALID_REQUEST',message,status);}
function nonnegative(value,name,integer=false){
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||(integer&&!Number.isSafeInteger(value)))throw failure(`Invalid ${name}`);
  return value;
}

class AchievementService {
  constructor(options={}) {
    this.db=options.db||{query:db.query,getClient:()=>db.getPool().connect()};
    this.publishEvent=options.publishEvent||produceEvent;
    this.achievementCache=new Map();this.initialized=false;
  }
  async withTransaction(fn){
    const client=await this.db.getClient();
    try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async initialize(){
    if(this.initialized)return;
    const {rows}=await this.db.query('SELECT * FROM achievements');
    for(const achievement of rows)this.achievementCache.set(achievement.achievement_id,achievement);
    this.initialized=true;
  }
  async processEvent(userId,eventType,eventData){
    await this.initialize();
    const {rows:[event]}=await this.db.query('INSERT INTO achievement_events(user_id,event_type,event_data,processed) VALUES($1,$2,$3,FALSE) RETURNING id',[userId,eventType,JSON.stringify(eventData)]);
    const relevant=await this.getRelevantAchievements(userId,eventType);const results=[];
    for(const achievement of relevant){const result=await this.updateProgress(userId,achievement,eventData);if(result.completed&&!result.alreadyCompleted)results.push(result);}
    await this.db.query('UPDATE achievement_events SET processed=TRUE WHERE id=$1',[event.id]);
    if(results.length)await this.publishAchievementCompleted(userId,results);
    return results;
  }
  async getRelevantAchievements(userId,eventType){
    return (await this.db.query(`SELECT a.* FROM achievements a WHERE a.trigger_conditions->>'type'=$1
      AND NOT EXISTS(SELECT 1 FROM user_achievements ua WHERE ua.user_id=$2 AND ua.achievement_id=a.achievement_id AND ua.completed)`,[eventType,userId])).rows;
  }
  calculateTarget(conditions){
    const target=Number(conditions.target);if(!Number.isFinite(target)||target<=0)throw failure('Invalid achievement target');return target;
  }
  calculateProgress(conditions,eventData){
    switch(conditions.type){
      case 'battle_win':return eventData.win===false?0:nonnegative(eventData.count??1,'event count',true);
      case 'catch_count':case 'gym_conquer':case 'trade_count':case 'pokemon_breed':case 'egg_hatch':case 'pokestop_visit':case 'friend_count':
        return nonnegative(eventData.count??1,'event count',true);
      case 'catch_species':return eventData.is_new_species===true?1:0;
      case 'distance_traveled':return nonnegative(eventData.distance??0,'distance');
      case 'shiny_catch':return eventData.is_shiny===true?1:0;
      case 'night_catch':return eventData.is_night===true?1:0;
      case 'lucky_catch':return eventData.is_lucky===true?1:0;
      case 'perfect_iv_breed':return eventData.is_perfect_iv===true?1:0;
      default:throw failure('Unsupported achievement event type');
    }
  }
  matchesFilters(data,filters){return Object.entries(filters).every(([key,value])=>data[key]===value);}
  async updateProgress(userId,achievement,eventData){
    const {achievement_id,trigger_conditions}=achievement;
    if(trigger_conditions.filters&&!this.matchesFilters(eventData,trigger_conditions.filters))return {achievement_id,completed:false,filtered:true};
    const increment=this.calculateProgress(trigger_conditions,eventData);const target=this.calculateTarget(trigger_conditions);
    const started=process.hrtime.bigint();
    return this.withTransaction(async client=>{
      // Serialize this owner's independent completions as well as the snapshot.
      const owner=await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);if(!owner.rowCount)throw failure('User not found',404);
      await client.query('INSERT INTO user_achievements(user_id,achievement_id,target,progress) VALUES($1,$2,$3,0) ON CONFLICT(user_id,achievement_id) DO NOTHING',[userId,achievement_id,target]);
      const {rows:[record]}=await client.query('SELECT * FROM user_achievements WHERE user_id=$1 AND achievement_id=$2 FOR UPDATE',[userId,achievement_id]);
      if(!record.modern_achievement_id)throw failure('Tiered achievements use their original progress counter');
      if(record.completed)return {achievement_id,completed:false,alreadyCompleted:true};
      const {rows:[updated]}=await client.query(`UPDATE user_achievements SET progress=LEAST(progress+$1::numeric,target),updated_at=NOW()
        WHERE user_id=$2 AND achievement_id=$3 RETURNING progress,target,completed`,[increment,userId,achievement_id]);
      const progress=Number(updated.progress);const completed=updated.completed;
      await this.updateSnapshot(userId,client);
      return {achievement_id,name:achievement.name,progress,target:Number(record.target),points:achievement.points,rewards:achievement.rewards,rarity:achievement.rarity,completed};
    }).then(result=>{if(result.completed)achievementMetrics.unlocked.inc({category:achievement.category||'unknown'});return result;})
      .finally(()=>achievementMetrics.progress.observe(Number(process.hrtime.bigint()-started)/1e9));
  }
  async updateSnapshot(userId,client){
    if(!client)return this.withTransaction(async connection=>{await connection.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);return this.updateSnapshot(userId,connection);});
    await client.query(`WITH categories AS(
      SELECT a.category,COALESCE(sum(a.points) FILTER(WHERE ua.completed),0) AS points,count(*) FILTER(WHERE ua.completed)::int AS completed
      FROM user_achievements ua JOIN achievements a ON a.achievement_id=ua.modern_achievement_id WHERE ua.user_id=$1 GROUP BY a.category
    ) INSERT INTO achievement_progress_snapshots(user_id,category_progress,total_points,achievements_completed)
      SELECT $1,COALESCE(jsonb_object_agg(category,completed),'{}'::jsonb),COALESCE(sum(points),0),COALESCE(sum(completed),0) FROM categories
      ON CONFLICT(user_id) DO UPDATE SET category_progress=EXCLUDED.category_progress,total_points=EXCLUDED.total_points,
        achievements_completed=EXCLUDED.achievements_completed,last_updated=NOW()`,[userId]);
  }
  async publishAchievementCompleted(userId,achievements){
    // Delivery failures remain visible; durable/replay-safe event delivery still
    // requires the separate event pipeline acceptance.
    await this.publishEvent('achievement.completed',{userId,achievements,timestamp:new Date().toISOString()});
  }
  async grantTitle(client,userId,titleId,achievementId){
    const {rows:[definition]}=await client.query('SELECT * FROM title_definitions WHERE title_id=$1',[titleId]);
    if(!definition||!definition.is_active||definition.unlock_type!=='achievement'||definition.unlock_criteria?.achievement_id!==achievementId)throw failure('Reward title unavailable',503);
    if(definition.is_limited)throw failure('Limited reward titles require an expiry policy',503);
    await client.query(`INSERT INTO user_titles(user_id,title_id,source_type,source_id) VALUES($1,$2,'achievement',$3) ON CONFLICT(user_id,title_id) DO NOTHING`,[userId,titleId,achievementId]);
  }
  async grantRewards(client,userId,achievementId,rewards){
    if(!rewards||typeof rewards!=='object'||Array.isArray(rewards)||Object.keys(rewards).some(key=>!['coins','items','title'].includes(key)))throw failure('Unsupported achievement reward configuration',503);
    const coins=nonnegative(rewards.coins??0,'reward coins',true);
    const items=rewards.items??[];if(!Array.isArray(items))throw failure('Invalid reward items',503);
    await client.query('UPDATE users SET coins=coins+$1,updated_at=NOW() WHERE id=$2',[coins,userId]);
    for(const item of items){
      if(!item||typeof item.item_id!=='string')throw failure('Invalid reward item',503);
      const quantity=nonnegative(item.count,'reward quantity',true);if(quantity===0)throw failure('Invalid reward quantity',503);
      const key=item.item_id.toLowerCase();const column=Object.hasOwn(ballColumns,key)?ballColumns[key]:undefined;
      if(column){
        // Catch gameplay consumes these canonical V1 counters. Do not also issue
        // a second inventory balance for the same ball reward.
        await client.query(`UPDATE users SET ${column}=${column}+$1 WHERE id=$2`,[quantity,userId]);continue;
      }
      const itemId=item.item_id.toUpperCase();
      const {rows:[catalog]}=await client.query('SELECT item_id,category,max_stack FROM items WHERE item_id=$1',[itemId]);
      if(!catalog||!Number.isSafeInteger(catalog.max_stack)||catalog.max_stack<1)throw failure('Reward item unavailable',503);
      const {rows:[capacity]}=await client.query('SELECT * FROM check_inventory_capacity($1::uuid,$2,$3)',[userId,catalog.category,quantity]);
      if(!capacity.can_add)throw failure('Inventory capacity exceeded');
      await client.query(`INSERT INTO player_inventory(user_id,item_id,quantity,metadata)
        SELECT $1,$2,LEAST($3-(stack-1)*$4,$4),jsonb_build_object('source','achievement','achievement_id',$5::text)
        FROM generate_series(1,ceil($3::numeric/$4)::int) stack`,[userId,itemId,quantity,catalog.max_stack,achievementId]);
    }
    if(rewards.title!==undefined){if(typeof rewards.title!=='string')throw failure('Invalid reward title',503);await this.grantTitle(client,userId,rewards.title,achievementId);}
  }
  async claimRewards(userId,achievementId){
    return this.withTransaction(async client=>{
      const owner=await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);if(!owner.rowCount)throw failure('User not found',404);
      const {rows:[record]}=await client.query(`SELECT ua.*,a.rewards FROM user_achievements ua JOIN achievements a ON a.achievement_id=ua.modern_achievement_id
        WHERE ua.user_id=$1 AND ua.achievement_id=$2 FOR UPDATE OF ua`,[userId,achievementId]);
      if(!record)throw failure('Achievement not found',404);
      if(!record.completed)throw failure('Achievement not completed');if(record.rewards_claimed)throw failure('Rewards already claimed');
      await this.grantRewards(client,userId,achievementId,record.rewards);
      await client.query('UPDATE user_achievements SET rewards_claimed=TRUE,rewards_claimed_at=NOW() WHERE user_id=$1 AND achievement_id=$2',[userId,achievementId]);
      return record.rewards;
    }).then(rewards=>{achievementMetrics.claimed.inc();return rewards;});
  }
  async unlockTitle(userId,titleId,achievementId){return this.withTransaction(client=>this.grantTitle(client,userId,titleId,achievementId));}
  async getUserAchievements(userId,options={}){
    const {category,includeHidden=false,includeCompleted=true}=options;const values=[userId];
    const clauses=[];if(category){values.push(category);clauses.push(`a.category=$${values.length}`);}
    if(!includeHidden)clauses.push('(NOT a.is_hidden OR ua.completed)');if(!includeCompleted)clauses.push('NOT COALESCE(ua.completed,FALSE)');
    const {rows}=await this.db.query(`SELECT a.*,COALESCE(ua.progress,0) AS progress,COALESCE(ua.target,(a.trigger_conditions->>'target')::numeric) AS target,
      COALESCE(ua.completed,FALSE) AS completed,ua.completed_at,COALESCE(ua.rewards_claimed,FALSE) AS rewards_claimed
      FROM achievements a LEFT JOIN user_achievements ua ON ua.modern_achievement_id=a.achievement_id AND ua.user_id=$1
      ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY a.points DESC,a.achievement_id`,values);
    return rows.map(row=>({...row,progress:Number(row.progress),target:Number(row.target)}));
  }
  async getProgressOverview(userId){
    const {rows:[row]}=await this.db.query('SELECT total_points,achievements_completed,category_progress FROM achievement_progress_snapshots WHERE user_id=$1',[userId]);
    return row||{total_points:0,achievements_completed:0,category_progress:{}};
  }
  async getLeaderboard(limit=100,offset=0){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw failure('Invalid leaderboard pagination');
    return (await this.db.query(`SELECT aps.user_id,aps.total_points,aps.achievements_completed,u.nickname,u.nickname AS username,u.avatar_url
      FROM achievement_progress_snapshots aps JOIN users u ON u.id=aps.user_id
      ORDER BY aps.total_points DESC,aps.achievements_completed DESC,aps.user_id LIMIT $1 OFFSET $2`,[limit,offset])).rows;
  }
  async setActiveTitle(userId,titleId){
    return this.withTransaction(async client=>{
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
      if(titleId!==null){
        const owned=await client.query(`SELECT ut.title_id FROM user_titles ut JOIN title_definitions td USING(title_id) WHERE ut.user_id=$1 AND ut.title_id=$2 AND td.is_active AND (ut.expires_at IS NULL OR ut.expires_at>NOW()) FOR UPDATE OF ut`,[userId,titleId]);
        if(!owned.rowCount)throw failure('Title not found',404);
      }
      await client.query('UPDATE user_titles SET is_active=FALSE WHERE user_id=$1',[userId]);
      if(titleId!==null)await client.query('UPDATE user_titles SET is_active=TRUE WHERE user_id=$1 AND title_id=$2',[userId,titleId]);
    });
  }
  async getUserTitles(userId){return (await this.db.query(`SELECT ut.*,td.name AS title_name FROM user_titles ut JOIN title_definitions td USING(title_id)
    WHERE ut.user_id=$1 AND td.is_active AND (ut.expires_at IS NULL OR ut.expires_at>NOW()) ORDER BY ut.unlocked_at DESC,ut.title_id`,[userId])).rows;}
}
const achievementService=new AchievementService();
module.exports={achievementService,AchievementServiceClass:AchievementService,ACHIEVEMENT_CATEGORIES,ACHIEVEMENT_RARITIES,achievementMetrics};
