import { describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import type { PullRequestAuthoringContext } from '@solus/server/git/pull-request-authoring'

// The host's git probe asks `xcode-select`, which a sandbox can refuse. These
// tests make their own repositories with the git on PATH.
const gitAvailability = await import('@solus/server/git/git-availability')
mock.module('@solus/server/git/git-availability', () => ({ ...gitAvailability, isGitUsable: () => true }))
const {
  buildPullRequestAuthoringPrompt,
  fallbackPullRequestDraft,
  readHouseBodyRules,
  readPullRequestAuthoringContext,
} = await import('@solus/server/git/pull-request-authoring')

actAsHostForTests()

function context(overrides: Partial<PullRequestAuthoringContext> = {}): PullRequestAuthoringContext {
  return {
    baseBranch: 'main',
    headBranch: 'feature/pr-authoring',
    commitSummary: 'feat(git): author pull requests from the complete branch',
    diffStat: 'src/main/git.ts | 20 ++++++++++++++++++++',
    diffPatch: 'diff --git a/src/main/git.ts b/src/main/git.ts',
    template: null,
    ...overrides,
  }
}

describe('pull request authoring', () => {
  // The git action and an agent that opens a pull request itself read one copy
  // of the rules: the bundled writing-pr skill.
  test('gives the writer complete branch context and the house body rules from the writing-pr skill', async () => {
    const prompt = buildPullRequestAuthoringPrompt(
      context(),
      await readHouseBodyRules(),
      'Use Conventional Commits for the title.',
    )

    expect(prompt).toContain('Base branch: main')
    expect(prompt).toContain('Head branch: feature/pr-authoring')
    expect(prompt).toContain('feat(git): author pull requests from the complete branch')
    expect(prompt).toContain('src/main/git.ts | 20 ++++++++++++++++++++')
    expect(prompt).toContain('Use Conventional Commits for the title.')
    // The body is a demonstration, not a report on the author's own work.
    expect(prompt).toContain('dont include that you ran tests')
    expect(prompt).toContain('mermaid codeblock diagrams')
    expect(prompt).toContain('baseline from target branch, candidate from the PR')
    expect(prompt).toContain('only the final aggregate squash merge commit')
    expect(prompt).toContain('feel free to use code refs')
    expect(prompt).not.toContain('## Testing')
  })

  test('asks a repository template for a testing section, and never invents one', async () => {
    const withTemplate = buildPullRequestAuthoringPrompt(context({ template: '## Verification' }), await readHouseBodyRules())
    expect(withTemplate).toContain('only because the template asks for one')
    expect(withTemplate).not.toContain('mermaid codeblock diagrams')
  })

  test('the fallback body reports the change without a testing section', () => {
    const draft = fallbackPullRequestDraft(context())

    expect(draft.body).toContain('## Summary')
    expect(draft.body).toContain('- src/main/git.ts | 20 ++++++++++++++++++++')
    expect(draft.body).not.toContain('Testing')
    expect(draft.body).not.toContain('Not run')
  })

  test('preserves the repository template and removes its comments in the fallback', () => {
    const template = [
      '## What changed',
      '<!-- Explain the change. -->',
      '',
      '## Verification',
      '- Not run',
    ].join('\n')
    const draft = fallbackPullRequestDraft(context({ template }))

    expect(draft.title).toBe('feat(git): author pull requests from the complete branch')
    expect(draft.body).toContain('## What changed')
    expect(draft.body).toContain('## Verification')
    expect(draft.body).not.toContain('<!--')
  })

  // GitHub accepts a template in any letter case and as text, so the draft
  // must follow every template GitHub itself would show.
  // WHY: with log.showSignature=true git prints the verification text in the
  // log, and the writers read each stdout line as a commit subject.
  test('a signed commit gives its subject, not its verification text', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pr-signature-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
    const signer = join(cwd, '.fake-signer')
    writeFileSync(signer, [
      '#!/bin/sh',
      'case "$*" in',
      '  *--verify*) echo "No signature" >&2 ;;',
      '  *) echo "[GNUPG:] SIG_CREATED D 1 8 00 1 F" >&2',
      '     printf -- "-----BEGIN PGP SIGNATURE-----\\n\\nfake\\n-----END PGP SIGNATURE-----\\n" ;;',
      'esac',
    ].join('\n'))
    chmodSync(signer, 0o755)
    try {
      git('init', '-q', '-b', 'main')
      git('config', 'user.name', 't')
      git('config', 'user.email', 't@t')
      git('config', 'gpg.program', signer)
      git('commit', '-q', '--allow-empty', '-m', 'base')
      git('checkout', '-qb', 'feature')
      git('commit', '-q', '--allow-empty', '-S', '-m', 'fix(git): a signed change')
      git('config', 'log.showSignature', 'true')

      expect((await readPullRequestAuthoringContext(cwd, 'main', 'feature')).commitSummary).toBe('fix(git): a signed change')
      const { resolveSourceControlWritingPolicy } = await import('@solus/server/git/source-control-writing')
      const policy = await resolveSourceControlWritingPolicy(cwd, { mode: 'repo_conventions', customInstructions: '', followPullRequestTemplate: false })
      expect(policy.commitInstructions).toContain('fix(git): a signed change')
      expect(policy.commitInstructions).not.toContain('No signature')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  describe('repository template', () => {
    function repoWith(files: Record<string, string>): string {
      const cwd = mkdtempSync(join(tmpdir(), 'pr-template-'))
      const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
      git('init', '-q', '-b', 'main')
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(cwd, dirname(path)), { recursive: true })
        writeFileSync(join(cwd, path), content)
      }
      git('add', '-A')
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
      git('checkout', '-qb', 'feature')
      return cwd
    }

    async function templateIn(files: Record<string, string>): Promise<string | null> {
      const cwd = repoWith({ 'README.md': 'project', ...files })
      try {
        return (await readPullRequestAuthoringContext(cwd, 'main', 'feature')).template
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }

    test.each([
      '.github/pull_request_template.txt',
      '.github/Pull_Request_Template.md',
      'docs/PULL_REQUEST_TEMPLATE.TXT',
      'pull_request_template.md',
    ])('reads %s', async (path) => {
      expect(await templateIn({ [path]: '## Summary' })).toBe('## Summary')
    })

    test('keeps the folder priority and prefers Markdown in one folder', async () => {
      expect(await templateIn({
        'PULL_REQUEST_TEMPLATE.md': 'root',
        'docs/pull_request_template.md': 'docs',
        '.github/PULL_REQUEST_TEMPLATE.txt': 'github text',
        '.github/pull_request_template.MD': 'github markdown',
      })).toBe('github markdown')
    })

    test('ignores other files and a repository with no template', async () => {
      expect(await templateIn({ 'docs/pull_request_template.md.bak': 'no', 'docs/guide/pull_request_template.md': 'no' })).toBeNull()
    })
  })
})
