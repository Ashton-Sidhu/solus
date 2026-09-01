import { chmod, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export async function writeTempSecretScript(
  prefix: string,
  filename: string,
  script: string,
): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  const path = join(directory, filename)
  await writeFile(path, script, { mode: 0o700 })
  await chmod(path, 0o700)
  return { directory, path }
}
