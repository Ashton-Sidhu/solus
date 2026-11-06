import {writeFileSync} from 'node:fs';
// Synthetic worklet blocks at 48 kHz, with a speech onset swept across a packet.
// Compare meter windows only. Audio delivery remains 250 ms in both cases.
const rows=[];
for(const windowMs of [250,32]){
 const latencies=[];let checksum=0;
 const block=Float32Array.from({length:128},(_,i)=>Math.sin(i)*.03);
 const start=performance.now();
 for(let i=0;i<100000;i++){let sum=0;for(const sample of block)sum+=sample*sample;checksum+=Math.sqrt(sum/block.length)}
 const rmsMs=performance.now()-start;
 for(let onset=0;onset<250;onset++)latencies.push(Math.ceil((onset+.001)/windowMs)*windowMs-onset);
 const sorted=latencies.toSorted((a,b)=>a-b);
 rows.push({meter_window_ms:windowMs,onset_sweep_p50_ms:sorted[Math.floor(sorted.length*.5)],onset_sweep_max_ms:Math.max(...latencies),rms_128_samples_us:rmsMs*1000/100000,checksum});
}
writeFileSync(process.argv[2] ?? '/tmp/voice-meter-benchmark.json',JSON.stringify({note:'Synthetic onset sweep; no microphone, permission, or device latency. 32 ms is a proposed meter cadence, not shipping behavior.',rows},null,2));
