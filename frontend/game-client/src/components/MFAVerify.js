import {element,button,factorField,message} from './mfaUi.js';

export class MFAVerify {
  constructor(container,api,{onSuccess,onCancel}={}){
    this.container=container;this.api=api;this.onSuccess=onSuccess;this.onCancel=onCancel;
    this.active=true;this.busy=false;this.error='';this.recovery=false;this.verified=false;
    this.timer=setTimeout(()=>{if(this.active&&!this.verified){this.api.cancelMfaLogin();this.destroy();onCancel?.('验证请求已过期，请重新登录');}},300000);
    this.render();
  }
  render(){
    if(!this.active)return;
    const root=element('section','','mfa-panel');root.setAttribute('aria-label','登录二次验证');
    root.append(element('h2','完成登录验证'),element('p',this.verified?'验证已完成，请加载账户信息。':'请输入验证器验证码或一次性恢复码。验证请求五分钟后过期。'));
    const form=element('form');let input;
    if(!this.verified){
      const choice=element('select','','form-input');choice.setAttribute('aria-label','验证方式');
      for(const [value,label]of [['totp','验证器验证码'],['recovery','恢复码']]){const option=element('option',label);option.value=value;choice.append(option);}
      choice.value=this.recovery?'recovery':'totp';choice.disabled=this.busy;choice.addEventListener('change',()=>{this.recovery=choice.value==='recovery';this.render();});form.append(choice);
      const field=factorField(this.recovery);input=field.input;if(this.recovery){field.group.querySelector('label').textContent='恢复码';input.pattern='[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}';input.placeholder='XXXX-XXXX';}input.disabled=this.busy;form.append(field.group);
    }
    const submit=element('button',this.busy?'正在验证…':this.verified?'重试加载账户':'验证并登录','btn btn-primary');submit.type='submit';submit.disabled=this.busy;form.append(submit);
    form.addEventListener('submit',event=>{event.preventDefault();this.submit(input?.value.trim());});root.append(form);
    root.append(button('返回登录',()=>this.cancel(),this.busy&&this.verified));if(this.error)root.append(message(this.error));
    this.container.replaceChildren(root);if(!this.busy)input?.focus();
  }
  async submit(code){
    if(this.busy||!this.active)return;
    if(!this.verified&&!(this.recovery?/^(?:[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4})$/:/^\d{6}$/).test(code||'')){this.error='请输入正确格式的验证码';this.render();return;}
    this.busy=true;this.error='';this.abort=new AbortController();const timeout=setTimeout(()=>this.abort.abort(),10000);this.render();
    try{
      if(!this.verified){await this.api.completeMfaLogin(code,this.recovery,{signal:this.abort.signal});if(!this.active)return;this.verified=true;clearTimeout(this.timer);}
      await this.onSuccess?.();
    }catch(error){if(this.active)this.error=error.name==='AbortError'?'请求已取消，请重试':error.message||'验证失败，请重试';}
    finally{clearTimeout(timeout);if(this.active){this.busy=false;this.render();}}
  }
  async cancel(){
    if(!this.active)return;const verified=this.verified;this.destroy();
    if(verified)await this.api.logout();else this.api.cancelMfaLogin();this.onCancel?.();
  }
  destroy(){if(!this.active)return;this.active=false;clearTimeout(this.timer);this.abort?.abort();this.container.replaceChildren();}
}
