'use strict';

// REQ-00127 compatibility entry point. UUID owners are explicit in every
// canonical method; historical integer workflows require separate adoption.
const {ErasureRequestStore}=require('./erasure/ErasureRequestStore');
const DeletionStatus=Object.freeze({PENDING:'pending',VERIFYING:'verifying',APPROVED:'approved',PROCESSING:'processing',COMPLETED:'completed',REJECTED:'rejected',CANCELLED:'cancelled'});
const ApprovalStatus=Object.freeze({PENDING:'pending',AUTO_APPROVED:'auto_approved',MANUAL_APPROVED:'manual_approved',REJECTED:'rejected'});
class DataDeletionService extends ErasureRequestStore {
  constructor(database){super({database});}
  async getRequest(requestId,owner){return this.detail(owner,requestId);}
  async getUserRequests(owner,options){return this.list(owner,options);}
  async getCertificate(number,owner){return this.certificate(owner,number);}
  async executeDeletion(requestId,actor=null){if(!this.taskRunner)this.taskRunner=new(require('./erasure/ErasureTaskRunner').ErasureTaskRunner)({store:this});return this.taskRunner.executeRequest(requestId,actor);}
}
module.exports={DataDeletionService,DeletionStatus,ApprovalStatus};
