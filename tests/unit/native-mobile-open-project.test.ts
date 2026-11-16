import { describe, expect, test } from 'bun:test'
import type { DirectoryEntry, SetupGithubRepo } from '@solus/contracts/types'
import { cloneDestinationPath, openExistingProjectFolder, cloneUrlFromInput, folderEntries, folderNameOf, matchingRepos, newProjectLocationText } from '../../apps/mobile/src/features/projects/lib/open-project'

// Project names stay readable, and an explicit folder path is resolved by
// its host. These rules keep the selected project clear: the line under the name says where the folder goes
// with the host path, the folder named is the one the host creates, a short GitHub name
// clones the repository it names, and a file never offers itself as a project.

describe('new project location line', () => {
  test('before typing, it names the projects folder and the host', () => {
    expect(newProjectLocationText('', '/Users/ana/projects', 'Studio Mac')).toBe('Goes in /Users/ana/projects on Studio Mac')
    expect(newProjectLocationText('   ', '/Users/ana/projects', 'Studio Mac')).toBe('Goes in /Users/ana/projects on Studio Mac')
  })

  test('after typing, it names the folder the host will create, not what was typed', () => {
    expect(newProjectLocationText('My Website', '/Users/ana/projects', 'Studio Mac')).toBe('Creates /Users/ana/projects/My-Website on Studio Mac')
    expect(newProjectLocationText(' Notes / 2026 ', 'C:\\code', 'Box')).toBe('Creates C:\\code\\Notes-2026 on Box')
  })

  test('the projects folder reads as its last segment, never a full path', () => {
    expect(folderNameOf('/Users/ana/projects')).toBe('projects')
    expect(folderNameOf('/Users/ana/projects/')).toBe('projects')
    expect(folderNameOf('~/code')).toBe('code')
    expect(folderNameOf('~')).toBe('your home folder')
    expect(folderNameOf('C:\\Users\\ana\\projects')).toBe('projects')
  })
})

describe('clone from a URL', () => {
  test('browsing a destination preserves the repository folder name for POSIX and Windows hosts', () => {
    expect(cloneDestinationPath('~/projects', 'https://github.com/me/my-app.git')).toBe('~/projects/my-app')
    expect(cloneDestinationPath('/other/folder', 'git@github.com:me/my-app.git')).toBe('/other/folder/my-app')
    expect(cloneDestinationPath('C:\\code', 'https://gitlab.com/team/my-app.git')).toBe('C:\\code\\my-app')
  })
  test('owner/repo means a GitHub repository', () => {
    expect(cloneUrlFromInput('solus-sh/solus')).toBe('https://github.com/solus-sh/solus.git')
    expect(cloneUrlFromInput(' solus-sh/solus.git ')).toBe('https://github.com/solus-sh/solus.git')
  })

  test('a full address goes to the host as typed, trimmed', () => {
    expect(cloneUrlFromInput('  https://gitlab.com/a/b  ')).toBe('https://gitlab.com/a/b')
    expect(cloneUrlFromInput('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
  })

  test('nothing typed is nothing to clone, and a relative path is not owner/repo', () => {
    expect(cloneUrlFromInput('   ')).toBeNull()
    expect(cloneUrlFromInput('../repo')).toBe('../repo')
  })
})

describe('folder list', () => {
  test('only folders can be opened as a project', () => {
    const entries: DirectoryEntry[] = [
      { name: 'site', isDir: true, path: '/p/site', branch: 'main' },
      { name: 'notes.txt', isDir: false, path: '/p/notes.txt' },
      { name: 'app', isDir: true, path: '/p/app' },
    ]
    expect(folderEntries(entries).map((entry) => entry.name)).toEqual(['site', 'app'])
  })
})

describe('repository search', () => {
  const repo = (fullName: string): SetupGithubRepo => ({ name: fullName.split('/')[1]!, fullName, private: false, cloneUrl: `https://github.com/${fullName}.git`, updatedAt: '' })
  const repos = [repo('ana/website'), repo('ana/Notes'), repo('team/site')]

  test('matches the owner or name, ignoring case; an empty search shows everything', () => {
    expect(matchingRepos(repos, 'notes').map((r) => r.fullName)).toEqual(['ana/Notes'])
    expect(matchingRepos(repos, 'ANA').map((r) => r.fullName)).toEqual(['ana/website', 'ana/Notes'])
    expect(matchingRepos(repos, '  ')).toEqual(repos)
  })
})


describe('opening the selected host folder', () => {
  test('uses the host-resolved path for both the project and recent history', async () => {
    const reads: string[] = []
    const recent: string[] = []
    const path = await openExistingProjectFolder({
      listDirectory: async (input) => {
        reads.push(input)
        return { entries: [], parentPath: '/Users/ana', currentPath: '/Users/ana/project', error: null }
      },
      trackRecentProject: async (input) => { recent.push(input) },
    }, '  ~/project  ')
    expect(reads).toEqual(['~/project'])
    expect(path).toBe('/Users/ana/project')
    expect(recent).toEqual(['/Users/ana/project'])
  })

  test('does not open or remember a folder the host rejects', async () => {
    const recent: string[] = []
    await expect(openExistingProjectFolder({
      listDirectory: async () => ({ entries: [], parentPath: null, currentPath: '', error: 'Folder does not exist' }),
      trackRecentProject: async (path) => { recent.push(path) },
    }, '~/missing')).rejects.toThrow('Folder does not exist')
    expect(recent).toEqual([])
  })

  test('a recent-history write failure does not block a valid project', async () => {
    await expect(openExistingProjectFolder({
      listDirectory: async () => ({ entries: [], parentPath: null, currentPath: 'C:\\code', error: null }),
      trackRecentProject: async () => { throw new Error('History unavailable') },
    }, 'C:\\code')).resolves.toBe('C:\\code')
  })
})
