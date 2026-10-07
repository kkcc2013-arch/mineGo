'use strict';
const {TitleServiceClass} = require('../../services/user-service/src/titleService');
function make(options={}) {
  const metrics={unlocked:{inc:jest.fn()},activated:{inc:jest.fn()},expired:{inc:jest.fn()},leaderboard:{inc:jest.fn()}};
  const db={query:jest.fn(),getClient:jest.fn()};
  const service=new TitleServiceClass({db,cache:null,metrics,...options});
  return {service,db,metrics};
}
const definition={title_id:'title',name:{en:'Title'},description:{en:'Description'},category:'achievement',rarity:'rare',unlock_criteria:{},stat_bonuses:{},special_effects:{}};

test('initialization parses legacy JSON and failed reload preserves the previous definitions',async()=>{
  const {service,db}=make();db.query.mockResolvedValue({rows:[{...definition,name:JSON.stringify(definition.name)}]});
  await service.initialize();expect(service.getTitleDefinition('title').name).toEqual({en:'Title'});
  db.query.mockRejectedValue(new Error('database unavailable'));await expect(service.reload()).rejects.toThrow('database unavailable');
  expect(service.getTitleDefinition('title').name).toEqual({en:'Title'});
});
test('invalid definition JSON fails without replacing a usable definition cache',async()=>{
  const {service,db}=make();service.titleDefinitions.set('old',definition);
  db.query.mockResolvedValue({rows:[{...definition,name:'{bad'}]});await expect(service.initialize()).rejects.toThrow();
  expect(service.titleDefinitions.has('old')).toBe(true);expect(service.initialized).toBe(false);
});
test('unknown titles, expired limited titles and malformed source records cannot be granted',async()=>{
  const {service,db}=make();await expect(service.unlockTitle('user','unknown','test')).rejects.toMatchObject({httpStatus:404});
  service.titleDefinitions.set('title',{...definition,is_limited:true,available_until:new Date(0)});
  await expect(service.unlockTitle('user','title','test')).rejects.toMatchObject({code:'TITLE_EXPIRED'});
  service.titleDefinitions.set('title',definition);
  for(const args of [[null,null],['x'.repeat(31),null],['test',{}],['test','x'.repeat(101)]])await expect(service.unlockTitle('user','title',...args)).rejects.toMatchObject({code:'TITLE_INVALID_SOURCE'});
  expect(db.query).not.toHaveBeenCalled();
});
test('grants only increment and publish for newly persisted ownership; failed publication is reported separately',async()=>{
  const eventBus={publish:jest.fn().mockRejectedValue(new Error('offline'))};const {service,db,metrics}=make({eventBus});
  service.titleDefinitions.set('title',definition);db.query.mockResolvedValueOnce({rowCount:1,rows:[{id:1}]}).mockResolvedValueOnce({rowCount:0,rows:[]});
  expect((await service.unlockTitle('user','title','achievement','ach')).alreadyUnlocked).toBe(false);
  expect((await service.unlockTitle('user','title','achievement','ach')).alreadyUnlocked).toBe(true);
  expect(metrics.unlocked.inc).toHaveBeenCalledTimes(1);expect(eventBus.publish).toHaveBeenCalledTimes(1);
});
test('limited duration is bounded by the availability window',()=>{
  const {service}=make();const deadline=new Date(Date.now()+86400000);
  expect(service.calculateExpiry({...definition,unlock_criteria:{duration_days:7},available_until:deadline})).toEqual(deadline);
  expect(service.calculateExpiry(definition)).toBeNull();
  const duration=service.calculateExpiry({...definition,unlock_criteria:{duration_days:2}});
  expect(duration.getTime()-Date.now()).toBeGreaterThan(86400000);
});
test('failed user lookup releases and rolls back its transaction',async()=>{
  const {service,db}=make();service.titleDefinitions.set('title',definition);
  const client={query:jest.fn().mockResolvedValue({rowCount:0}),release:jest.fn()};db.getClient.mockResolvedValue(client);
  await expect(service.setActiveTitle('absent','title')).rejects.toMatchObject({code:'TITLE_USER_NOT_FOUND'});
  expect(client.query).toHaveBeenCalledWith('ROLLBACK');expect(client.release).toHaveBeenCalledTimes(1);
});
test('query/filter validation rejects malformed limits, favorite values and ranks before querying',async()=>{
  const {service,db}=make();
  for(const limit of [0,-1,101,'1junk'])await expect(service.getTitleLeaderboard(limit)).rejects.toMatchObject({httpStatus:400});
  await expect(service.getShopTitles({page:0})).rejects.toMatchObject({httpStatus:400});
  await expect(service.getUserTitles('user',{includeExpired:'false'})).rejects.toMatchObject({httpStatus:400});
  await expect(service.getUserTitles('user',{category:['achievement']})).rejects.toMatchObject({httpStatus:400});
  await expect(service.setFavorite('user','title','false')).rejects.toMatchObject({httpStatus:400});
  expect(()=>service.unlockTitleByRank('user',NaN)).toThrow('Invalid rank');expect(db.query).not.toHaveBeenCalled();
});
test('definition filters use independent category and rarity values',()=>{
  const {service}=make();service.titleDefinitions.set('title',{...definition,display_order:1});service.titleDefinitions.set('other',{...definition,title_id:'other',category:'event',rarity:'mythic',display_order:1});
  expect(service.getAllTitleDefinitions()).toHaveLength(2);
  expect(service.getAllTitleDefinitions({category:'event',rarity:'mythic'})[0].title_id).toBe('other');
});
