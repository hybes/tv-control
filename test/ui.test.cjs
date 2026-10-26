const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const {boot,settle}=require('./ui-harness.cjs')
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8')
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(Boolean)
const status={chrome:true,tv:true,tvType:'panasonic',scheduleActive:true,display:{connector:'DP-1',status:'connected',dpms:'On',link:true,kioskVt:true},autoLogin:{enabled:false}}
function fixtures(){return {'/api/config':{scheduleDays:[0,1,2,3],dateOverrides:{},tvType:'panasonic'},'/api/status':status,'/api/tv/keys':{keys:['up','down','left','right']},'/api/network/hosts':{ok:true,devices:[],online:0}}}
test('blocked local storage does not prevent status loading or make control requests',async()=>{
 const h=boot(scripts,fixtures(),true);await settle()
 assert.equal(h.get('connectionState').textContent,'Connected')
 assert.equal(h.get('chromeLabel').textContent,'Running')
 assert.ok(h.calls.length>=4)
 assert.ok(h.calls.every(x=>x.method==='GET'))
 h.get('themeToggle').listeners.change({target:{checked:true}})
 assert.equal(h.context.document.documentElement.dataset.theme,'dark')
 assert.ok(h.timers.includes(10000));assert.equal(h.timers.filter(x=>x===30000).length,2)
})
test('failed refresh keeps prior readings and successful recovery clears the notice',async()=>{
 const h=boot(scripts,fixtures());await settle()
 const previous=h.get('lastChecked').textContent
 h.fixtures['/api/status']={httpError:true}
 await h.context.refreshStatus()
 assert.equal(h.get('connectionState').textContent,'Disconnected')
 assert.equal(h.get('connectionError').hidden,false)
 assert.equal(h.get('chromeLabel').textContent,'Running')
 assert.equal(h.get('lastChecked').textContent,previous)
 h.fixtures['/api/status']=status
 await h.context.refreshStatus()
 assert.equal(h.get('connectionState').textContent,'Connected')
 assert.equal(h.get('connectionError').hidden,true)
})
test('calendar days expose keyboard controls without changing schedule on render',async()=>{
 const h=boot(scripts,fixtures());await settle()
 const days=h.get('calGrid').children.filter(x=>x.tagName==='BUTTON')
 assert.ok(days.length>=28)
 assert.ok(days.every(x=>x.attributes['aria-label']&&['true','false'].includes(x.attributes['aria-pressed'])))
 assert.ok(h.calls.every(x=>x.method==='GET'))
})

test('network refresh failures retain prior device rows',async()=>{
 const data=fixtures();data['/api/network/hosts']={ok:true,devices:[{Name:'Example display',IP:'192.0.2.10',Now:1}],online:1}
 const h=boot(scripts,data);await settle()
 const prior=h.get('networkBody').innerHTML
 h.fixtures['/api/network/hosts']={httpError:true}
 await h.context.refreshNetworkHosts()
 assert.equal(h.get('networkBody').innerHTML,prior)
 assert.match(h.get('networkError').textContent,/Previous readings/)
})

test('unchanged polls do not rewrite the live connection announcement',async()=>{
 const h=boot(scripts,fixtures());await settle()
 const el=h.get('connectionState');let value=el.textContent,writes=0
 Object.defineProperty(el,'textContent',{get:()=>value,set:next=>{value=next;writes++}})
 await h.context.refreshStatus()
 assert.equal(writes,0)
})


test('initial failure does not claim there are previous readings',async()=>{
 const data=fixtures();data['/api/status']={httpError:true};data['/api/network/hosts']={httpError:true}
 const h=boot(scripts,data);await settle()
 assert.equal(h.get('connectionState').textContent,'Disconnected')
 assert.match(h.get('connectionError').textContent,/could not be loaded/)
 assert.match(h.get('networkError').textContent,/Could not load/)
})


test('unavailable remote key metadata preserves controls without a script error',async()=>{
 const h=boot(scripts,fixtures());await settle()
 const key={hidden:false,dataset:{key:'up'}}
 h.context.document.querySelectorAll=()=>[key]
 h.fixtures['/api/tv/keys']={httpError:true}
 await assert.doesNotReject(h.context.loadRemoteKeys())
 assert.equal(key.hidden,false)
 h.fixtures['/api/tv/keys']={}
 await assert.doesNotReject(h.context.loadRemoteKeys())
 assert.equal(key.hidden,false)
})
