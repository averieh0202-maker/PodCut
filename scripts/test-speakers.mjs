import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'podcut-speakers-'));
try {
  await build({stdin:{contents:`export * from './server/volcAsr';export * from './src/edit/speakers';export * from './src/edit/exportTranscript';export * from './src/edit/episodeTimeline';export * from './src/edit/publicationTranscript';export * from './server/roughCutPlanner';export * from './src/edit/tokenize';export * from './src/edit/history';export * from './src/edit/draftStore';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:join(dir,'test.mjs'),logLevel:'silent'});
  const lib=await import(join(dir,'test.mjs'));
  const {extractWords,speakerRecognitionOptions,scopeSpeakers,listSpeakers,groupSpeakerUtterances,applySpeakerLabels,buildTranscriptText,buildPublicationTranscript,episodeSegments,validateDecisions,planRoughCut,characterWords,UndoStack,projectToDraft,draftToProject}=lib;
  const body={result:{utterances:[
    {text:'你好。',start_time:0,end_time:900,additions:{speaker:0},words:[{text:'你好',start_time:0,end_time:900}]},
    {text:'你好！',start_time:1100,end_time:1900,additions:{speaker:'7'},words:[{text:'你好',start_time:1100,end_time:1900}]},
    {text:'继续聊',start_time:2100,end_time:2900,speaker_id:'0',words:[{text:'继续聊',start_time:2100,end_time:2900}]},
    {text:'未知',start_time:3100,end_time:3500,additions:{speaker:'-1'},words:[{text:'未知',start_time:3100,end_time:3500}]}
  ]}};
  const raw=extractWords(body).words;
  assert.equal(raw[0].speakerId,'0','numeric zero speaker survives');
  assert.equal(raw[1].text,'。'); assert.equal(raw[1].speakerId,'0','merged punctuation inherits speaker');
  assert.equal(raw.at(-1).speakerId,undefined,'negative provider ID is unknown');
  assert.deepEqual(extractWords({body}).words,raw,'nested gateway result supported');
  assert.equal(extractWords({result:{utterances:[{text:'无时间戳。',start_time:0,end_time:1000,additions:{speaker:'3'}}]}}).words.every(w=>w.speakerId==='3'),true,'utterance fallback preserves identity');
  const scoped=scopeSpeakers(raw,'recording-a');
  assert.deepEqual(listSpeakers(scoped).map(s=>s.name),['说话人 1','说话人 2']);
  assert.equal(scoped[0].speakerId,scoped[4].speakerId,'returning speaker has stable ID');
  assert.notEqual(scoped[0].speakerId,scopeSpeakers(raw,'recording-b')[0].speakerId,'same numeric provider ID in another recording is a different identity');
  const groups=groupSpeakerUtterances([{speakerId:'a'},{speakerId:'b'},{speakerId:'a',breakAfter:true},{speakerId:'a'}]);assert.deepEqual(groups.map(g=>g.length),[1,1,1,1],'speaker switches split without breakAfter');
  const words=characterWords(scoped.map((w,i)=>({...w,id:'w'+i,deleted:false,alignmentSource:'qwen3'})));
  assert.ok(words.filter(w=>w.speakerId).every(w=>w.speakerName),'character split preserves metadata');
  assert.match(buildTranscriptText(words),/说话人 1：\n你好。\n\n说话人 2：\n你好！\n\n说话人 1：\n继续聊\n\n说话人待确认：\n未知/);
  const old=[{id:'a',text:'Siri ',start:0,end:1,deleted:true,manualBoundary:true,removedAudio:[{start:0,end:1.05}],alignmentSource:'qwen3'},
    {id:'b',text:'保留',start:1.1,end:1.9,deleted:false}, {id:'p',text:'。',start:1.9,end:1.9,deleted:false}];
  const copy=structuredClone(old),labelled=applySpeakerLabels(old,raw,'new-task');
  assert.deepEqual(old,copy,'backfill never mutates the original');
  assert.equal(labelled[0].deleted,true);assert.equal(labelled[0].manualBoundary,true);assert.deepEqual(labelled[0].removedAudio,copy[0].removedAudio);
  assert.equal(labelled[0].id,'a');assert.equal(labelled[1].text,'保留');assert.equal(labelled[1].start,1.1);assert.equal(labelled[2].speakerId,labelled[1].speakerId);
  const ambiguous=applySpeakerLabels([{...old[1],start:0,end:1}],[{start:0,end:1,speakerId:'a'},{start:0,end:1,speakerId:'b'}],'overlap');assert.equal(ambiguous[0].speakerId,undefined,'simultaneous voices stay unknown');
  assert.equal(applySpeakerLabels([{...old[1],start:9,end:10}],raw,'gap')[0].speakerId,undefined,'missing speech is never attributed by nearest neighbour');
  const clip={id:'c',duration:4,buffer:{duration:4},words,ranges:[{start:0,end:4}]};
  const segments=episodeSegments([clip],[],1.1);assert.equal(new Set(segments.map(s=>s.speakerId).filter(Boolean)).size,2);
  assert.match(buildPublicationTranscript(segments),/说话人 2：/);assert.ok(!buildPublicationTranscript(segments).includes('teaser'));
  assert.equal(buildTranscriptText([{...old[1],text:'普通独白。',breakAfter:true}]),'普通独白。','legacy solo transcript is unchanged');
  assert.equal(buildTranscriptText([{...old[1],text:'Siri and Muse。'}]),'Siri and Muse。','English spaces retained');
  const undo=new UndoStack();undo.push({clipId:'c',words,ranges:clip.ranges});words[0].speakerName='主持人';assert.equal(undo.pop().words[0].speakerName,'说话人 1','metadata undo is copied');
  const multiWords=[...'因为大家今天因为大家继续讨论'].map((text,i)=>({id:'v'+i,text,start:i*.2,end:i*.2+.15,deleted:false,alignmentSource:'qwen3',speakerId:i<6?'a':'b',speakerName:i<6?'主持人':'嘉宾'}));
  const decision={clipId:'talk',startWordId:'v0',endWordId:'v1',keepStartWordId:'v6',keepEndWordId:'v11',quote:'因为',keptQuote:multiWords.slice(6,12).map(w=>w.text).join(''),kind:'false_start',reason:'测试'};
  assert.equal(validateDecisions({cuts:[decision]},[{id:'talk',words:multiWords}]).length,0,'different speakers never become retakes');
  const same=multiWords.map(w=>({...w,speakerId:'a'}));assert.equal(validateDecisions({cuts:[decision]},[{id:'talk',words:same}]).length,1,'same speaker retake remains editable');
  const backAndForth=same.map((w,i)=>({...w,speakerId:i===4?'b':'a'}));assert.equal(validateDecisions({cuts:[decision]},[{id:'talk',words:backAndForth}]).length,0,'A-B-A dialogue is protected');
  await planRoughCut([{id:'talk',words:multiWords}],'',async(system,data)=>{assert.match(system,/不同人/);assert.equal(data.words[0].speakerId,'a');assert.match(data.fullTranscript[0].text,/主持人/);return {cuts:[]};});
  const wav=seconds=>{const b=Buffer.alloc(44+seconds*32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(seconds*32000,40);return b;};
  assert.equal(speakerRecognitionOptions({kind:'data',buffer:wav(30),filename:'short.wav'}).ssd_mode,0);
  assert.equal(speakerRecognitionOptions({kind:'data',buffer:wav(181),filename:'long.wav'}).ssd_mode,1);
  assert.equal(speakerRecognitionOptions({kind:'url',url:'https://example.org/a.mp3'}).ssd_mode,1,'unknown URL duration defaults to podcast clustering');
  assert.equal(speakerRecognitionOptions({kind:'data',buffer:Buffer.from('not wav'),filename:'a.mp3'}).enable_speaker_info,true);
  const audio={duration:4,numberOfChannels:1,sampleRate:16000,length:64000,getChannelData:()=>new Float32Array(64000)};
  const draft=projectToDraft({project:{clips:[{...clip,name:'多人',buffer:audio,cleanBuffer:audio,denoised:false,beautified:false,sourceBlob:new Blob(['audio']),sourceMime:'audio/wav'}],music:[],gainDb:0,audioName:'talk'},activeClipId:'c',clipIdSeq:1,musicIdSeq:0});
  assert.equal(draft.clips[0].words[0].speakerName,'主持人');
  const restored=await draftToProject(draft,{decode:async()=>audio,loadSfxBlob:async()=>null,applyFx:async b=>b});
  assert.equal(restored.project.clips[0].words[0].speakerName,'主持人','draft restore retains name');
  console.log('Speaker checks passed: ASR zero IDs and punctuation, short/long modes, recording scope, turns, ambiguity, precise-edit preservation, tokenization, undo, draft restore, TXT and manuscript export, tempo timestamps, and cross-speaker Agent protection.');
} finally { await rm(dir,{recursive:true,force:true}); }
