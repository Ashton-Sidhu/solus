import { readFile, writeFile } from 'fs/promises'
import { createLogger } from '../logger'

const log = createLogger('main', 'project-config')

/** Parse a JSON file, returning null if it doesn't exist (warns on other failures). */
export async function readJsonOrNull(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'))
  } catch (err) {
    log.warn(`failed to read ${filePath}: ${(err as Error).message}`)
    return null
  }
}


/** Write JSON via a temp file + rename so readers never see a partial file. */
export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
