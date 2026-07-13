export function takeSessionScanBatch<T>(buffer: T[], batchSize: number): T[] {
  return buffer.splice(0, batchSize)
}
