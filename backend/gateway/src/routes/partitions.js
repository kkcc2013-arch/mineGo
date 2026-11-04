'use strict';
// REQ-00060 / REQ-00626: only actual implemented operations are exposed.
const express=require('express');
const {requireAuth,requireAdmin}=require('../../../shared/auth');
const {partitionMaintenance,TABLES}=require('../../../shared/partitionMaintenance');
function createPartitionRouter({manager=partitionMaintenance}={}){
  const router=express.Router();
  router.use(requireAuth,requireAdmin);
  router.use(express.json({limit:'16kb'}));
  const run=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){if(error.status===400)return res.status(400).json({success:false,error:error.message});next(error);}};
  router.get('/config/list',(req,res)=>res.json({success:true,data:{tables:TABLES,partitionKey:'created_at',futureMonths:3}}));
  router.get('/overview',run(async(req,res)=>res.json({success:true,data:await manager.getOverview()})));
  router.get('/stats/summary',run(async(req,res)=>{
    const overview=await manager.getOverview();
    const summary={tables:TABLES.length,totalPartitions:0,totalSizeBytes:0n,totalRows:0n,byTable:{}};
    for(const [table,data] of Object.entries(overview)){
      summary.totalPartitions+=data.partitionCount;summary.totalSizeBytes+=BigInt(data.totalSizeBytes);summary.totalRows+=BigInt(data.totalRows);
      summary.byTable[table]={partitions:data.partitionCount,sizeBytes:data.totalSizeBytes,rows:data.totalRows};
    }
    res.json({success:true,data:{...summary,totalSizeBytes:summary.totalSizeBytes.toString(),totalRows:summary.totalRows.toString()}});
  }));
  router.get('/:tableName',run(async(req,res)=>res.json({success:true,data:{table:req.params.tableName,partitions:await manager.getPartitionStats(req.params.tableName),health:await manager.healthCheck(req.params.tableName)}})));
  router.post('/:tableName/create',run(async(req,res)=>{
    const created=await manager.ensureFuturePartitions(req.params.tableName,req.body?.months??req.body?.count??3);
    res.json({success:true,data:{createdPartitions:created,count:created.length}});
  }));
  return router;
}
module.exports=createPartitionRouter();
module.exports.createPartitionRouter=createPartitionRouter;
