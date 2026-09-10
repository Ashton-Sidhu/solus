import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentId, SessionMeta } from '@solus/contracts/types'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import type { AgentRunRequest } from '@solus/server/agents/agent-runner'

const sessionSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  persistent: z.boolean().default(true),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string(), timestamp: z.number() })),
})
type StoredSession = z.infer<typeof sessionSchema>

/** Test-build only. Stores provider history exclusively under the disposable data root. */
export class MockHistory {
  private readonly sessions = new Map<string, StoredSession>()
  private readonly filePath?: string

  constructor(private readonly provider: AgentId, dataDir = process.env.SOLUS_DATA_DIR) {
    if (dataDir) {
      const directory = join(dataDir, 'mock-history')
      mkdirSync(directory, { recursive: true })
      this.filePath = join(directory, `${provider}.json`)
      if (existsSync(this.filePath)) {
        for (const session of z.array(sessionSchema).parse(JSON.parse(readFileSync(this.filePath, 'utf8')))) {
          this.sessions.set(session.sessionId, session)
        }
      }
    }
  }

  begin(request: Pick<AgentRunRequest, 'conversation' | 'prompt' | 'cwd'> & Partial<Pick<AgentRunRequest, 'persistence'>>): string {
    const conversation = request.conversation ?? { kind: 'start' }
    const previousId = conversation.kind === 'resume' ? conversation.threadId : conversation.kind === 'fork' ? conversation.sourceThreadId : undefined
    const previous = previousId ? this.sessions.get(previousId) : undefined
    if (previousId && !previous) throw new Error(`Unknown mock session: ${previousId}`)
    const sessionId = previous && conversation.kind === 'resume' ? previous.sessionId : `mock-${this.provider}-${randomUUID()}`
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { sessionId, cwd: request.cwd, persistent: request.persistence !== 'ephemeral', messages: previous ? structuredClone(previous.messages) : [] }
      this.sessions.set(sessionId, session)
    }
    session.messages.push({ role: 'user', content: request.prompt, timestamp: Date.now() })
    this.save()
    return sessionId
  }

  append(sessionId: string, content: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown mock session: ${sessionId}`)
    session.messages.push({ role: 'assistant', content, timestamp: Date.now() })
    this.save()
  }

  load(sessionId: string, limit?: number): SessionLoadMessage[] {
    const session = this.sessions.get(sessionId)
    const messages = session?.persistent ? session.messages : []
    return structuredClone(limit === undefined ? messages : messages.slice(-limit))
  }

  list(projectPath: string): SessionMeta[] {
    return [...this.sessions.values()].filter((session) => session.persistent && (!projectPath || session.cwd === projectPath)).map((session) => ({
      provider: this.provider,
      sessionId: session.sessionId,
      slug: null,
      firstMessage: session.messages[0]?.content ?? null,
      lastTimestamp: new Date(session.messages.at(-1)?.timestamp ?? 0).toISOString(),
      size: session.messages.length,
      cwd: session.cwd,
      projectPath: session.cwd,
      model: 'mock-model',
    }))
  }

  private save(): void {
    if (!this.filePath) return
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, JSON.stringify([...this.sessions.values()].filter((session) => session.persistent)))
    renameSync(temporary, this.filePath)
  }
}
