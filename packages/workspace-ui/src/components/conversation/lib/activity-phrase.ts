/**
 * Turns an agent's stated intent into a phrase the activity row can say as one
 * sentence. Agents write intents in the imperative ("Run unit tests"), but a
 * live row reports what is happening ("Running unit tests"). Only a verb this
 * table knows is changed: "Dev server for the client" has no verb to inflect,
 * and guessing one gives "Deving server".
 */
const VERBS = new Set([
  'add', 'analyze', 'append', 'apply', 'audit', 'back', 'benchmark', 'boot', 'build', 'bump',
  'call', 'capture', 'check', 'clean', 'clear', 'clone', 'collect', 'commit', 'compare', 'compile',
  'confirm', 'copy', 'count', 'create', 'curl', 'delete', 'deploy', 'describe', 'detect', 'diff',
  'download', 'drop', 'dump', 'edit', 'ensure', 'execute', 'explore', 'export', 'extract', 'fetch',
  'find', 'fix', 'follow', 'format', 'gather', 'generate', 'get', 'grep', 'identify', 'import',
  'inspect', 'install', 'investigate', 'kill', 'launch', 'link', 'lint', 'list', 'load', 'locate',
  'look', 'make', 'measure', 'merge', 'migrate', 'monitor', 'move', 'open', 'parse', 'ping', 'poll',
  'prepare', 'preview', 'print', 'probe', 'profile', 'prune', 'publish', 'pull', 'push', 'query',
  'read', 'rebase', 'rebuild', 'record', 'regenerate', 'reinstall', 'remove', 'rename', 'render',
  'replace', 'reproduce', 'rerun', 'reset', 'resolve', 'restart', 'retry', 'review', 'run', 'scan',
  'search', 'seed', 'send', 'serve', 'set', 'show', 'sleep', 'start', 'stop', 'study', 'summarize',
  'switch', 'sync', 'tail', 'take', 'test', 'trace', 'trigger', 'typecheck', 'uninstall', 'unlink',
  'update', 'upgrade', 'upload', 'use', 'validate', 'verify', 'view', 'wait', 'watch', 'write',
])

/** Short verbs that end consonant–vowel–consonant with the stress on the end. */
const DOUBLES_FINAL_CONSONANT = new Set(['commit', 'drop', 'get', 'grep', 'rerun', 'run', 'set', 'stop'])

function participle(verb: string): string {
  if (DOUBLES_FINAL_CONSONANT.has(verb)) return `${verb}${verb.at(-1)}ing`
  if (verb.endsWith('ie')) return `${verb.slice(0, -2)}ying`
  if (verb.endsWith('e') && !/[eoy]e$/.test(verb)) return `${verb.slice(0, -1)}ing`
  return `${verb}ing`
}

/** The intent's leading verb, or null when the intent does not start with one. */
function splitIntent(intent: string): { verb: string; rest: string } | null {
  const text = intent.trim().replace(/\.$/, '')
  const match = /^([A-Za-z]+)(.*)$/s.exec(text)
  if (!match) return null
  const verb = match[1].toLowerCase()
  return VERBS.has(verb) ? { verb, rest: match[2] } : null
}

/** "Run unit tests" → "Running unit tests". Null when there is no known verb. */
export function intentInProgress(intent: string): string | null {
  const parts = splitIntent(intent)
  if (!parts) return null
  const verb = participle(parts.verb)
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}${parts.rest}`
}

/** "Study the diff panel" → "to study the diff panel", for "Waiting on a
 *  subagent to …". Null when there is no known verb. */
export function intentAsPurpose(intent: string): string | null {
  const parts = splitIntent(intent)
  return parts ? `to ${parts.verb}${parts.rest}` : null
}
