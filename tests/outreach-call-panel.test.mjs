import test from 'node:test';
import assert from 'node:assert/strict';
import {openCallBrief} from '../assets/js/outreach-calls.js';
class Element {
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.value='';}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 setAttribute(key,value){this[key]=value;}
}
test('call session requires an outcome and advances only after a saved result',async()=>{
 const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
 globalThis.document={createElement:tag=>new Element(tag)};
 globalThis.fetch=async()=>({ok:true,json:async()=>({owner:'Paul',name:'Owner',company:'Agency',checkedAt:new Date().toISOString(),phone:'+13055550100',questions:[],events:[],crmUrl:'https://example.com'})});
 try{
  let writes=0,advances=0,succeeds=false;
  const card=new Element('article');
  await openCallBrief({id:'test'},card,{text:(tag,s)=>new Element(tag,s),action:async()=>{writes++;return succeeds;},next:async()=>{advances++;}});
  const nodes=card.children[0].children;
  const select=nodes.find(n=>n.tag==='select'),save=nodes.find(n=>n.textContent==='Save & next');
  await save.onclick();assert.equal(writes,0);assert.equal(advances,0);
  select.value='connected';await save.onclick();assert.equal(writes,1);assert.equal(advances,0);
  succeeds=true;await save.onclick();assert.equal(writes,2);assert.equal(advances,1);
 }finally{globalThis.document=oldDocument;globalThis.fetch=oldFetch;}
});
