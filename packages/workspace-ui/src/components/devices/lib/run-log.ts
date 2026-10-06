/**
 * A readable view of a build log for the Devices pane. Xcode and Gradle print
 * every compiler command in full; a person wants the step, the file, and any
 * warning or error. The raw output stays one click away.
 */

export type RunLogTone = 'step' | 'warning' | 'error' | 'note'

export interface RunLogLine {
  text: string
  /** The Xcode target or Gradle project the step belongs to. */
  target: string | null
  tone: RunLogTone
}

/** Xcode action names, as the log prints them, and the words a person reads. */
const XCODE_ACTIONS = new Map(Object.entries({
  CompileC: 'Compiling',
  CompileSwift: 'Compiling',
  SwiftCompile: 'Compiling',
  CompileSwiftSources: 'Compiling Swift sources',
  SwiftDriver: 'Planning Swift build',
  SwiftEmitModule: 'Emitting Swift module',
  CompileAssetCatalog: 'Compiling assets',
  CompileStoryboard: 'Compiling',
  CompileXIB: 'Compiling',
  Ld: 'Linking',
  Libtool: 'Archiving',
  CodeSign: 'Signing',
  PhaseScriptExecution: 'Running script',
  ProcessInfoPlistFile: 'Processing',
  ProcessPCH: 'Precompiling header',
  ProcessProductPackaging: 'Packaging',
  CpResource: 'Copying',
  CpHeader: 'Copying header',
  Copy: 'Copying',
  CopySwiftLibs: 'Copying Swift libraries',
  GenerateDSYMFile: 'Generating symbols',
  Touch: 'Finishing',
  RegisterExecutionPolicyException: 'Registering',
  Validate: 'Validating',
}))

const XCODE_ACTION_LINE = /^([A-Z][A-Za-z]+)\b(.*?)(?:\s+\(in target '([^']+)' from project '[^']+'\))?\s*$/
const ERROR_LINE = /(^|\s|:)(fatal )?error:|BUILD FAILED|^FAILURE:/i
const WARNING_LINE = /(^|\s|:)warning:/i

/** The last path segment of the word that names a source, else of the first path. */
function subjectOf(rest: string): string | null {
  const words = rest.trim().split(/\s+/).filter((word) => word.includes('/') || word.includes('.'))
  const source = words.find((word) => /\.(mm?|cc?|cpp|swift|plist|storyboard|xib|xcassets|sh)$/.test(word)) ?? words[0]
  if (!source) return null
  return source.replace(/\\ /g, ' ').split('/').filter(Boolean).pop() ?? null
}

/**
 * A warning or error without the absolute path in front of it. Xcode prints
 * `/…/App.xcodeproj: App: ld: warning: message` and `/…/File.swift:3:1: error: message`;
 * a person reads `ld: message` in `App`, or `message` in `File.swift:3:1`.
 */
function readProblem(line: string, tone: 'warning' | 'error'): RunLogLine {
  const match = /^(.*?):\s*(?:fatal )?(?:error|warning):\s*(.+)$/i.exec(line)
  if (!match) return { text: line, target: null, tone }
  const [location, ...rest] = match[1].split(/:\s+/)
  const place = location.split('/').pop() || null
  const isProject = location.endsWith('.xcodeproj') && rest.length > 0
  const tool = (isProject ? rest.slice(1) : rest).join(': ')
  return { text: tool ? `${tool}: ${match[2]}` : match[2], target: isProject ? rest[0] : place, tone }
}

/** One log line as a readable entry, or null when it is noise. */
export function readRunLogLine(raw: string): RunLogLine | null {
  // Xcode indents the commands and environment under each action.
  if (/^\s/.test(raw)) return null
  const line = raw.trim()
  if (!line) return null
  if (ERROR_LINE.test(line)) return readProblem(line, 'error')
  if (WARNING_LINE.test(line)) return readProblem(line, 'warning')
  const gradle = /^> Task (:\S+)/.exec(line)
  if (gradle) {
    const parts = gradle[1].split(':').filter(Boolean)
    return { text: parts.pop() ?? gradle[1], target: parts.join(':') || null, tone: 'step' }
  }
  const action = XCODE_ACTION_LINE.exec(line)
  const verb = action && XCODE_ACTIONS.get(action[1])
  if (action && verb) {
    const subject = subjectOf(action[2])
    return { text: subject && !verb.includes(' ') ? `${verb} ${subject}` : verb, target: action[3] ?? null, tone: 'step' }
  }
  // Lines a person may want: build results and short status messages.
  if (/^\*\* .+ \*\*$/.test(line) || /^BUILD (SUCCESSFUL|FAILED)/.test(line)) return { text: line.replace(/^\*\* | \*\*$/g, ''), target: null, tone: 'note' }
  return null
}

/**
 * Readable entries for a log, the newest last. A step repeated in a row shows
 * once; a warning or error shows once however often the build prints it.
 */
export function readRunLog(text: string, limit = 200): RunLogLine[] {
  const lines: RunLogLine[] = []
  const problems = new Set<string>()
  for (const raw of text.split('\n')) {
    const entry = readRunLogLine(raw)
    if (!entry) continue
    const key = `${entry.tone}\u0000${entry.target}\u0000${entry.text}`
    if (entry.tone === 'warning' || entry.tone === 'error') {
      if (problems.has(key)) continue
      problems.add(key)
    }
    const previous = lines[lines.length - 1]
    if (previous && previous.text === entry.text && previous.target === entry.target) continue
    lines.push(entry)
  }
  return lines.slice(-limit)
}

/** Minutes and seconds, as a build timer shows them: `0:42`, `12:05`. */
export function formatRunElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
