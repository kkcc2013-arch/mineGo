'use strict';
jest.mock('../../shared/auditLogEncrypted',()=>({useAuditStore:jest.fn(async(options,work)=>work({initialize:async()=>{}}))}));
jest.mock('../../shared/mfa/MFAStore',()=>({MFAStore:jest.fn()}));
const {MFAStore}=require('../../shared/mfa/MFAStore');
const api=require('../../shared/mfaService');
let instance;
beforeEach(async()=>{
 await api.closeMFA();jest.clearAllMocks();instance={setup:jest.fn().mockResolvedValue({pending:true}),transaction:jest.fn().mockImplementation(async work=>work({})),keyProvider:jest.fn(),close:jest.fn().mockResolvedValue()};MFAStore.mockImplementation(()=>instance);
});
afterEach(()=>api.closeMFA());
test('import and an unused close do not create a provider, pool or runtime',async()=>{expect(MFAStore).not.toHaveBeenCalled();await api.closeMFA();expect(MFAStore).not.toHaveBeenCalled();});
test('the lazy facade preserves arguments and uses one owned runtime',async()=>{expect(await api.setup('owner',{req:{id:'request'}})).toEqual({pending:true});await api.setup('second');expect(MFAStore).toHaveBeenCalledTimes(1);expect(instance.setup).toHaveBeenCalledWith('owner',{req:{id:'request'}});});
test('readiness awaits actual storage then validates provider configuration',async()=>{await api.ready();expect(instance.transaction).toHaveBeenCalledTimes(1);expect(instance.keyProvider).toHaveBeenCalledTimes(1);});
test('close is awaited and releases only the owned runtime before a later fresh start',async()=>{await api.setup('owner');await api.closeMFA();expect(instance.close).toHaveBeenCalledTimes(1);await api.setup('second');expect(MFAStore).toHaveBeenCalledTimes(2);});
test('provider and persistence refusal are propagated; no success or default key API is manufactured',async()=>{instance.setup.mockRejectedValue(new Error('MFA_UNAVAILABLE'));await expect(api.setup('owner')).rejects.toThrow('MFA_UNAVAILABLE');expect(api.getEncryptionKey).toBeUndefined();expect(api.encryptSecret).toBeUndefined();});
