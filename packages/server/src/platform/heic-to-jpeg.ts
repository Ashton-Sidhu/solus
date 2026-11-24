import { execFile } from 'child_process'
import { stat, unlink } from 'fs/promises'

/** How long one photo may take to convert before the host keeps the original. */
const CONVERT_TIMEOUT_MS = 30_000

/**
 * Writes a JPEG copy of the HEIC photo at `inputPath` to `outputPath`, so every
 * client can show it (`isHeicFile`). Only macOS has a HEIC decoder that Solus
 * can count on: `sips`. The bundled image library has no HEVC decoder, so on any
 * other host, and when `sips` fails, this answers false, leaves no output, and
 * the caller keeps the original as a file.
 */
export async function heicToJpeg(inputPath: string, outputPath: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
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
  return false
}
