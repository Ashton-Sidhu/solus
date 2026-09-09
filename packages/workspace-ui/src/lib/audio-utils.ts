export function resampleLinear(
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

/**
 * Stateful linear resampler for live PCM. Keeping the fractional input position
 * across worklet messages avoids the clock drift and edge discontinuities that
 * come from resampling each tiny AudioWorklet block independently.
 */
export class StreamingLinearResampler {
  private tail = new Float32Array()
  private position = 0
  private totalInputSamples = 0
  private totalOutputSamples = 0
  private readonly ratio: number

  constructor(
    private readonly inRate: number,
    private readonly outRate: number,
  ) {
    this.ratio = inRate / outRate
  }

  push(input: Float32Array): Float32Array {
    if (input.length === 0) return input
    if (this.inRate === this.outRate) return input
    this.totalInputSamples += input.length

    const samples = appendFloat32(this.tail, input)
    if (samples.length < 2) {
      this.tail = samples.slice()
      return new Float32Array()
    }

    const capacity = Math.max(0, Math.ceil((samples.length - 1 - this.position) / this.ratio))
    const output = new Float32Array(capacity)
    let length = 0
    while (this.position + 1 < samples.length) {
      const i0 = Math.floor(this.position)
      const t = this.position - i0
      output[length++] = samples[i0] * (1 - t) + samples[i0 + 1] * t
      this.position += this.ratio
    }

    const keepFrom = Math.min(Math.floor(this.position), samples.length - 1)
    this.tail = samples.slice(keepFrom)
    this.position -= keepFrom
    this.totalOutputSamples += length
    return length === output.length ? output : output.slice(0, length)
  }

  flush(): Float32Array {
    if (this.inRate === this.outRate || this.tail.length === 0) return new Float32Array()

    const targetLength = Math.floor(this.totalInputSamples / this.ratio)
    const output = new Float32Array(Math.max(0, targetLength - this.totalOutputSamples))
    let length = 0
    while (length < output.length && this.position < this.tail.length) {
      const i0 = Math.floor(this.position)
      const i1 = Math.min(i0 + 1, this.tail.length - 1)
      const t = this.position - i0
      output[length++] = this.tail[i0] * (1 - t) + this.tail[i1] * t
      this.position += this.ratio
    }
    this.tail = new Float32Array()
    this.position = 0
    this.totalInputSamples = 0
    this.totalOutputSamples = 0
    return length === output.length ? output : output.slice(0, length)
  }
}

function appendFloat32(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b
  const output = new Float32Array(a.length + b.length)
  output.set(a)
  output.set(b, a.length)
  return output
}
