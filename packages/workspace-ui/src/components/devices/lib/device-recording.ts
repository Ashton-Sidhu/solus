// Capture the upright device pixels from the preview that already owns the stream.
const RECORDING_TYPES = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
const MAX_RECORDING_BYTES = 128 * 1024 * 1024

export function deviceRecordingType(): string | undefined {
  if (!globalThis.HTMLCanvasElement?.prototype.captureStream || !globalThis.MediaRecorder?.isTypeSupported) return
  return RECORDING_TYPES.find(type => MediaRecorder.isTypeSupported(type))
}

export function recordDeviceScreen(canvas: HTMLCanvasElement, mimeType: string, complete: (video: Blob | Error) => void): () => void {
  const stream = canvas.captureStream(30)
  const chunks: Blob[] = []
  let bytes = 0
  let failed = false
  const release = () => { for (const track of stream.getTracks()) track.stop() }
  try {
    const recorder = new MediaRecorder(stream, { mimeType })
    const stop = () => { if (recorder.state !== 'inactive') recorder.stop() }
    recorder.ondataavailable = ({ data }) => {
      if (!data.size) return
      chunks.push(data)
      bytes += data.size
      if (bytes >= MAX_RECORDING_BYTES) stop()
    }
    recorder.onerror = () => { failed = true }
    recorder.onstop = () => {
      release()
      complete(failed || !bytes ? new Error('The device recording could not be saved.') : new Blob(chunks, { type: recorder.mimeType }))
    }
    recorder.start(1000)
    // An idle simulator may not send another frame before Stop.
    canvas.getContext('2d')?.drawImage(canvas, 0, 0)
    return stop
  } catch (error) {
    release()
    throw error
  }
}
