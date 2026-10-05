import { describe, expect, test } from 'bun:test'
import type { DirectoryEntry, SetupGithubRepo } from '@solus/contracts/types'
import { cloneUrlFromInput, folderEntries, folderNameOf, matchingRepos, newProjectLocationText } from '../../apps/mobile/src/features/projects/lib/open-project'

// "Open project" on the phone is for people who do not think in paths. These
// rules keep it that way: the line under the name says where the folder goes
// in words, the folder named is the one the host creates, a short GitHub name
// clones the repository it names, and a file never offers itself as a project.

describe('new project location line', () => {
  test('before typing, it names the projects folder and the host', () => {
    expect(newProjectLocationText('', 'projects', 'Studio Mac')).toBe('Creates a folder in projects on Studio Mac')
    expect(newProjectLocationText('   ', 'projects', 'Studio Mac')).toBe('Creates a folder in projects on Studio Mac')
  })

  test('after typing, it names the folder the host will create, not what was typed', () => {
    expect(newProjectLocationText('My Website', 'projects', 'Studio Mac')).toBe('Creates the folder My-Website in projects on Studio Mac')
    expect(newProjectLocationText(' Notes / 2026 ', 'code', 'Box')).toBe('Creates the folder Notes-2026 in code on Box')
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
