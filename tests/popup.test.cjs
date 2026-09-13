const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extension/popup.js', 'utf8');
const flush = () => new Promise(setImmediate);

function harness() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value:'', checked:false, options:[], style:{}, disabled:false,
      listeners:{}, focused:false,
      add(option){this.options.push(option);},
      addEventListener(type,handler){this.listeners[type]=handler;},
      focus(){this.focused=true;},
      setAttribute(name,value){this[name]=value;},
      set innerHTML(value){this.options=[];},
    });
    return elements.get(id);
  }
  const requests = [], timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    document:{getElementById:element}, window:{close(){}},
    Option:function(label,value){this.label=label;this.value=value;},
    setTimeout(fn){timers.set(++timerId,fn);return timerId;},
    clearTimeout(id){timers.delete(id);}, setInterval(){},
    chrome:{
      runtime:{sendMessage(message){requests.push(message.type);return new Promise(()=>{});}},
      storage:{local:{get:async()=>({ttsEngine:'google',ttsVoice:'saved-voice',dubbingEnabled:true,dubbingVolume:0.6}),set:async()=>{}}},
      tabs:{query:async()=>[{id:1,url:'https://www.udemy.com/course/test/'}],sendMessage:async()=>{throw Error('No receiver');}},
    },
  });
  vm.runInContext(source,context);
  return {context,elements,requests,timers};
}

test('tabs isolate settings, support keyboard wraparound, and preserve saved controls',async()=>{
  const h=harness();
  await flush();
  h.elements.get('tab-audio').listeners.click();
  assert.equal(h.elements.get('page-audio').hidden,false);
  assert.equal(h.elements.get('page-learning').hidden,true);
  h.elements.get('tab-audio').listeners.keydown({key:'End',preventDefault(){}});
  assert.equal(h.elements.get('tab-usage').focused,true);
  h.elements.get('tab-usage').listeners.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(h.elements.get('page-learning').hidden,false);
  assert.equal(h.elements.get('ttsEngine').value,'google');
  assert.equal(h.elements.get('voice').value,'saved-voice');
  h.elements.get('dubbing').checked=false;
  vm.runInContext('syncAudioControls()',h.context);
  assert.equal(h.elements.get('audioNotice').hidden,false);
  assert.equal(h.elements.get('audioSettings').hidden,false);
});

test('quota warning handles exhausted and unavailable usage without claiming Google balance',async()=>{
  const h=harness();
  await flush();
  vm.runInContext('serverEngines=[{name:"google",used:950,limit:900}]; renderGoogleQuota()',h.context);
  assert.equal(h.elements.get('quotaRemaining').textContent,'0 ไบต์');
  assert.equal(h.elements.get('quotaBadge').textContent,'ถึงเพดานแล้ว');
  assert.equal(h.elements.get('quotaFill').style.width,'100%');
  vm.runInContext('serverEngines=[{name:"google"}]; renderGoogleQuota()',h.context);
  assert.equal(h.elements.get('quotaRemaining').textContent,'ยังอ่านยอดไม่ได้');
});

test('saved controls load without waiting for an unresponsive health request or content script', async()=>{
  const h=harness();
  assert.notEqual(h.elements.get('ttsEngine').value,'');
  await flush();
  assert.equal(h.elements.get('ttsEngine').value,'google');
  assert.equal(h.elements.get('voice').value,'saved-voice');
  assert.equal(h.elements.get('dubbingVolume').value,'0.6');
  assert.match(h.elements.get('hint').textContent,/แสดงค่าที่บันทึกไว้/);
});

test('slow queue requests cannot pile up on the polling interval',async()=>{
  const h=harness();
  await flush();
  vm.runInContext('refreshQueue(); refreshQueue(); refreshQueue()',h.context);
  assert.equal(h.requests.filter(x=>x==='queueStatus').length,1);
});

test('connection timeout settles visibly and late settings cannot undo user edits',async()=>{
  const h=harness();
  await flush();
  vm.runInContext('optionsTouched=true; ttsEngineEl.value="windows"; applySettings({ttsEngine:"edge"})',h.context);
  assert.equal(h.elements.get('ttsEngine').value,'windows');
  for(const timer of [...h.timers.values()]) timer();
  await flush();
  assert.match(h.elements.get('status').textContent,/ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้/);
});
