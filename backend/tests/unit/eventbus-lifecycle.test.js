'use strict';
const {EventBus}=require('../../shared/EventBus');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
test('shutdown starts all Kafka disconnections concurrently and clears ownership',async()=>{
  const bus=new EventBus(),first=deferred();const order=[];
  bus.consumers.set('first',{disconnect:()=>{order.push('first');return first.promise;}});
  bus.consumers.set('second',{disconnect:async()=>{order.push('second');}});
  bus.producer={disconnect:async()=>{order.push('producer');}};bus.isConnected=true;
  const stopping=bus.disconnect();expect(order).toEqual(['first','second','producer']);
  first.resolve();await stopping;expect(bus.consumers.size).toBe(0);expect(bus.producer).toBeNull();expect(bus.isConnected).toBe(false);
});
test('shutdown attempts every resource and reports failures instead of hiding them',async()=>{
  const bus=new EventBus(),second={disconnect:jest.fn().mockResolvedValue()};
  bus.consumers.set('first',{disconnect:()=>{throw new Error('disconnect failure');}});bus.consumers.set('second',second);
  await expect(bus.disconnect()).rejects.toThrow('EventBus disconnection failed');expect(second.disconnect).toHaveBeenCalled();expect(bus.consumers.size).toBe(0);
});
test('failed subscription closes its unregistered consumer',async()=>{
  const bus=new EventBus(),consumer={connect:jest.fn().mockResolvedValue(),subscribe:jest.fn().mockRejectedValue(new Error('bad topic')),disconnect:jest.fn().mockResolvedValue()};
  bus.kafka={consumer:()=>consumer};await expect(bus.subscribe('topic',()=>{})).rejects.toThrow('bad topic');
  expect(consumer.disconnect).toHaveBeenCalledTimes(1);expect(bus.consumers.size).toBe(0);
});
test('health metadata failure closes the temporary admin connection',async()=>{
  const bus=new EventBus(),admin={connect:jest.fn().mockResolvedValue(),listTopics:jest.fn().mockRejectedValue(new Error('metadata unavailable')),disconnect:jest.fn().mockResolvedValue()};
  bus.kafka={admin:()=>admin};bus.isConnected=true;
  expect((await bus.healthCheck()).healthy).toBe(false);expect(admin.disconnect).toHaveBeenCalledTimes(1);
});
