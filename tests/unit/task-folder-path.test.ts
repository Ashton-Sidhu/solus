import { describe, expect, test } from 'bun:test'
import { isChat } from '@solus/contracts/chat'
import { isTaskFolderPath, TASK_FOLDER_ROOT_NAME, taskFolderRootOf } from '@solus/contracts/codebases'
import { encodePathAsFolder, gitCheckoutFromState, isEncodedSolusWorktreeFolder, isSolusWorktreePath, sessionProjectRoot, worktreeProjectRoot } from '@solus/contracts/types'
import { threadProjectPath } from '../../apps/mobile/solus-core/features/threads/threadListV2'

// docs/plans/codebases.md §4 and §7: a task folder is
// `<data folder>/solus-task-folders/<branch slug>-<8 hex>`. Its path has no
// `/.git/solus/worktrees/` in it, so the folder name is the only mark, as for
// a chat. The server and each client ask these two functions.

const root = `/Users/me/.solus/${TASK_FOLDER_ROOT_NAME}/fix-login-1a2b3c4d`

describe('a task folder path', () => {
  test('the task folder itself and each path inside it name the same root', () => {
    expect(taskFolderRootOf(root)).toBe(root)
    expect(taskFolderRootOf(`${root}/`)).toBe(root)
    expect(taskFolderRootOf(`${root}/shop/api/src/index.ts`)).toBe(root)
    expect(isTaskFolderPath(`${root}/shop/api`)).toBe(true)
  })

  test('the folder of a member of an organization is found the same way', () => {
    const memberRoot = `/home/solus/members/alice/${TASK_FOLDER_ROOT_NAME}/add-search-00ff00ff`
    expect(taskFolderRootOf(`${memberRoot}/web`)).toBe(memberRoot)
  })

  test('a Windows path keeps its own spelling', () => {
    const windowsRoot = `C:\\Users\\me\\.solus\\${TASK_FOLDER_ROOT_NAME}\\fix-login-1a2b3c4d`
    expect(taskFolderRootOf(`${windowsRoot}\\shop\\api`)).toBe(windowsRoot)
    expect(taskFolderRootOf(`C:/Users/me/.solus/${TASK_FOLDER_ROOT_NAME}/fix-login-1a2b3c4d/shop`)).toBe(`C:/Users/me/.solus/${TASK_FOLDER_ROOT_NAME}/fix-login-1a2b3c4d`)
  })

  test('the holder folder, and a folder in it with no id, are not task folders', () => {
    expect(taskFolderRootOf(`/Users/me/.solus/${TASK_FOLDER_ROOT_NAME}`)).toBeNull()
    expect(taskFolderRootOf(`/Users/me/.solus/${TASK_FOLDER_ROOT_NAME}/notes`)).toBeNull()
    expect(taskFolderRootOf(`/Users/me/.solus/${TASK_FOLDER_ROOT_NAME}/fix-login-1a2b3c4/api`)).toBeNull()
    expect(taskFolderRootOf(`/Users/me/.solus/${TASK_FOLDER_ROOT_NAME}/fix-login-1A2B3C4D/api`)).toBeNull()
  })

  test('other folders are not task folders', () => {
    for (const path of ['/Users/me/shop', '/Users/me/shop/.git/solus/worktrees/fix-login', `/Users/me/my-${TASK_FOLDER_ROOT_NAME}/fix-login-1a2b3c4d`, '~', '', null, undefined]) {
      expect(isTaskFolderPath(path)).toBe(false)
      expect(taskFolderRootOf(path)).toBeNull()
    }
  })

  test('a task folder is not a chat, and a chat is not a task folder', () => {
    // WHY: both are folders the host makes in its data folder, and each surface names a session by these marks.
    expect(isChat(root)).toBe(false)
    expect(isTaskFolderPath('/Users/me/.solus/solus-chats/abc123')).toBe(false)
  })
})

// A reader of the worktree marker (docs/plans/codebases.md §7, "Paths"): a
// task folder path is a Solus checkout, but it cannot name its repository.
describe('a task folder path and the worktree marker', () => {
  const worktree = `${root}/shop/api`
  const insideRepository = '/Users/me/shop/api/.git/solus/worktrees/fix-login'

  test('both kinds of checkout are a Solus worktree path', () => {
    expect(isSolusWorktreePath(worktree)).toBe(true)
    expect(isSolusWorktreePath(insideRepository)).toBe(true)
    expect(isSolusWorktreePath('/Users/me/shop/api')).toBe(false)
    // A reader of the provider's files has only the encoded folder name.
    expect(isEncodedSolusWorktreeFolder(encodePathAsFolder(worktree))).toBe(true)
    expect(isEncodedSolusWorktreeFolder(encodePathAsFolder(insideRepository))).toBe(true)
    expect(isEncodedSolusWorktreeFolder(encodePathAsFolder('/Users/me/shop/api'))).toBe(false)
  })

  test('the path of a task folder does not name its repository, so the path helper leaves it as it is', () => {
    // WHY: a wrong root is worse than no root. A caller that needs the repository takes it from its data.
    expect(worktreeProjectRoot(insideRepository)).toBe('/Users/me/shop/api')
    expect(worktreeProjectRoot(worktree)).toBe(worktree)
  })

  test('a checkout read from Git names the repository of a worktree in a task folder', () => {
    const identity = { repoRoot: '/Users/me/shop/api', headSha: 'abc', branch: 'solus/fix-login', targetBranch: 'main' }
    expect(gitCheckoutFromState(identity, worktree)).toEqual({ branch: 'solus/fix-login', targetBranch: 'main', repoRoot: '/Users/me/shop/api', worktreePath: worktree })
    // A worktree inside its repository is named by its path, as before, and a caller's own root wins.
    expect(gitCheckoutFromState({ ...identity, repoRoot: '/private/Users/me/shop/api' }, insideRepository)?.repoRoot).toBe('/Users/me/shop/api')
    expect(gitCheckoutFromState(identity, worktree, '/given/root')?.repoRoot).toBe('/given/root')
  })

  test('a session record groups a task folder session under its project', () => {
    // WHY: the sidebar and the session list group a session by its project folder. The host writes `projectRoot`.
    expect(sessionProjectRoot({ cwd: worktree, projectRoot: '/Users/me/shop' })).toBe('/Users/me/shop')
    expect(sessionProjectRoot({ cwd: insideRepository, projectRoot: null })).toBe('/Users/me/shop/api')
    expect(sessionProjectRoot({ cwd: '/Users/me/shop/api' })).toBe('/Users/me/shop/api')
    // A record from a host that wrote no root keeps its folder: nothing names its project.
    expect(sessionProjectRoot({ cwd: worktree })).toBe(worktree)
    // The mobile thread list reads the same fields.
    expect(threadProjectPath({ projectPath: encodePathAsFolder(worktree), cwd: worktree, projectRoot: '/Users/me/shop' })).toBe('/Users/me/shop')
  })
})
