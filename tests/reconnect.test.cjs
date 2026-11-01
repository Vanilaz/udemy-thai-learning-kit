const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createReconnect}=require('../extension/core/reconnect.js');
test('popup health is refreshed after initial offline state and again after recovery',async()=>{
 let time=0,online=false,status='offline',calls=0;
 const poll=createReconnect(async()=>{calls++;status=online?'ready':'offline';},{now:()=>time});
 await poll();assert.equal(status,'offline');
 online=true;time=2000;await poll();assert.equal(calls,1);
 time=10000;await poll();assert.equal(status,'ready');assert.equal(calls,2);
 online=false;time=20000;await poll();assert.equal(status,'offline');
});
test('slow health requests never overlap and failures can be retried',async()=>{
 let resolve,calls=0,time=0;
 const poll=createReconnect(()=>{calls++;return new Promise(r=>resolve=r);},{now:()=>time});
 const first=poll();await Promise.resolve();time=20000;
 const second=poll();assert.equal(calls,1);resolve();await Promise.all([first,second]);
 const third=poll();await Promise.resolve();assert.equal(calls,2);resolve();await third;
});
