const {test}=require('node:test');
const assert=require('node:assert/strict');
const {captureLesson}=require('../extension/core/tab-audio.js');
function fixture({noAudio=false}={}) {
 const video=new EventTarget(); Object.assign(video,{duration:10,currentTime:5,playbackRate:1.5,seeking:false,pause(){this.dispatchEvent(new Event('pause'));},play(){this.dispatchEvent(new Event('play'));return Promise.resolve();}});
 const track=new EventTarget();track.stopped=false;track.stop=()=>{track.stopped=true;};
 const stream={getAudioTracks:()=>noAudio?[]:[track],getTracks:()=>[track]};
 class Recorder {
  static isTypeSupported(){return true;}
  constructor(){this.state='inactive';}
  start(){this.state='recording';}
  pause(){this.state='paused';}
  resume(){this.state='recording';}
  stop(){this.state='inactive';this.ondataavailable({data:new Blob(['audio'])});this.onstop();}
 }
 return {video,track,options:{video,mediaDevices:{getDisplayMedia:async()=>stream},Recorder,makeStream:()=>stream}};
}
test('capture starts at zero, returns audio at end and releases every track',async()=>{
 const f=fixture();let ready;const started=new Promise(r=>ready=r);
 const pending=captureLesson({...f.options,onStatus:ready});await started;
 assert.equal(f.video.currentTime,0);assert.equal(f.video.playbackRate,1);
 f.video.dispatchEvent(new Event('ended'));
 const audio=await pending;assert.ok(audio.size);assert.equal(f.track.stopped,true);assert.equal(f.video.playbackRate,1.5);
});
test('rejects missing audio and stops the screen stream',async()=>{
 const f=fixture({noAudio:true});await assert.rejects(captureLesson(f.options),/capture-no-audio/);assert.ok(f.track.stopped);
});
test('cancelling or seeking discards the capture rather than importing misaligned subtitles',async()=>{
 for(const event of ['abort','seeking']){
  const f=fixture(),controller=new AbortController();let ready;const started=new Promise(r=>ready=r);
  const pending=captureLesson({...f.options,signal:controller.signal,onStatus:ready});await started;
  event==='abort'?controller.abort():f.video.dispatchEvent(new Event('seeking'));
  await assert.rejects(pending,/capture-(cancelled|seek)/);assert.ok(f.track.stopped);
 }
});

test('finishes before native ended can navigate to the next Udemy lesson',async()=>{
 const f=fixture();let ready;const started=new Promise(r=>ready=r);
 const pending=captureLesson({...f.options,onStatus:ready});await started;
 f.video.currentTime=9.5;
 f.video.dispatchEvent(new Event('timeupdate'));
 const audio=await pending;assert.ok(audio.size);assert.ok(f.track.stopped);
});
