const vm = require('node:vm')
class Element {
  constructor(tag='div') { this.tagName=tag.toUpperCase(); this.value=''; this.textContent=''; this.hidden=false; this.checked=false; this.dataset={}; this.style={}; this.attributes={}; this.listeners={}; this.children=[]; this.rows=[]; this.html=''; this.writes=0; this.open=false; this.scrollTop=0; this.scrollHeight=0; this.classList={add(){},remove(){},toggle(){}} }
  get innerHTML() { return this.html }
  set innerHTML(value) { this.html=value; this.writes++ }
  addEventListener(name,fn) { this.listeners[name]=fn }
  setAttribute(name,value) { this.attributes[name]=String(value) }
  getAttribute(name) { return this.attributes[name] }
  appendChild(child) { this.children.push(child); return child }
  querySelectorAll() { return this.rows }
  querySelector() { return this.button||null }
  closest() { return this.parent||null }
  focus() { this.focused=true }
  blur() {}
  showModal() { this.open=true }
  close() { this.open=false }
}
function boot(scripts,fixtures={},blockedStorage=false) {
  const elements=new Map(),calls=[],timers=[],preferences=new Map()
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)}
  const doc={documentElement:new Element(),body:new Element(),activeElement:null,getElementById:get,createElement:tag=>new Element(tag),querySelectorAll:()=>get('units').rows,querySelector:()=>null,addEventListener(){}}
  const context={document:doc,console,Date,URL,Promise,Array,Set,String,Number,JSON,Math,parseInt,matchMedia:()=>({matches:false,addEventListener(){}}),getSelection:()=>({toString:()=>''}),setTimeout:(fn,delay)=>{timers.push(delay);return timers.length},setInterval:(fn,delay)=>{timers.push(delay);return timers.length},clearTimeout(){},localStorage:{getItem:key=>{if(blockedStorage)throw new Error('Storage blocked');return preferences.get(key)||null},setItem:(key,value)=>{if(blockedStorage)throw new Error('Storage blocked');preferences.set(key,value)}},fetch:async(url,options={})=>{calls.push({url,method:options.method||'GET'});const value=fixtures[url];if(value instanceof Error)throw value;return {ok:value?.httpError!==true,json:async()=>value??{}}}}
  context.window=context
  vm.createContext(context)
  for(const script of scripts)vm.runInContext(script,context)
  return {context,elements,get,calls,timers,preferences,fixtures}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
module.exports={boot,settle,Element}
