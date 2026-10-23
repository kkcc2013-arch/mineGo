'use strict';
const {Client}=require('pg');const crypto=require('node:crypto');const {EventEmitter}=require('node:events');
const {createLogger}=require('../logger');const logger=createLogger('pg-cdc-listener');
class PgCDCListener extends EventEmitter {
  constructor(config={}){super();this.config=config;this.client=null;this.isListening=false;this.wanted=false;this.timer=null;this.connecting=null;this.attempt=0;this.stats={eventsReceived:0,eventsProcessed:0,parseErrors:0,reconnects:0};}
  async start(){
    if(this.wanted)return this.connecting;
    this.wanted=true;
    try{await this.open();}catch(error){this.wanted=false;clearTimeout(this.timer);await this.client?.end().catch(()=>{});this.client=null;throw error;}
  }
  async open(){
    const options=this.config.pool?.options||{};
    const client=new Client({...options,...this.config.pg,connectionTimeoutMillis:this.config.connectionTimeoutMillis??1500,keepAlive:true,keepAliveInitialDelayMillis:1000});
    this.client=client;
    client.on('error',error=>this.lost(client,error));client.on('end',()=>this.lost(client));
    client.on('notification',message=>this.handleNotification(message));
    this.connecting=(async()=>{
      await client.connect();if(!this.wanted){await client.end();return;}
      const result=await client.query("SELECT current_schema() AS schema,to_regclass(format('%I.cache_invalidation_outbox',current_schema())) AS journal");
      if(!result.rows[0].journal)throw Object.assign(new Error('Canonical cache journal is missing'),{code:'CDC_SCHEMA_MISSING'});
      this.schema=result.rows[0].schema;this.channel='minego_cache_'+crypto.createHash('md5').update(this.schema).digest('hex');
      this.rulesChannel=this.channel+'_rules';this.processId=client.processID;
      await client.query(`LISTEN ${this.channel}`);await client.query(`LISTEN ${this.rulesChannel}`);
      if(!this.wanted){await client.end();return;}
      this.isListening=true;this.attempt=0;this.emit('connected');
    })();
    try{await this.connecting;}catch(error){if(this.client===client)this.client=null;await client.end().catch(()=>{});throw error;}finally{this.connecting=null;}
  }
  lost(client,error){
    if(client!==this.client||!this.isListening||!this.wanted)return;
    this.isListening=false;this.client=null;this.emit('disconnect',{code:error?.code||'CDC_DISCONNECTED'});client.end().catch(()=>{});this.reconnect();
  }
  reconnect(){
    if(!this.wanted||this.timer)return;
    const delay=Math.min((this.config.reconnectDelay??50)*2**Math.min(this.attempt++,5),1000);
    this.timer=setTimeout(async()=>{this.timer=null;if(!this.wanted)return;this.stats.reconnects++;try{await this.open();}catch(error){logger.warn({code:error.code||'CDC_CONNECT_FAILED'},'CDC reconnect failed');this.reconnect();}},delay);
  }
  handleNotification(message){
    if(!this.wanted||![this.channel,this.rulesChannel].includes(message.channel))return;
    this.stats.eventsReceived++;
    if(message.channel===this.rulesChannel){if(!/^[0-9]{1,20}$/.test(message.payload)){this.stats.parseErrors++;return;}this.emit('rules',message.payload);return;}
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(message.payload)){this.stats.parseErrors++;return;}
    this.stats.eventsProcessed++;this.emit('change',{eventId:message.payload});
  }
  getStats(){return {...this.stats,isListening:this.isListening,processId:this.processId??null};}
  async stop(){this.wanted=false;clearTimeout(this.timer);this.timer=null;this.isListening=false;const client=this.client;this.client=null;if(client)await client.end().catch(()=>{});if(this.connecting)await this.connecting.catch(()=>{});}
}
module.exports=PgCDCListener;
