import { VoiceStreamSession } from '../../../packages/workspace-ui/src/lib/voice-stream';
import { writeFile } from 'node:fs/promises';
const sleep = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
const results=[];
for(const packetMs of [250,100]) for(const requestMs of [2,140]) {
  let calls=0;
  const stream = new VoiceStreamSession({
    voiceStreamStart: async()=>({streamId:'benchmark'}),
    voiceStreamFeed: async()=>{calls++;await sleep(requestMs);return {stable:'',tentative:''}},
    voiceStreamFinish: async()=>({transcript:'fixture',error:null}),
    voiceStreamCancel: async()=>{},
  });
  const start=performance.now(); const durationMs=3000;
  for(let at=packetMs;at<=durationMs;at+=packetMs){
    await sleep(Math.max(0,start+at-performance.now()));
    stream.feed(new Float32Array(packetMs*16));
  }
  await stream.finish();
  const row={packet_ms:packetMs,simulated_request_ms:requestMs,calls,stop_wait_ms:performance.now()-start-durationMs};
  results.push(row);console.log(row);
}
const serialization=[];
for(const packetMs of [250,100]) {
 const samples=Float32Array.from({length:packetMs*16},(_,i)=>Math.sin(i));
 const start=performance.now();let bytes=0;
 for(let i=0;i<1000;i++){const json=JSON.stringify({samples:Array.from(samples)});bytes+=json.length;JSON.parse(json)}
 serialization.push({packet_ms:packetMs,roundtrip_us:(performance.now()-start)*1000/1000,bytes_per_second:bytes/1000*1000/packetMs});
}
await writeFile(process.argv[2] ?? '/tmp/voice-transport-benchmark.json',JSON.stringify({note:'Synthetic request delay, real VoiceStreamSession; not a network benchmark',results,serialization},null,2));
