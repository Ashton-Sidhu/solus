/**
 * Claude Code transcripts for the session-open benchmark, written into a
 * disposable HOME. Their shapes follow the sessions on a real Solus machine:
 * about five prompts a session, 15–35 tool calls a prompt, and 8 KB tool
 * results. No fixture reads or copies live data.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { encodePathAsFolder } from '@solus/contracts/types'

export interface Fixture {
  key: string
  title: string
  sessionId: string
  bytes: number
  artifacts: number
  /** The works the `render_artifact` calls saved. The benchmark creates them on
   *  the host, as the tool did, so a frame can read its HTML from its work. */
  works: Array<{ workId: string; title: string; html: string }>
}

interface Shape {
  key: string
  title: string
  turns: number
  toolsPerTurn: number
  fenceArtifacts?: number
  toolArtifacts?: number
  /** Bytes of HTML in one artifact. A compiled visual-artifacts bundle is 100–300 KB. */
  artifactBytes?: number
}

export const SHAPES: Shape[] = [
  { key: 'typical', title: 'Bench typical session', turns: 5, toolsPerTurn: 15 },
  { key: 'heavy', title: 'Bench heavy session', turns: 10, toolsPerTurn: 35 },
  { key: 'huge', title: 'Bench huge session', turns: 120, toolsPerTurn: 30 },
  // The largest first page seen in real use: 1,515 messages in ten turns.
  { key: 'agentic', title: 'Bench agentic session', turns: 10, toolsPerTurn: 75 },
  { key: 'fence-artifacts', title: 'Bench fence artifacts', turns: 5, toolsPerTurn: 15, fenceArtifacts: 6, artifactBytes: 30_000 },
  { key: 'tool-artifacts', title: 'Bench tool artifacts', turns: 5, toolsPerTurn: 15, toolArtifacts: 6, artifactBytes: 150_000 },
]

const prose = 'The change touches the reducer and the view, so the test reads both before it edits. '
const code = Array.from({ length: 40 }, (_, i) => `export function step${i}(value: number): number {\n  return value * ${i} + ${i * 3}\n}`).join('\n')

function artifactHtml(index: number, bytes: number): string {
  const rows: string[] = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const row = `<tr><td>row ${i}</td><td>${(i * 37) % 1000}</td><td>${prose.slice(0, 40)}</td></tr>`
    rows.push(row)
    size += row.length
  }
  return `<!doctype html><html><head><title>Artifact ${index}</title><style>body{font-family:var(--font-sans);color:var(--foreground)}td{padding:2px 6px}</style></head><body>
<h1>Artifact ${index}</h1><canvas id="c" width="600" height="200"></canvas>
<script>const ctx=document.getElementById('c').getContext('2d');for(let i=0;i<600;i+=4){ctx.fillRect(i,200-((i*7)%180),3,(i*7)%180)}</script>
<table>${rows.join('')}</table></body></html>`
}

class Transcript {
  lines: string[] = []
  private parent: string | null = null
  private clock = Date.parse('2026-10-01T09:00:00Z')

  constructor(readonly sessionId: string, readonly cwd: string) {}

  private push(type: 'user' | 'assistant', message: object, extra: object = {}): void {
    const uuid = randomUUID()
    this.clock += 1500
    this.lines.push(JSON.stringify({
      parentUuid: this.parent, isSidechain: false, userType: 'external', cwd: this.cwd, sessionId: this.sessionId,
      version: '2.1.0', gitBranch: 'main', type, message, uuid, timestamp: new Date(this.clock).toISOString(), ...extra,
    }))
    this.parent = uuid
  }

  prompt(text: string): void {
    this.push('user', { role: 'user', content: text })
  }

