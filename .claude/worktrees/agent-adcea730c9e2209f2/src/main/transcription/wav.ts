function readAscii(view: DataView, offset: number, length: number): string {
  let value = ''
  for (let i = 0; i < length; i++) value += String.fromCharCode(view.getUint8(offset + i))
  return value
}

export function readWav(buffer: Buffer): Float32Array {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Audio must be a RIFF WAV file')
  }

  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = 0
  let dataLength = 0
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const chunkId = readAscii(view, offset, 4)
    const chunkLength = view.getUint32(offset + 4, true)
    const chunkOffset = offset + 8
    if (chunkId === 'fmt ') {
      channels = view.getUint16(chunkOffset + 2, true)
      sampleRate = view.getUint32(chunkOffset + 4, true)
      bitsPerSample = view.getUint16(chunkOffset + 14, true)
    } else if (chunkId === 'data') {
      dataOffset = chunkOffset
      dataLength = chunkLength
    }
    offset = chunkOffset + chunkLength + (chunkLength % 2)
  }
  if (!dataOffset || channels !== 1 || sampleRate !== 16_000 || bitsPerSample !== 16) {
    throw new Error('Audio must be a 16 kHz mono signed 16-bit PCM WAV')
  }

  const samples = new Float32Array(dataLength / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(dataOffset + i * 2, true) / 0x8000
  return samples
}
