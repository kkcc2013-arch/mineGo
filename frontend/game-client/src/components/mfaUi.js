export function element(tag,text='',className=''){
  const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;
}
export function button(label,action,disabled=false,className='btn btn-outline'){
  const node=element('button',label,className);node.type='button';node.disabled=disabled;node.addEventListener('click',action);return node;
}
export function factorField(recovery=false){
  const group=element('div','','form-group');const id='factor-'+crypto.randomUUID();
  const label=element('label',recovery?'验证码或恢复码':'验证器验证码','form-label');label.htmlFor=id;
  const input=element('input','','form-input');input.id=id;input.type='text';input.autocomplete='one-time-code';input.maxLength=recovery?9:6;input.inputMode=recovery?'text':'numeric';input.required=true;
  input.pattern=recovery?'(?:[0-9]{6}|[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4})':'[0-9]{6}';
  group.append(label,input);return {group,input};
}
export function message(error){const node=element('p',error||'','mfa-error');node.setAttribute('role','alert');return node;}
