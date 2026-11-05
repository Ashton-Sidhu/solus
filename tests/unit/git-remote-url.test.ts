import { describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { parseRemoteUrl } = await import('@solus/server/git/git-helpers')

describe('parseRemoteUrl', () => {
  // WHY: git reads `host:path` as SSH and takes the user from ssh config, so
  // this is a working remote whose repository must reach its code host.
  test('a remote that leaves its user to ssh config names its host', () => {
    const repository = { host: 'github.com', owner: 'Acme', repo: 'Web' }
    expect(parseRemoteUrl('github.com:Acme/Web.git')).toEqual(repository)
    expect(parseRemoteUrl('git@github.com:Acme/Web.git')).toEqual(repository)
    expect(parseRemoteUrl('https://github.com/Acme/Web.git')).toEqual(repository)
  })

  test.each([
    'C:/repos/project',
    'C:\\repos\\project',
    '/srv/git/repo.git',
    './team:group/repo',
    '..\\team:group/repo',
    'file:///srv/git/repo.git',
    'hg::team/repo',
    'codecommit::us-east-1://repo',
  ])('%s is not read as a host', (remote) => {
    expect(parseRemoteUrl(remote)).toBeNull()
  })
})
