import { describe, expect, test } from 'bun:test'
import type { Logger } from '@solus/server/logger'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { runGithubRequest } from '@solus/server/providers/github/request'

interface RecordedEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  data?: object
}

class RecordingLogger implements Logger {
  readonly entries: RecordedEntry[] = []

  debug<Data extends object>(message: string, data?: Data): void {
    this.entries.push({ level: 'debug', message, data })
  }

  info<Data extends object>(message: string, data?: Data): void {
    this.entries.push({ level: 'info', message, data })
  }

  warn<Data extends object>(message: string, data?: Data): void {
    this.entries.push({ level: 'warn', message, data })
  }

  error<Data extends object>(message: string, data?: Data): void {
    this.entries.push({ level: 'error', message, data })
  }

  child(): Logger {
    return this
  }
}

function client(source: 'host' | 'gh-cli'): GitHubClient {
  return { credential: { source, token: `${source}-token` } } as unknown as GitHubClient
}

describe('GitHub request logging', () => {
  test('records each credential attempt and the fallback between them', async () => {
    const logger = new RecordingLogger()
    const answer = await runGithubRequest(
      'list_pull_request_checks',
      'github.com',
      [client('host'), client('gh-cli')],
      async ({ credential }) => {
        if (credential.source === 'host') {
          throw Object.assign(new Error('Forbidden'), { status: 403 })
        }
        return 'ok'
      },
      logger,
    )

    expect(answer).toBe('ok')
    expect(logger.entries.map(({ message }) => message)).toEqual([
      'github_request_attempt_started',
      'github_credential_rejected',
      'github_credential_fallback_started',
      'github_request_attempt_started',
    ])
    expect(logger.entries[2]?.data).toEqual({
      operation: 'list_pull_request_checks',
      host: 'github.com',
      failedSource: 'host',
      nextSource: 'gh-cli',
    })
  })

  test('records a terminal failure after every credential is rejected', async () => {
    const logger = new RecordingLogger()

    await expect(runGithubRequest(
      'list_pull_request_checks',
      'github.com',
      [client('host'), client('gh-cli')],
      async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }) },
      logger,
    )).rejects.toThrow('Forbidden')

    expect(logger.entries.at(-1)).toEqual({
      level: 'error',
      message: 'github_request_failed',
      data: {
        operation: 'list_pull_request_checks',
        host: 'github.com',
        source: 'gh-cli',
        attemptedSources: ['host', 'gh-cli'],
        reason: 'credentials_rejected',
        error: 'Forbidden',
      },
    })
  })

  test('records a terminal operation failure without attempting a fallback', async () => {
    const logger = new RecordingLogger()

    await expect(runGithubRequest(
      'create_pull_request',
      'github.com',
      [client('host'), client('gh-cli')],
      async () => { throw Object.assign(new Error('Validation Failed'), { status: 422 }) },
      logger,
    )).rejects.toThrow('Validation Failed')

    expect(logger.entries.map(({ message }) => message)).toEqual([
      'github_request_attempt_started',
      'github_request_failed',
    ])
  })
})
