'use strict';
jest.mock('../../services/user-service/src/routes/notifications',()=>({createNotification:jest.fn(),NOTIFICATION_TYPES:{}}));
const {initNotificationHandlers}=require('../../services/user-service/src/handlers/notificationHandler');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
test('initialization waits for every subscription before reporting completion',async()=>{
  const waiting=deferred(),bus={subscribe:jest.fn().mockReturnValue(waiting.promise)};
  let completed=false;const initializing=initNotificationHandlers(bus).then(()=>{completed=true;});
  await Promise.resolve();expect(completed).toBe(false);expect(bus.subscribe).toHaveBeenCalledTimes(7);
  waiting.resolve();await initializing;expect(completed).toBe(true);
});
test('failed subscriptions are propagated after siblings finish',async()=>{
  const waiting=deferred(),bus={subscribe:jest.fn().mockRejectedValueOnce(new Error('subscription failed')).mockReturnValue(waiting.promise)};
  let completed=false;const initializing=initNotificationHandlers(bus).finally(()=>{completed=true;});
  const assertion=expect(initializing).rejects.toThrow('subscription failed');
  await Promise.resolve();expect(completed).toBe(false);waiting.resolve();await assertion;
});
