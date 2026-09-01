/**
 * Paints streamed JPEG frames onto a canvas, newest-frame-wins.
 *
 * Decoding a JPEG is asynchronous, so two frames can be in flight through
 * `createImageBitmap` at once and finish out of order. The seq guards against
 * an older frame painting over a newer one — both before decoding (a cheap
 * reject) and after, because the newer one may have finished while the older
 * was decoding. The canvas backing store is sized to the frame; the element's
 * CSS size is the stage's job, so the picture scales to the pane without the
 * painter knowing the pane exists.
 */
export class FramePainter {
  private readonly ctx: CanvasRenderingContext2D | null
  private lastPaintedSeq = 0
  private disposed = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')
  }

  async paint(seq: number, data: ArrayBuffer): Promise<void> {
    if (this.disposed || seq <= this.lastPaintedSeq) return
    const bitmap = await decodeFrame(data)
    if (!bitmap) return
    // Re-check after the await: a newer frame may have won while this decoded,
    // and the surface may have been torn down.
    if (this.disposed || seq <= this.lastPaintedSeq || !this.ctx) {
      bitmap.close()
      return
    }
    this.lastPaintedSeq = seq
    this.draw(bitmap)
    bitmap.close()
  }

  /** Restore the last compressed frame while a fresh subscription starts.
   *  It does not advance the sequence: a server reconnect can restart sequence
   *  numbers, and a cached frame must never block the new stream. */
  async restore(data: ArrayBuffer): Promise<void> {
    if (this.disposed) return
    const paintedBeforeRestore = this.lastPaintedSeq
    const bitmap = await decodeFrame(data)
    if (!bitmap) return
    // A live frame that decoded first is newer than the cache. Never let the
    // slower restore cover it after the fact.
    if (this.disposed || this.lastPaintedSeq !== paintedBeforeRestore || !this.ctx) {
      bitmap.close()
      return
    }
    this.draw(bitmap)
    bitmap.close()
  }

  private draw(bitmap: ImageBitmap): void {
    if (!this.ctx) return
    if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
      this.canvas.width = bitmap.width
      this.canvas.height = bitmap.height
    }
    this.ctx.drawImage(bitmap, 0, 0)
  }

  dispose(): void {
    this.disposed = true
  }
}

async function decodeFrame(data: ArrayBuffer): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
  } catch {
    // A truncated or malformed frame is skipped; the next one repaints.
    return null
  }
}
