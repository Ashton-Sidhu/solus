import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

/** `runAsync` is mocked per-subprocess — see git-action-manager.test.ts. The
 *  GitHub client is a plain injected parameter, so it needs no module mock. */
function run(script: string): { calls: Array<{ bin: string; args: string[] }>; result: unknown } {
  const wrapped = `
    import { mock } from 'bun:test'
    const calls = []
    ${script}
  `
  const proc = spawnSync(process.execPath, ['-e', wrapped], { cwd: root, encoding: 'utf8' })
  expect(proc.stderr).toBe('')
  expect(proc.status).toBe(0)
  return JSON.parse(proc.stdout)
}

const FAKE_CLIENT = `
  const client = {
    rest: {
      repos: {
        get: async () => { const err = new Error('Not Found'); err.status = 404; throw err },
        createForAuthenticatedUser: async ({ name, private: isPrivate }) => ({
          data: { clone_url: \`https://github.com/acme/\${name}.git\`, full_name: \`acme/\${name}\` },
        }),
        createInOrg: async () => { throw new Error('should not create in org for this test') },
      },
      users: { getAuthenticated: async () => ({ data: { login: 'acme' } }) },
    },
  }
`

describe('publishRepositoryToGithub', () => {
  test('creates the repository, adds the remote, and pushes existing commits', () => {
    const output = run(`
      mock.module('./src/main/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'remote' && args[1] === 'get-url') throw new Error('No such remote')
          if (args[0] === 'remote' && args[1] === 'add') return ''
          if (args[0] === 'symbolic-ref') return 'main'
          if (args[0] === 'rev-parse' && args.includes('--verify')) return 'abc123'
          if (args[0] === 'push') return ''
          return ''
        },
      }))
      ${FAKE_CLIENT}
      const { publishRepositoryToGithub } = await import('./src/main/git/github-publish')
      const result = await publishRepositoryToGithub({
        client, cwd: '/repo', owner: 'acme', name: 'widgets', private: true,
        remoteName: 'origin', protocol: 'https', token: 'gh-token',
      })
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toEqual({
      success: true,
      repository: { status: 'created', url: 'https://github.com/acme/widgets.git', fullName: 'acme/widgets' },
      remote: { status: 'added', name: 'origin', url: 'https://github.com/acme/widgets.git' },
      push: { status: 'pushed', branch: 'main' },
    })
    expect(output.calls.find((c) => c.args[0] === 'remote' && c.args[1] === 'add')?.args).toEqual([
      'remote', 'add', 'origin', 'https://github.com/acme/widgets.git',
    ])
    expect(output.calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push', '-u', 'origin', 'main'])
    // WHY: the remote URL must never carry a credential.
    expect(JSON.stringify(output.calls)).not.toContain('gh-token')
  })

  test('publishes a remote-only checkout when there are no commits yet', () => {
    const output = run(`
      mock.module('./src/main/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'remote' && args[1] === 'get-url') throw new Error('No such remote')
          if (args[0] === 'remote' && args[1] === 'add') return ''
          if (args[0] === 'symbolic-ref') return 'main'
          if (args[0] === 'rev-parse' && args.includes('--verify')) throw new Error('unborn branch')
          return ''
        },
      }))
      ${FAKE_CLIENT}
      const { publishRepositoryToGithub } = await import('./src/main/git/github-publish')
      const result = await publishRepositoryToGithub({
        client, cwd: '/repo', owner: 'acme', name: 'widgets', private: true,
        remoteName: 'origin', protocol: 'https', token: 'gh-token',
      })
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toEqual({
      success: true,
      repository: { status: 'created', url: 'https://github.com/acme/widgets.git', fullName: 'acme/widgets' },
      remote: { status: 'added', name: 'origin', url: 'https://github.com/acme/widgets.git' },
      push: { status: 'skipped_no_commits' },
    })
    expect(output.calls.some((c) => c.args[0] === 'push')).toBe(false)
  })

  test('retries idempotently: reuses a matching existing repository and remote', () => {
    const output = run(`
      mock.module('./src/main/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/acme/widgets.git'
          if (args[0] === 'symbolic-ref') return 'main'
          if (args[0] === 'rev-parse' && args.includes('--verify')) return 'abc123'
          if (args[0] === 'push') return ''
          return ''
        },
      }))
      const client = {
        rest: {
          repos: {
            get: async () => ({ data: { clone_url: 'https://github.com/acme/widgets.git', full_name: 'acme/widgets' } }),
            createForAuthenticatedUser: async () => { throw new Error('should not create — the repository already exists') },
            createInOrg: async () => { throw new Error('should not create — the repository already exists') },
          },
          users: { getAuthenticated: async () => ({ data: { login: 'acme' } }) },
        },
      }
      const { publishRepositoryToGithub } = await import('./src/main/git/github-publish')
      const result = await publishRepositoryToGithub({
        client, cwd: '/repo', owner: 'acme', name: 'widgets', private: true,
        remoteName: 'origin', protocol: 'https', token: 'gh-token',
      })
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toEqual({
      success: true,
      repository: { status: 'found', url: 'https://github.com/acme/widgets.git', fullName: 'acme/widgets' },
      remote: { status: 'existing', name: 'origin', url: 'https://github.com/acme/widgets.git' },
      push: { status: 'pushed', branch: 'main' },
    })
    expect(output.calls.some((c) => c.args[0] === 'remote' && c.args[1] === 'add')).toBe(false)
  })

  test('rejects a remote that already points at a different repository, without overwriting it', () => {
    const output = run(`
      mock.module('./src/main/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/other/existing.git'
          return ''
        },
      }))
      ${FAKE_CLIENT}
      const { publishRepositoryToGithub } = await import('./src/main/git/github-publish')
      const result = await publishRepositoryToGithub({
        client, cwd: '/repo', owner: 'acme', name: 'widgets', private: true,
        remoteName: 'origin', protocol: 'https', token: 'gh-token',
      })
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toMatchObject({
      success: false,
      repository: { status: 'created' },
      remote: { status: 'failed' },
      push: { status: 'skipped' },
    })
    // WHY: a mismatched remote must never be silently overwritten.
    expect(output.calls.some((c) => c.args[0] === 'remote' && c.args[1] === 'add')).toBe(false)
    expect(output.calls.some((c) => c.args[0] === 'push')).toBe(false)
  })

  test('rejects a same-path remote on a different host', () => {
    // WHY: gitlab.com/acme/widgets is not github.com/acme/widgets. Comparing
    // owner/repo alone would silently publish over another host's remote.
    const output = run(`
      mock.module('./src/main/git/exec', () => ({
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'remote' && args[1] === 'get-url') return 'https://gitlab.com/acme/widgets.git'
          return ''
        },
      }))
      ${FAKE_CLIENT}
      const { publishRepositoryToGithub } = await import('./src/main/git/github-publish')
      const result = await publishRepositoryToGithub({
        client, cwd: '/repo', owner: 'acme', name: 'widgets', private: true,
        remoteName: 'origin', protocol: 'https', token: 'gh-token',
      })
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toMatchObject({ success: false, remote: { status: 'failed' } })
    expect(output.calls.some((c) => c.args[0] === 'remote' && c.args[1] === 'add')).toBe(false)
  })

  test('builds an SSH remote from the repository clone URL when SSH is chosen', () => {
    const output = run(`
      mock.module('./src/main/git/exec', () => ({
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'remote' && args[1] === 'get-url') throw new Error('No such remote')
          if (args[0] === 'symbolic-ref') return 'main'
          if (args[0] === 'rev-parse' && args.includes('--verify')) return 'abc123'
          return ''
        },
      }))
      ${FAKE_CLIENT}
      const { publishRepositoryToGithub } = await import('./src/main/git/github-publish')
      const result = await publishRepositoryToGithub({
        client, cwd: '/repo', owner: 'acme', name: 'widgets', private: true,
        remoteName: 'origin', protocol: 'ssh', token: 'gh-token',
      })
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toMatchObject({
      success: true,
      remote: { status: 'added', url: 'git@github.com:acme/widgets.git' },
    })
  })

  test('surfaces a push failure while keeping the created repository URL', () => {
    const output = run(`
      mock.module('./src/main/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'remote' && args[1] === 'get-url') throw new Error('No such remote')
          if (args[0] === 'remote' && args[1] === 'add') return ''
          if (args[0] === 'symbolic-ref') return 'main'
          if (args[0] === 'rev-parse' && args.includes('--verify')) return 'abc123'
          if (args[0] === 'push') throw new Error('remote: Permission denied')
          return ''
        },
      }))
      ${FAKE_CLIENT}
      const { publishRepositoryToGithub } = await import('./src/main/git/github-publish')
      const result = await publishRepositoryToGithub({
        client, cwd: '/repo', owner: 'acme', name: 'widgets', private: true,
        remoteName: 'origin', protocol: 'https', token: 'gh-token',
      })
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toEqual({
      success: false,
      repository: { status: 'created', url: 'https://github.com/acme/widgets.git', fullName: 'acme/widgets' },
      remote: { status: 'added', name: 'origin', url: 'https://github.com/acme/widgets.git' },
      push: { status: 'failed', error: 'remote: Permission denied' },
    })
  })

  test('never deletes anything: repository creation failure leaves nothing to clean up', () => {
    const output = run(`
      mock.module('./src/main/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => { calls.push({ bin, args }); return '' },
      }))
      const client = {
        rest: {
          repos: {
            get: async () => { const err = new Error('Not Found'); err.status = 404; throw err },
            createForAuthenticatedUser: async () => {
              const err = new Error('Repository creation failed.')
              err.status = 403
              throw err
            },
            createInOrg: async () => { throw new Error('should not be called') },
          },
          users: { getAuthenticated: async () => ({ data: { login: 'acme' } }) },
        },
      }
      const { publishRepositoryToGithub } = await import('./src/main/git/github-publish')
      const result = await publishRepositoryToGithub({
        client, cwd: '/repo', owner: 'acme', name: 'widgets', private: true,
        remoteName: 'origin', protocol: 'https', token: 'gh-token',
      })
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result.success).toBe(false)
    expect(output.result.repository.status).toBe('failed')
    expect(output.result.remote).toEqual({ status: 'skipped' })
    expect(output.result.push).toEqual({ status: 'skipped' })
    expect(output.calls.some((c) => c.args[0] === 'remote')).toBe(false)
  })
})
