"use strict";
(() => {
  async function captureLesson({video, mediaDevices = navigator.mediaDevices,
    Recorder = MediaRecorder, makeStream = tracks => new MediaStream(tracks),
    onStatus = () => {}, signal}) {
    // Must run from the user's click, before any await, to preserve activation.
    const stream = await mediaDevices.getDisplayMedia({video:true, audio:true, preferCurrentTab:true});
    let recorder, timer, playbackRate = video.playbackRate;
    const parts = [];
    let size = 0, error = null;
    const stop = () => {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    };
    const fail = message => { error = new Error(message); stop(); };
    const pause = () => { if (recorder?.state === 'recording') recorder.pause(); };
    const play = () => { if (recorder?.state === 'paused') recorder.resume(); };
    // Stop before Udemy's ended handler navigates to the next lesson.
    // timeupdate runs before the native ended event; omit at most 0.6s.
    const nearEnd = () => {
      if (video.duration - video.currentTime <= 0.6) {
        stop();
        video.pause();
      }
    };
    const seek = () => fail('capture-seek');
    const cancel = () => fail('capture-cancelled');
    try {
      if (!stream.getAudioTracks().length) throw new Error('capture-no-audio');
      if (signal?.aborted) throw new Error('capture-cancelled');
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 720) throw new Error('capture-duration');
      video.pause();
      video.currentTime = 0;
      if (video.seeking) await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {cleanup(); reject(new Error('capture-seek-timeout'));}, 10000);
        const done = () => {cleanup(); resolve();};
        const cleanup = () => {clearTimeout(timeout); video.removeEventListener('seeked', done);};
        video.addEventListener('seeked', done, {once:true});
      });
      video.playbackRate = 1;
      const audio = makeStream(stream.getAudioTracks());
      const mimeType = Recorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      recorder = new Recorder(audio, {mimeType, audioBitsPerSecond:32000});
      const finished = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => {
          if (event.data.size) {parts.push(event.data); size += event.data.size;}
          if (size > 5 * 1024 * 1024) fail('capture-size');
        };
        recorder.onerror = () => fail('capture-recorder');
        recorder.onstop = () => error ? reject(error) : resolve(new Blob(parts, {type:mimeType}));
      });
      video.addEventListener('pause', pause);
      video.addEventListener('play', play);
      video.addEventListener('seeking', seek);
      video.addEventListener('ended', stop);
      video.addEventListener('timeupdate', nearEnd);
      signal?.addEventListener('abort', cancel);
      stream.getTracks().forEach(track => track.addEventListener('ended', cancel));
      recorder.start(1000);
      // Bound recording even if a broken player never emits ended.
      timer = setTimeout(() => fail('capture-timeout'), (video.duration + 120) * 1000);
      onStatus('recording');
      video.play().catch(() => fail('capture-play'));
      const blob = await finished;
      if (!blob.size) throw new Error('capture-empty');
      return blob;
    } finally {
      clearTimeout(timer);
      video.removeEventListener('pause', pause);
      video.removeEventListener('play', play);
      video.removeEventListener('seeking', seek);
      video.removeEventListener('ended', stop);
      video.removeEventListener('timeupdate', nearEnd);
      signal?.removeEventListener('abort', cancel);
      stream.getTracks().forEach(track => track.stop());
      video.pause();
      video.playbackRate = playbackRate;
    }
  }
  globalThis.UDTH = globalThis.UDTH || {};
  globalThis.UDTH.tabAudio = {captureLesson};
  if (typeof module !== 'undefined') module.exports = globalThis.UDTH.tabAudio;
})();
