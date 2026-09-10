import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test as base, expect, type WebSocketRoute } from '@playwright/test'
import { z } from 'zod'
import { startRun, stopRun, disposeRunProject, mockEnvironment, type RunManifest } from '../../../scripts/qa/runner'
import { connectApp } from '../../../scripts/agent/open-app'
import { attachFailure, observePage } from './evidence'

export { expect } from '@playwright/test'
const root = resolve(__dirname, '../../..')
export type MockProvider = 'claude-code' | 'codex'
type AppState = ReturnType<typeof observePage> & { disconnect(): Promise<void>; connectionCount(): number; sessionIds(): string[] }
type Fixtures = { provider: MockProvider; host: RunManifest; app: AppState }

export const test = base.extend<Fixtures>({
  provider: ['claude-code', { option: true }],
  host: async ({ provider }, use, testInfo) => {
    const run = await startRun(root, { provider })
    try {
      await testInfo.attach('build-identity', { body: JSON.stringify({ runId: run.runId, sourceFingerprint: run.sourceFingerprint, provider }), contentType: 'application/json' })
      await use(run)
    } finally {
      let directoryVerified = false
      try {
        const historyPath = join(run.dataDir, 'mock-history', `${provider}.json`)
        if (existsSync(historyPath)) {
          const history = readFileSync(historyPath, 'utf8')
          await testInfo.attach('mock-history', { body: history, contentType: 'application/json' })
          const sessions = z.array(z.object({ cwd: z.string() })).parse(JSON.parse(history))
          for (const session of sessions) {
            expect(resolve(session.cwd), 'Provider execution must stay in the disposable project').toBe(resolve(run.projectDir))
          }
        }
        directoryVerified = true
      } finally {
        writeFileSync(join(run.directory, 'validation.json'), JSON.stringify({
          test: testInfo.title, project: testInfo.project.name,
          status: directoryVerified ? testInfo.status : 'failed', executionDirectoryVerified: directoryVerified,
          sourceFingerprint: run.sourceFingerprint, generationId: run.generationId, provider, finishedAt: new Date().toISOString(),
        }, null, 2))
        await stopRun(root, run.runId)
        disposeRunProject(root, run.runId)
        // Logs/manifests remain for investigation; credentials/history do not.
        rmSync(run.dataDir, { recursive: true, force: true })
      }
    }
  },
  app: async ({ host, page, context, provider }, use, testInfo) => {
    const result = execFileSync('node', [join(root, 'dist/test/main/standalone.js'), 'auth', 'session', 'create', '--device-label', 'QA', '--json'], {
      cwd: root, env: mockEnvironment(root, host.dataDir, host.logDir), encoding: 'utf8',
    })
    const credential = z.object({ sessionToken: z.string() }).parse(JSON.parse(result))
    const projectPath = host.projectDir
    await context.addInitScript(() => {
      function record(kind: string, detail?: string) {
        const entries: { kind: string; detail?: string; activeTag?: string; at: number }[] = JSON.parse(sessionStorage.getItem('qa-focus-events') ?? '[]')
        entries.push({ kind, detail, activeTag: document.activeElement?.tagName, at: performance.now() })
        sessionStorage.setItem('qa-focus-events', JSON.stringify(entries.slice(-50)))
      }
      window.addEventListener('solus:focus-input', (event) => record('request', JSON.stringify(event instanceof CustomEvent ? event.detail : null)))
      window.addEventListener('focusin', (event) => record('focusin', event.target instanceof Element ? `${event.target.tagName}.${event.target.getAttribute('class')}` : undefined))
      window.addEventListener('focusout', () => record('focusout'))
    })
    const observations = observePage(page)
    const sockets = new Set<WebSocketRoute>()
    let connectionCount = 0
    await page.routeWebSocket('**/*', (socket) => {
      const server = socket.connectToServer()
      connectionCount++
      sockets.add(socket)
      socket.onClose(() => { sockets.delete(socket); server.close() })
    })
    const app: AppState = {
      ...observations,
      connectionCount: () => connectionCount,
      sessionIds: () => {
        const path = join(host.dataDir, 'mock-history', `${provider}.json`)
        if (!existsSync(path)) return []
        return z.array(z.object({ sessionId: z.string() })).parse(JSON.parse(readFileSync(path, 'utf8'))).map((session) => session.sessionId)
      },
      disconnect: async () => {
        for (const socket of sockets) await socket.close({ code: 1012, reason: 'QA reconnect scenario' })
      },
    }
    try {
      await connectApp(context, page, { url: host.url, sessionToken: credential.sessionToken, projectPath, provider })
      await use(app)
    } finally {
      await attachFailure(page, testInfo, observations, host.logDir)
    }
  },
})
