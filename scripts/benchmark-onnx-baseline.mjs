import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
const [model, ort, wav, output] = process.argv.slice(2);
process.env.BENCHMARK_MODEL_DIR = resolve(model);
process.env.ORT_MODULE_URL = pathToFileURL(resolve(ort)).href;
const { loadModel, transcribe } = await import("./baseline.mjs");
const file = readFileSync(wav);
let dataOffset = 12,
  dataBytes = 0;
while (dataOffset + 8 <= file.length) {
  const size = file.readUInt32LE(dataOffset + 4);
  if (file.toString("ascii", dataOffset, dataOffset + 4) === "data") {
    dataOffset += 8;
    dataBytes = size;
    break;
  }
  dataOffset += 8 + size + (size % 2);
}
const audio = Float32Array.from(
  { length: dataBytes / 2 },
  (_, i) => file.readInt16LE(dataOffset + 2 * i) / 32768,
);
const start = performance.now();
await loadModel();
const loadMs = performance.now() - start;
const results = [];
for (const seconds of (process.env.BENCH_DURATIONS ?? "11,60,120")
  .split(",")
  .map(Number)) {
  const samples = Float32Array.from(
    { length: seconds * 16000 },
    (_, i) => audio[i % audio.length],
  );
  for (
    let repeat = 0;
    repeat < Number(process.env.BENCH_REPEATS ?? 5);
    repeat++
  ) {
    const phaseMs = {};
    const begin = performance.now();
    const text = await transcribe(samples, phaseMs);
    const row = {
      seconds,
      repeat,
      inference_ms: performance.now() - begin,
      phase_ms: phaseMs,
      resident_mb: process.memoryUsage().rss / 1048576,
      words: text.split(/\s+/).length,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
}
writeFileSync(
  output,
  JSON.stringify(
    {
      runtime:
        "current Parakeet v3 INT8 ONNX worker; model/runtime path overrides and export only",
      platform: os.platform(),
      cpu: os.cpus()[0].model,
      threads: Math.min(4, Math.max(1, os.cpus().length - 2)),
      load_ms: loadMs,
      results,
    },
    null,
    2,
  ),
);
