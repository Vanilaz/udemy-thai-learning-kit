// Run real controller functions with deterministic provider and timer boundaries.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extension/content.js', 'utf8');
function fn(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing function ${name}`);
  const text = source.slice(match.index);
  return text.slice(0, /^  }/m.exec(text).index + 3);
}
function context(values, names) {
  const c = vm.createContext(values);
  vm.runInContext('class Stale extends Error {}\n' + names.map(fn).join('\n'), c);
  return c;
}
const flush = () => new Promise(setImmediate);

test('YouTube uses the shared dubbing controller and docks inside its native controls', () => {
  const sites = fs.readFileSync('extension/sites.js', 'utf8');
  assert.match(source, /const site = UDTH\.isYouTube \? UDTH\.youtube : udemySite/);
  assert.match(sites, /document\.querySelector\("\.ytp-right-controls"\)/);
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json','utf8'));
  const script = manifest.content_scripts.find(entry => entry.js.includes('content.js'));
  assert.ok(script.matches.includes('https://www.youtube.com/watch*'));
  assert.ok(script.matches.includes('https://www.youtube.com/shorts/*'));
});

test('ordinary sentence boundaries keep video moving; sustained lag still holds', () => {
  let check;
  const video={currentTime:3.8,duration:60,playbackRate:1,paused:false,pause(){this.paused=true;}};
  const state={video,ttsEngine:'windows',dubRateCap:1.6,dubbingVolume:1,dub:{token:0}};
  const c=context({state,Date,Math,Number,THAI_CHARS_PER_SECOND:12,
    setInterval(fn){check=fn;return 1;},clearInterval(){},renderStatus(){},tickDubbing(){},
    SpeechSynthesisUtterance:function(){},window:{speechSynthesis:{getVoices:()=>[],speak(){}}}},
    ['speakSegment','fitRate','pauseForDub','resumeAfterDubWait']);
  vm.runInContext('speakSegment(0,{text:"Still speaking",end:4,budgetEnd:4})',c);
  check();
  assert.equal(video.paused,false);
  video.currentTime=5;
  check();
  assert.equal(video.paused,false,'Brief overrun must not pause at each boundary');
  video.currentTime=6.1;
  check();
  assert.equal(video.paused,true,'Sustained lag must remain bounded');
});

test('manual resume uses the same audio offset and recovers from rejected playback', async () => {
  let starts = 0, stops = 0;
  const audio = {currentTime:4, pause(){}, play(){starts++; return Promise.reject(Error('Blocked'));}};
  const state = {video:{paused:true}, audio, dub:{playing:true,token:3,cursor:1,deadline:Date.now()+1000}};
  const c = context({state, onTimeUpdate(){}, stopDubbing(){stops++;}}, ['onVideoPause','onVideoPlay']);
  vm.runInContext('onVideoPause(); state.video.paused=false; onVideoPlay()',c);
  await flush();
  assert.equal(starts,1);
  assert.equal(audio.currentTime,4);
  assert.equal(state.dub.cursor,1);
  assert.equal(stops,1);
});

test('new subtitle fragments cannot rewrite a sentence already being spoken', () => {
  const state = {dub:{cursor:1,segments:[{start:0,end:2,text:'First',budgetEnd:5}],playing:true}};
  let resets = 0;
  // buildDubSegments now asks whether the engine speaks from the original;
  // edge does not, so this is the Thai-only plan the test was written for.
  state.ttsEngine = 'edge';
  const c = context({state, MAX_SEGMENT_SECONDS:14, SEGMENT_GAP_SECONDS:1.2,
    engineByName: name => ({name, translates: false}),
    resetAudioCache(){resets++;},resyncDub(){resets++;}}, ['endsSentence','speaksFromSource','buildDubSegments','updateDubSegments']);
  vm.runInContext('updateDubSegments([{start:0,end:2,th:"First",en:"First"},{start:2,end:4,th:"Second",en:"second."}])',c);
  assert.equal(resets,0,'A partial sentence extension must not replay its prefix');
  assert.equal(state.dub.segments[0].text,'First');
  assert.equal(state.dub.segments[1].text,'Second');
});

test('volume and unchanged popup settings do not restart the current sentence', async () => {
  let resets = 0;
  const state = {status:'ready', dubbingEnabled:true, ttsEngine:'edge', ttsVoice:'Thai',
    audio:{volume:1}, dub:{cursor:1, segments:[{start:0,end:10,text:'One'}]}};
  const c = context({state, stopDubbing(){resets++;}, resetAudioCache(){resets++;}, resyncDub(){resets++;},
    syncDubbingVolume(){}, syncNativeCaptions(){}, prefetchAudio(){}, onTimeUpdate(){}, renderPanel(){},
    chrome:{storage:{local:{set:async()=>{}}}}}, ['commitOptions']);
  await vm.runInContext('commitOptions({dubbingVolume:0.4, ttsEngine:"edge", ttsVoice:"Thai", dubbingEnabled:true})',c);
  assert.equal(resets,0,'An ordinary settings update must not replay speech');
  assert.equal(state.audio.volume,0.4);
});

test('pause and play without a seek never rewind the speech cursor', () => {
  const state = {video:{currentTime:3,paused:true}, dub:{cursor:1,segments:[{start:0,end:10}]}};
  const c = context({state, stopDubbing(){}, onTimeUpdate(){}}, ['onVideoPause','onVideoPlay','resyncDub']);
  vm.runInContext('onVideoPause(); state.video.paused=false; onVideoPlay()',c);
  assert.equal(state.dub.cursor,1,'Interrupted sentence must not start again');
});

test('automatic resume preserves speech even when the queued pause arrives late', async () => {
  let stopped = 0, updates = 0;
  const video = {paused: true, ended: false, play() {this.paused = false; return Promise.resolve();}};
  const state = {video, status: 'ready', dub: {autoPaused: true, playing: true}};
  const c = context({state, stopDubbing() {stopped++;}, resyncDub() {stopped++;}, onTimeUpdate() {updates++;}}, ['resumeAfterDubWait', 'onVideoPause', 'onVideoPlay']);
  vm.runInContext('resumeAfterDubWait(); onVideoPause(); onVideoPlay()', c);
  assert.equal(stopped, 0);
  assert.equal(updates, 1);
  assert.equal(state.dub.playing, true);
  assert.equal(state.dub.autoResuming, false);
});

test('manual pause preserves the audio position and an unowned hold never resumes video', () => {
  let paused = 0;
  const state = {video: {paused: true, play() {throw Error('Unexpected resume');}}, audio:{currentTime:2, pause(){paused++;}}, dub: {autoPaused: false, playing:true}};
  const c = context({state}, ['onVideoPause', 'resumeAfterDubWait']);
  vm.runInContext('onVideoPause(); resumeAfterDubWait()', c);
  assert.equal(paused, 1);
  assert.equal(state.audio.currentTime, 2);
  assert.equal(state.dub.playing, true);
});

test('long final utterance holds before video end and resumes only on completion', () => {
  let check, utterance;
  const video = {currentTime: 8, duration: 10, playbackRate: 1, paused: false, ended: false,
    pause() {this.paused = true;}, play() {this.paused = false; return Promise.resolve();}};
  const state = {video, status: 'ready', ttsEngine: 'windows', dubRateCap: 1.6, dubbingVolume: 1,
    dub: {token: 0, autoPaused: false}};
  const c = context({state, Date, Math, Number, THAI_CHARS_PER_SECOND: 12,
    setInterval(fn) {check = fn; return 1;}, clearInterval() {}, renderStatus() {}, tickDubbing() {},
    SpeechSynthesisUtterance: function(text) {this.text = text;},
    window: {speechSynthesis: {getVoices: () => [], speak(value) {utterance = value;}}}},
    ['speakSegment', 'fitRate', 'pauseForDub', 'resumeAfterDubWait']);
  vm.runInContext('speakSegment(0, {text:"Long final Thai sentence", end:10, budgetEnd:13})', c);
  video.currentTime = 9.6;
  check();
  assert.equal(video.paused, true);
  assert.equal(video.ended, false);
  assert.equal(state.dub.playing, true);
  utterance.onend();
  assert.equal(video.paused, false);
  assert.equal(state.dub.playing, false);
});

test('ready partial subtitles cannot be paused again by the next progress update', async () => {
  const video = {paused: false, currentTime: 0, pause() {this.paused = true;}, play() {this.paused = false; return Promise.resolve();}, addEventListener() {}, removeEventListener() {}};
  const gate = {skipped: false};
  const state = {video, generation: 1, status: 'translating', dub: {cursor: 0, segments: []}};
  const c = context({state, gate, ensureGate: () => ({querySelector: () => ({style: {}})}), buildDubSegments: () => [], syncNativeCaptions() {}, resyncDub() {}, resetAudioCache() {}, prefetchAudio() {}, onTimeUpdate() {}, refreshStudy() {}, log() {}, renderStatus() {}, coveredUntil: () => 100, readyToRelease: () => true, READY_AHEAD_SECONDS: 90}, ['showGate', 'releaseGateHold', 'hideGate', 'updateDubSegments', 'applyPartial']);
  vm.runInContext("showGate('waiting'); applyPartial([{start:0,end:100,th:'Thai'}],1); showGate('progress')", c);
  assert.equal(state.status, 'ready');
  assert.equal(video.paused, false);
  assert.equal(gate.video, null);
});

test('navigation releases a gate without autoplaying the previous video', () => {
  const video = {play() {throw new Error('Old video must not play');}, removeEventListener() {}};
  const gate = {video, wasPlaying: true};
  const c = context({gate}, ['releaseGateHold', 'hideGate']);
  vm.runInContext('hideGate(false)', c);
  assert.equal(gate.video, null);
});

test('appending subtitles preserves current speech; shifted segments invalidate cached audio', () => {
  const first = {start: 0, end: 2, text: 'One'};
  const state = {dub: {segments: [first], cursor: 1, playing: true}};
  let resets = 0, resyncs = 0;
  const c = context({state, buildDubSegments: cues => cues, resetAudioCache() {resets++;}, resyncDub() {resyncs++;}}, ['updateDubSegments']);
  vm.runInContext('updateDubSegments([{start:0,end:2,text:"One"},{start:2,end:4,text:"Two"}])', c);
  assert.equal(resets, 0);
  assert.equal(resyncs, 0);
  assert.equal(state.dub.cursor, 1);
  state.dub.cursor = 0;
  vm.runInContext('updateDubSegments([{start:0,end:2,text:"Changed"}])', c);
  assert.equal(resets, 1);
  assert.equal(resyncs, 1);
});

test('changing lecture starts B while A is still pending; stale A failure cannot replace B state', async () => {
  let tick, current = 'A';
  const pending = new Map();
  const calls = [];
  const state = {video: null, lectureKey: null, generation: 0};
  const c = context({state, site: {pageKey: () => current}, location: {pathname: '/'}, log() {}, setInterval: fn => {tick = fn;}, setTimeout() {}, MAX_RETRIES: 3, renderStatus() {}, describeTranslateError: String,
    start: () => {state.generation++; calls.push(current); return new Promise((resolve, reject) => pending.set(current, {resolve, reject}));}}, ['watchForLectureChange']);
  vm.runInContext('watchForLectureChange()', c);
  current = 'B';
  const second = tick();
  assert.deepEqual(calls, ['A', 'B']);
  state.status = 'ready';
  pending.get('A').reject(new Error('Old failure'));
  await flush();
  assert.equal(state.status, 'ready');
  assert.equal(state.lectureKey, 'B');
  pending.get('B').resolve();
  await second;
});

test('navigation before a poll response rejects the old result', async () => {
  let current = 'A', release;
  const state = {generation: 1, lectureKey: 'A'};
  let calls = 0;
  const c = context({state, site: {pageKey: () => current}, location: {pathname: '/'}, POLL_TIMEOUT_MS: 1000, POLL_INTERVAL_MS: 0, sleep: async () => {}, chrome: {runtime: {sendMessage: () => ++calls === 1 ? Promise.resolve({ok: true, data: {job: '123', status: 'queued'}}) : new Promise(resolve => {release = resolve;})}}}, ['assertCurrent', 'requestTranslation']);
  const pending = vm.runInContext('requestTranslation({},1)', c);
  await flush();
  current = 'B';
  release({ok: true, data: {status: 'done', cues: [{th: 'Old'}]}});
  await assert.rejects(pending, {name: 'Error'});
  assert.equal(calls, 2);
});

test('cancelled jobs end polling with an actionable error', async () => {
  const state = {generation: 1, lectureKey: 'A'};
  const c = context({state, site: {pageKey: () => 'A'}, location: {pathname: '/'}, POLL_TIMEOUT_MS: 1000, POLL_INTERVAL_MS: 0, sleep: async () => {}, chrome: {runtime: {sendMessage: async message => ({ok: true, data: message.type === 'startJob' ? {job: '123', status: 'queued'} : {status: 'cancelled'}})}}}, ['assertCurrent', 'requestTranslation']);
  await assert.rejects(vm.runInContext('requestTranslation({},1)', c), /ยกเลิก/);
});

test('readiness requires coverage ahead of the playhead, including short final clips', () => {
  const state = {video: {duration: 120}};
  const c = context({state, READY_AHEAD_SECONDS: 90}, ['coveredUntil', 'readyToRelease']);
  assert.equal(vm.runInContext('readyToRelease([{start:0,end:20,th:"yes"},{start:40,end:120,th:"yes"}],0)', c), false);
  assert.equal(vm.runInContext('readyToRelease([{start:100,end:120,th:"yes"}],100)', c), true);
});

test('manifest and popup wire the user-added study and queue controls', () => {
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
  const script = manifest.content_scripts.find(item => item.js.includes('content.js'));
  assert.ok(script.js.indexOf('workspace.js') < script.js.indexOf('content.js'));
  assert.ok(script.css.includes('workspace.css'));
  assert.match(fs.readFileSync('extension/popup.js', 'utf8'), /getURL\("manager.html"\)/);
  assert.match(source, /view.open\("transcript"\)/);
});
