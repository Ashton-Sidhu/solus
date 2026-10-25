import { describe, expect, test } from 'bun:test'
import { localProjectParts, projectKeyLabel } from '../../packages/client-core/src/project-identity'
import { shortWorktreePath } from '../../apps/mobile/src/features/conversation/lib/worktree-offer'
import { resolveMarkdownRelativePath } from '../../apps/mobile/src/features/files/lib/file-preview-kind'

describe('Windows host paths on the phone and the client core', () => {
  test('a local project key on a Windows host names its host, folder, and label', () => {
    // WHY: a folder on a Windows host is a project of its own; without the split its row shows the raw key.
    expect(localProjectParts('srv:C:\\code\\scratch')).toEqual({ serverId: 'srv', path: 'C:\\code\\scratch' })
    expect(projectKeyLabel('srv:C:\\code\\scratch')).toBe('scratch')
    expect(localProjectParts('srv:\\\\nas\\share\\repo')).toEqual({ serverId: 'srv', path: '\\\\nas\\share\\repo' })
    expect(localProjectParts('srv:/code/scratch')).toEqual({ serverId: 'srv', path: '/code/scratch' })
    expect(localProjectParts('github.com/acme/app')).toBeNull()
  })

  test('a Windows worktree path shortens to its last two folders in its own separator', () => {
    // WHY: the worktree card names the worktree by its folders, not by the whole Windows path.
    expect(shortWorktreePath('C:\\code\\repo\\.worktrees\\fix-login')).toBe('…\\.worktrees\\fix-login')
    expect(shortWorktreePath('/Users/me/repo/.worktrees/fix-login')).toBe('…/.worktrees/fix-login')
  })

  test('a Markdown link resolves next to a file on a Windows host', () => {
    // WHY: an image in a README on a Windows host must ask the host for a path it can open.
    expect(resolveMarkdownRelativePath('C:\\code\\repo\\docs\\README.md', '../img/a.png')).toBe('C:\\code\\repo\\img\\a.png')
    expect(resolveMarkdownRelativePath('C:\\code\\repo\\README.md', 'C:\\shared\\b.png')).toBe('C:\\shared\\b.png')
    expect(resolveMarkdownRelativePath('/repo/docs/README.md', './c.png')).toBe('/repo/docs/c.png')
  })
})
