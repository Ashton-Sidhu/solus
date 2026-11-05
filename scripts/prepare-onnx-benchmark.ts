import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Preserve the pre-change worker's inference code. Only model/runtime paths
// and function exports differ; no live model cache or Solus data is loaded.
// Usage: bun scripts/prepare-onnx-benchmark.ts BASE_REF OUTPUT_DIRECTORY
const [baseRef, outputDirectory] = process.argv.slice(2);
if (!baseRef || !outputDirectory)
  throw new Error("Expected BASE_REF and OUTPUT_DIRECTORY");
const worker = execFileSync(
  "git",
  ["show", `${baseRef}:packages/server/src/transcription/worker.ts`],
  { encoding: "utf8" },
);
const cleanup = execFileSync(
  "git",
  ["show", `${baseRef}:packages/server/src/transcription/clean-transcript.ts`],
  { encoding: "utf8" },
);
if (
  !worker.includes("import * as ort from 'onnxruntime-node'") ||
  !worker.includes(
    "import { cleanVoiceTranscript } from './clean-transcript'",
  ) ||
  !worker.includes("join(homedir(), '.solus', 'models', MODEL_NAME)")
)
  throw new Error(
    "Baseline worker shape changed; refusing to use unmodified runtime or model paths",
  );
const source =
  worker
    .replace(
      "import * as ort from 'onnxruntime-node'",
      "const ort = await import(process.env.ORT_MODULE_URL)",
    )
    .replace(
      "import { cleanVoiceTranscript } from './clean-transcript'",
      cleanup.replace("export function", "function"),
    )
    .replace(
      "join(homedir(), '.solus', 'models', MODEL_NAME)",
      "process.env.BENCHMARK_MODEL_DIR",
    ) + "\nexport { loadModel, transcribe }\n";
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  resolve(outputDirectory, "baseline.mjs"),
  new Bun.Transpiler({ loader: "ts" }).transformSync(source),
);
writeFileSync(
  resolve(outputDirectory, "benchmark-baseline.mjs"),
  readFileSync(new URL("./benchmark-onnx-baseline.mjs", import.meta.url)),
);
