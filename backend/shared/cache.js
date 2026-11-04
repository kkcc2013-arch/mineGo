'use strict';
// Shared cache facade. Query fills use readForFill/load tokens to prevent stale
// in-flight responses from repopulating keys after a committed invalidation.
const {CoherentCache}=require('./cache/CoherentCache');
const instance=new CoherentCache();
const exported={CoherentCache,instance};
for(const method of ['init','get','set','del','delPattern','exists','ttl','getStats','resetStats','flush','close','readForFill','load','track','invalidateLocal','invalidatePatternStrict','invalidatePatternsStrict','setConsistencyReady'])exported[method]=instance[method].bind(instance);
exported.CacheKeys={stamina:id=>`stamina:${id}`,pokemon:id=>`pokemon:${id}`,user:id=>`user:${id}`,battle:id=>`battle:${id}`,session:id=>`session:${id}`};
module.exports=exported;