  say(text: string): void {
    this.push('assistant', { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] })
  }

  /** Claude Code writes a signed thinking block before most tool calls. Its text is empty on disk; only the signature is kept. */
  think(): void {
    this.push('assistant', { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5',
      content: [{ type: 'thinking', thinking: '', signature: 'E'.repeat(1200) }] })
  }

  /** `toolUseResult` is Claude Code's structured copy of the result; real lines carry it beside the text. */
  tool(name: string, input: object, result: string, toolUseResult: object = { type: 'text' }): void {
    const id = `toolu_${randomUUID().replaceAll('-', '')}`
    this.push('assistant', { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] })
    this.push('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] }, { toolUseResult })
  }
}

function write(shape: Shape, projectDir: string, projectsRoot: string): Fixture {
  const sessionId = randomUUID()
  const transcript = new Transcript(sessionId, projectDir)
  const artifactCount = (shape.fenceArtifacts ?? 0) + (shape.toolArtifacts ?? 0)
  let artifactIndex = 0
  const works: Fixture['works'] = []
  for (let turn = 0; turn < shape.turns; turn++) {
    transcript.prompt(turn === 0 ? shape.title : `Turn ${turn}: fix the failing test and explain the cause.`)
    transcript.say('Reading the test first.')
    for (let i = 0; i < shape.toolsPerTurn; i++) {
      const file = `${projectDir}/src/file-${turn}-${i}.ts`
      const source = code.slice(0, 8000)
      if (i % 2 === 0) transcript.think()
      if (i % 3 === 2) {
        transcript.tool('Edit', { file_path: file, old_string: prose.repeat(4), new_string: prose.repeat(5) }, `The file ${file} has been updated.`,
          { filePath: file, oldString: prose.repeat(4), newString: prose.repeat(5), originalFile: source, structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, lines: [prose, prose] }], userModified: false, replaceAll: false })
      } else if (i % 5 === 1) {
        const output = `bun test v1.3\n${'✓ reducer keeps state\n'.repeat(120)}`
        transcript.tool('Bash', { command: 'bun test tests/unit/reducer.test.ts', description: 'Run reducer tests' }, output, { stdout: output, stderr: '', interrupted: false, isImage: false })
      } else {
        transcript.tool('Read', { file_path: file }, source, { type: 'text', file: { filePath: file, content: source, numLines: 160, startLine: 1, totalLines: 160 } })
      }
    }
    // Artifacts land in the most recent turns, which the first history page loads.
    const isArtifactTurn = turn >= shape.turns - artifactCount
    if (isArtifactTurn && artifactIndex < (shape.fenceArtifacts ?? 0)) {
      const html = artifactHtml(artifactIndex, shape.artifactBytes ?? 30_000)
      transcript.say(`Here is the chart.\n\n\`\`\`html render artifact=chart-${artifactIndex}\n${html}\n\`\`\`\n\nIt shows the trend.`)
      artifactIndex++
    } else if (isArtifactTurn && artifactIndex < artifactCount) {
      const title = `Dashboard ${artifactIndex}`
      const workId = randomUUID()
      const html = artifactHtml(artifactIndex, shape.artifactBytes ?? 150_000)
      works.push({ workId, title, html })
      transcript.tool('mcp__solus__render_artifact', { title, html },
        `Rendered "${title}" in the conversation and saved it as an artifact (id: ${workId}).`)
      artifactIndex++
    }
    transcript.say(`${prose.repeat(6)}\n\n\`\`\`ts\n${code.slice(0, 1200)}\n\`\`\`\n\n- The reducer keeps state.\n- The view reads it once.`)
  }
  const folder = join(projectsRoot, encodePathAsFolder(projectDir))
  mkdirSync(folder, { recursive: true })
  const body = transcript.lines.join('\n') + '\n'
  writeFileSync(join(folder, `${sessionId}.jsonl`), body)
  return { key: shape.key, title: shape.title, sessionId, bytes: Buffer.byteLength(body), artifacts: artifactCount, works }
}

/** Writes every shape into `home/.claude/projects` for one project at `projectDir`. */
export function writeFixtures(home: string, projectDir: string): Fixture[] {
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  const projectsRoot = join(home, '.claude', 'projects')
  return SHAPES.map((shape) => write(shape, projectDir, projectsRoot))
}
