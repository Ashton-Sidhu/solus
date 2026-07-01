// A single AudioContext reused for every decode. Creating one per call and
// closing it after the awaited decodeAudioData leaked a context whenever the
// decode rejected (empty/corrupt capture — common when auto-voice re-arms on
// near-silence). Browsers hard-cap concurrent AudioContexts (~6 in Chrome), so
// a few leaks would permanently break recording. decodeAudioData is stateless,
// so one long-lived context serves every call.
let decodeCtx: AudioContext | null = null

function getDecodeContext(): AudioContext {
  if (!decodeCtx || decodeCtx.state === 'closed') decodeCtx = new AudioContext()
  return decodeCtx
}

export async function blobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer()
  const decoded = await getDecodeContext().decodeAudioData(arrayBuffer)
  const mono = mixToMono(decoded)
  if (rmsLevel(mono) < 0.003) {
    throw new Error(
      'No voice detected. Check microphone permission and speak closer to the mic.',
    )
  }
  const resampled = resampleLinear(mono, decoded.sampleRate, 16000)
  const normalized = normalizePcm(resampled)
  return bufferToBase64(encodeWav(normalized, 16000))
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer
  if (numberOfChannels <= 1) return buffer.getChannelData(0)
  const mono = new Float32Array(length)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const channel = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) mono[i] += channel[i]
  }
  const inv = 1 / numberOfChannels
  for (let i = 0; i < length; i++) mono[i] *= inv
  return mono
}

function resampleLinear(
  input: Float32Array,
  inRate: number,
  outRate: number,
): Float32Array {
  if (inRate === outRate) return input
  const ratio = inRate / outRate
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const output = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio,
      i0 = Math.floor(pos),
      i1 = Math.min(i0 + 1, input.length - 1),
      t = pos - i0
    output[i] = input[i0] * (1 - t) + input[i1] * t
  }
  return output
}

function normalizePcm(samples: Float32Array): Float32Array {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  if (peak < 1e-4 || peak > 0.95) return samples
  const gain = Math.min(0.95 / peak, 8)
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain
  return out
}

function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
  return Math.sqrt(sumSq / samples.length)
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ws = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  ws(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ws(8, 'WAVE')
  ws(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ws(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return buffer
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
