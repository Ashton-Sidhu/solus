import { execFile } from 'child_process'
import { stat, unlink } from 'fs/promises'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'

/** How long one photo may take to convert before the host keeps the original. */
const CONVERT_TIMEOUT_MS = 30_000
const MAX_DECODE_PIXELS = 32_000_000
const require = createRequire(import.meta.url)

// Run the libheif decoder family used by T3 Code outside the host event loop.
// The worker body is fixed. Paths and limits are passed through workerData.
const jpegWorkerSource = `
  const { readFile, writeFile } = require('node:fs/promises')
  const { parentPort, workerData } = require('node:worker_threads')

  async function convert() {
    const { inputPath, outputPath, decoderPath, encoderPath, maxBytes, maxPixels } = workerData
    const source = await readFile(inputPath)
    if (source.byteLength > maxBytes) return false
    const libheif = await require(decoderPath)
    const decoder = new libheif.HeifDecoder()
    const images = decoder.decode(source)
    const image = images.find((candidate) => candidate.is_primary()) ?? images[0]
    if (!image) return false
    const width = image.get_width()
    const height = image.get_height()
    if (!(width > 0 && height > 0) || width > 16384 || height > 16384 || width * height > maxPixels) return false
    const pixels = await new Promise((resolve) => {
      image.display({ width, height, data: new Uint8ClampedArray(width * height * 4) }, resolve)
    })
    if (!pixels) return false
    const jpeg = require(encoderPath).encode(pixels, 85).data
    if (jpeg.byteLength > maxBytes) return false
    await writeFile(outputPath, jpeg, { flag: 'wx', mode: 0o600 })
    return true
  }

  convert().then(
    (converted) => parentPort.postMessage(converted),
    () => parentPort.postMessage(false),
  )
`

let previousPortableConversion = Promise.resolve()

function portableJpeg(inputPath: string, outputPath: string): Promise<boolean> {
  const conversion = previousPortableConversion.then(async () => {
    if ((await stat(inputPath)).size > MAX_ATTACHMENT_UPLOAD_BYTES) return false
    const worker = new Worker(jpegWorkerSource, {
      eval: true,
      workerData: {
        inputPath,
        outputPath,
        decoderPath: require.resolve('libheif-js/wasm-bundle'),
        encoderPath: require.resolve('jpeg-js'),
        maxBytes: MAX_ATTACHMENT_UPLOAD_BYTES,
        maxPixels: MAX_DECODE_PIXELS,
      },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<boolean>((resolve) => {
        worker.once('message', (result) => resolve(result === true))
        worker.once('error', () => resolve(false))
        worker.once('exit', () => resolve(false))
        timer = setTimeout(() => resolve(false), CONVERT_TIMEOUT_MS)
      })
    } finally {
      clearTimeout(timer)
      await worker.terminate()
    }
  }).catch(() => false)
  previousPortableConversion = conversion.then(() => {})
  return conversion
}

/**
 * Writes a JPEG copy of the HEIC photo at `inputPath` to `outputPath`, so every
 * client can show it. Prefer the macOS decoder where available. The portable
 * decoder also runs on Linux and Windows. On failure the caller keeps the
 * original as a file.
 */
export async function heicToJpeg(inputPath: string, outputPath: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    const converted = await new Promise<boolean>((resolve) => {
      execFile(
        '/usr/bin/sips',
        ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', inputPath, '--out', outputPath],
        { timeout: CONVERT_TIMEOUT_MS },
        (error) => resolve(!error),
      )
    })
    if (converted && (await stat(outputPath).catch(() => null))?.isFile()) return true
    await unlink(outputPath).catch(() => {})
  }
  if (await portableJpeg(inputPath, outputPath)) return true
  await unlink(outputPath).catch(() => {})
  return false
}
