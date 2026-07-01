import { execSync } from 'child_process'

let cachedPath: string | null = null

function appendPathEntries(target: string[], seen: Set<string>, rawPath: string | undefined): void {
  if (!rawPath) return
  for (const entry of rawPath.split(':')) {
    const p = entry.trim()
    if (!p || seen.has(p)) continue
    seen.add(p)
    target.push(p)
  }
}

export function getCliPath(): string {
  if (cachedPath) return cachedPath

  const ordered: string[] = []
  const seen = new Set<string>()

  appendPathEntries(ordered, seen, process.env.PATH)

  const home = require('os').homedir()
  appendPathEntries(ordered, seen, `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)

  // Interactive login shell runs nvm/asdf hooks; order matters for version-managed tools.
  const pathCommands = [
    '/bin/zsh -ilc "echo $PATH"',
    '/bin/zsh -lc "echo $PATH"',
    '/bin/bash -lc "echo $PATH"',
  ]

  for (const cmd of pathCommands) {
    try {
      const discovered = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim()
      appendPathEntries(ordered, seen, discovered)
    } catch {
      // Keep trying fallbacks.
    }
  }

  cachedPath = ordered.join(':')
  return cachedPath
}

export function getCliEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    PATH: getCliPath(),
  }
  delete env.CLAUDECODE
  return env
}
