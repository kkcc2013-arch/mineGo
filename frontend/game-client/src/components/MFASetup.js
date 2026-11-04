import {element,button,factorField,message} from './mfaUi.js';

export class MFASetup {
  constructor(container,api=window.pmgApi){
    this.container=container;this.api=api;this.active=true;this.busy=false;this.error='';this.status=null;this.step='status';this.secret=null;this.qr=null;this.codes=[];this.urls=new Set();
    this.logout=()=>this.destroy();window.addEventListener('pmg:logout',this.logout);
    this.ready=this.load();
  }
  clearSecrets(){this.secret=this.qr=null;this.codes=[];for(const url of this.urls)URL.revokeObjectURL(url);this.urls.clear();}
  async run(work){
    if(!this.active||this.busy)return;this.busy=true;this.error='';this.abort=new AbortController();const timer=setTimeout(()=>this.abort.abort(),10000);this.render();
    try{await work({signal:this.abort.signal});}catch(error){if(this.active)this.error=error.name==='AbortError'?'请求已取消，请重试':error.message||'暂时无法更新验证设置';}
    finally{clearTimeout(timer);if(this.active){this.busy=false;this.render();}}
  }
  async load(){return this.run(async opts=>{const status=await this.api.getMfaStatus(opts);if(this.active)this.status=status;});}
  async setup(){
    this.clearSecrets();return this.run(async opts=>{
      const data=await this.api.setupMfa(opts);if(!this.active)return;
      if(!/^[A-Z2-7]{32}$/.test(data.secret)||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qrCodeDataUrl)||!this.validCodes(data.recoveryCodes))throw new Error('验证设置响应无效，请重试');
      this.secret=data.secret;this.qr=data.qrCodeDataUrl;this.codes=[...data.recoveryCodes];this.step='setup';
    });
  }
  validCodes(codes){return Array.isArray(codes)&&codes.length===8&&new Set(codes).size===8&&codes.every(code=>/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(code));}
  async enable(code){
    if(!/^\d{6}$/.test(code||'')){this.error='请输入六位验证器验证码';this.render();return;}
    return this.run(async opts=>{await this.api.enableMfa(code,opts);if(!this.active)return;this.secret=this.qr=null;this.status={enabled:true,recoveryCodes:{remaining:8,total:8}};this.step='codes';});
  }
  async change(code,regenerate){
    if(!/^(?:\d{6}|[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4})$/.test(code||'')){this.error='请输入验证码或 XXXX-XXXX 格式的恢复码';this.render();return;}
    return this.run(async opts=>{
      const result=await (regenerate?this.api.regenerateMfaCodes(code,opts):this.api.disableMfa(code,opts));if(!this.active)return;
      this.clearSecrets();
      if(regenerate){if(!this.validCodes(result.recoveryCodes))throw new Error('恢复码响应无效，请重新读取状态');this.codes=[...result.recoveryCodes];this.step='codes';this.status={enabled:true,recoveryCodes:{remaining:8,total:8}};}
      else{this.status={enabled:false};this.step='status';}
    });
  }
  download(){
    if(!this.codes.length)return;const url=URL.createObjectURL(new Blob(['mineGo 一次性恢复码\n请妥善保管，每个恢复码只能使用一次。\n\n'+this.codes.join('\n')],{type:'text/plain;charset=utf-8'}));this.urls.add(url);
    const link=element('a');link.href=url;link.download='minego-recovery-codes.txt';document.body.append(link);link.click();link.remove();
  }
  render(){
    if(!this.active)return;
    const root=element('section','','mfa-panel');root.setAttribute('aria-label','验证器设置');root.append(element('h2','账户二次验证'));
    if(!this.status&&this.step==='status')root.append(element('p',this.busy?'正在读取账户状态…':'暂时无法读取账户验证状态'),button('重试',()=>this.load(),this.busy));
    else if(this.step==='setup'){
      root.append(element('p','使用验证器扫描二维码，或手动添加密钥。请勿向他人发送密钥。'));
      const image=element('img');image.src=this.qr;image.alt='在验证器中添加此账户的二维码';image.width=image.height=240;root.append(image);
      const secret=element('code',this.secret,'mfa-secret');secret.setAttribute('aria-label','手动设置密钥');root.append(secret);
      root.append(element('p','输入验证器显示的六位验证码以确认设置。'));this.factorForm(root,false,'验证并启用',code=>this.enable(code));
    }else if(this.step==='codes'){
      root.append(element('p','验证已启用。恢复码只会显示本次，请保存到安全的地方。'));
      const list=element('ul','','mfa-recovery-codes');list.setAttribute('aria-label','一次性恢复码');for(const code of this.codes)list.append(element('li',code));root.append(list);
      root.append(button('下载恢复码',()=>this.download(),this.busy));
      const label=element('label','','mfa-saved');const saved=element('input');saved.type='checkbox';label.append(saved,document.createTextNode('我已安全保存恢复码'));root.append(label);
      const done=button('完成',()=>{this.clearSecrets();this.step='status';this.load();},true,'btn btn-primary');saved.addEventListener('change',()=>{done.disabled=!saved.checked;});root.append(done);
    }else if(this.step==='regenerate'||this.step==='disable'){
      const regenerate=this.step==='regenerate';root.append(element('p',regenerate?'重新生成后，旧恢复码将立即失效。':'关闭后，登录将不再需要二次验证。'));
      this.factorForm(root,true,regenerate?'验证并重新生成':'验证并关闭',code=>this.change(code,regenerate));root.append(button('返回',()=>{this.step='status';this.error='';this.render();},this.busy));
    }else{
      root.append(element('p',this.status.requiresMigration?'此账户的旧版验证器需要管理员协助恢复。':this.status.enabled?'已启用：登录时需要验证器验证码或恢复码。':this.status.pending?'设置尚未完成，重新开始会替换此前的密钥和恢复码。':'尚未启用：您可以为登录增加验证步骤。'));
      if(!this.status.requiresMigration){
        if(this.status.enabled){root.append(element('p','剩余恢复码：'+(this.status.recoveryCodes?.remaining??'未知')));for(const [step,label]of [['regenerate','重新生成恢复码'],['disable','关闭二次验证']])root.append(button(label,()=>{this.step=step;this.error='';this.render();},this.busy));}
        else root.append(button(this.status.pending?'重新开始设置':'设置验证器',()=>this.setup(),this.busy,'btn btn-primary'));
      }
    }
    if(this.error)root.append(message(this.error));this.container.replaceChildren(root);
  }
  factorForm(root,recovery,label,submit){
    const form=element('form'),field=factorField(recovery);field.input.disabled=this.busy;form.append(field.group);
    const action=element('button',this.busy?'正在验证…':label,'btn btn-primary');action.type='submit';action.disabled=this.busy;form.append(action);form.addEventListener('submit',event=>{event.preventDefault();submit(field.input.value.trim());});root.append(form);
  }
  destroy(){if(!this.active)return;this.active=false;this.abort?.abort();this.clearSecrets();window.removeEventListener('pmg:logout',this.logout);this.container.replaceChildren();}
}
export default MFASetup;
