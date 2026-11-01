const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseTimedText,storageKey}=require('../extension/core/imported-transcript.js');
test('imports SRT and VTT with Unicode text and timestamps',()=>{
 const srt='1\n00:01:02,500 --> 00:01:05,000\nHola <b>mundo</b>\n\n2\n00:01:05,000 --> 00:01:08,000\nこんにちは';
 assert.deepEqual(parseTimedText(srt),[{start:62.5,end:65,text:'Hola mundo'},{start:65,end:68,text:'こんにちは'}]);
 assert.deepEqual(parseTimedText('WEBVTT\n\n00:02.000 --> 00:04.000 align:start\nHello'),[{start:2,end:4,text:'Hello'}]);
 assert.deepEqual(parseTimedText('not subtitles'),[]);
 assert.notEqual(storageKey('a','b:c'),storageKey('a:b','c'));
});
