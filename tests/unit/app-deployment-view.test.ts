import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DEPLOYMENT_CHOICES,
  deploymentAddressNote,
  deploymentCallsText,
  deploymentChangeQuestion,
  deploymentPlaceOf,
  deploymentPlaceOptions,
  deploymentPlaceProblem,
  deploymentState,
  deploymentStateText,
  firstPublishRequest,
  hasOneVisitorRole,
  publishAgainRequest,
  publishRefusalText,
  sameSubjects,
  subjectCandidates,
  subjectRows,
  subjectsSummary,
  versionToPublish,
  withSubject,
  withoutSubject,
  type SubjectDirectory,
} from '@solus/client-core/app-deployment'
import type { AppAccessSubject, AppDeploymentStatus, AppDeploymentView, AppPublishPlace } from '@solus/contracts/app-deployments'
import { deploymentMark } from '../../packages/workspace-ui/src/components/app/manage/lib/deployment'

/**
 * The Deployment section of the Manage page (docs/plans/app-deploy.md §9),
 * as desktop, web, and mobile show it: the rules are in client-core, so the
 * three clients say the same.
 */

const STATUS: AppDeploymentStatus = { runtime: { release: '0.39.0', protocols: [2, 3, 4] }, activeVersion: 3, calls24h: 12, failed24h: 0, access: 'link' }

function deployment(over: Partial<AppDeploymentView> = {}): AppDeploymentView {
  return {
    platform: 'docker', host: null, tailscaleAddress: false, access: 'link', role: 'editor', subjects: [], webhooks: [],
    address: 'http://127.0.0.1:49152', link: 'http://127.0.0.1:49152/#secret',
    version: 3, publishedAt: 1, createdAt: 1, running: true, status: STATUS, ...over,
  }
}

describe('the deployment of an app, as its owner reads it', () => {
  test('a deploy in Solus does not reach the copy: the section names the version that a publish sends', () => {
    // WHY (decision: a publish is its own act): an owner who deploys version 4 must see that the copy still runs version 3.
    expect(versionToPublish(deployment(), 4)).toBe(4)
    expect(versionToPublish(deployment(), 3)).toBeNull()
    // A rollback in Solus is a version to publish too: the copy has another version.
    expect(versionToPublish(deployment(), 2)).toBe(2)
    expect(versionToPublish(deployment(), null)).toBeNull()
  })

  test('a container that runs but does not answer is not shown as running', () => {
    expect(deploymentState(deployment())).toBe('running')
    expect(deploymentState(deployment({ status: null }))).toBe('not-answering')
    expect(deploymentState(deployment({ running: false, status: null }))).toBe('stopped')
    expect(deploymentMark(deployment({ status: null }))).toBe('warning')
    expect(deploymentStateText(deployment())).toBe('Version 3 runs in Docker')
    expect(deploymentStateText(deployment({ platform: 'solus-cloud', running: false, status: null }))).toBe('The container in Solus Cloud does not run. Publish to start it.')
    expect(deploymentCallsText(deployment({ status: { ...STATUS, failed24h: 2 } }))).toBe('12 calls in 24 h · 2 failed')
    expect(deploymentCallsText(deployment({ status: null }))).toBeNull()
  })

  test('a loopback address opens only on the host, and the section says so', () => {
    // WHY: a web or mobile client is on another device. The address of a Docker deployment with no Tailscale address does not open there.
    expect(deploymentAddressNote(deployment())).toContain('only on the host')
    expect(deploymentAddressNote(deployment({ address: 'https://notes.tail1234.ts.net' }))).toBeNull()
    expect(deploymentAddressNote(deployment({ address: 'https://notes.apps.example' }))).toBeNull()
  })
})

describe('a deployment on a connected host', () => {
  const studio = { id: 'studio', label: 'Studio', isReachable: true }

  test('a first publish offers the host of the app, each connected host, and Solus Cloud, and names the host it chose', () => {
    const places: AppPublishPlace[] = [
      { platform: 'docker', host: null, problem: 'Docker is not running on this host. Start Docker, then publish again.' },
      { platform: 'docker', host: { id: 'studio', label: 'Studio' }, problem: null },
      { platform: 'solus-cloud', host: null, problem: null },
    ]
    const options = deploymentPlaceOptions(places)
    expect(options.map((option) => option.label)).toEqual(['Docker on the host of the app', 'Docker on Studio', 'Solus Cloud'])
    // A place that lacks a thing says so before the publish, and only for the choice it is.
    expect(deploymentPlaceProblem(places, DEFAULT_DEPLOYMENT_CHOICES)).toContain('Docker is not running')
    expect(deploymentPlaceProblem(places, { platform: 'docker', hostId: 'studio' })).toBeNull()
    // Each option gives its place back, so the request names the host.
    expect(options.map((option) => deploymentPlaceOf(option.value))).toEqual([{ platform: 'docker', hostId: null }, { platform: 'docker', hostId: 'studio' }, { platform: 'solus-cloud', hostId: null }])
    expect(firstPublishRequest('app-1', { ...DEFAULT_DEPLOYMENT_CHOICES, hostId: 'studio' }).hostId).toBe('studio')
    expect('hostId' in firstPublishRequest('app-1', DEFAULT_DEPLOYMENT_CHOICES)).toBe(false)
  })

  test('a change keeps the host: a request with no host would be a publish to another place, which the host of the app refuses', () => {
    expect(publishAgainRequest('app-1', deployment({ host: studio }), { kind: 'new-link' }).hostId).toBe('studio')
    expect(deploymentStateText(deployment({ host: studio }))).toBe('Version 3 runs in Docker on Studio')
    expect(deploymentAddressNote(deployment({ host: studio }))).toContain('only on Studio')
  })

  test('a host that the app\'s host does not reach is not shown as a container that stopped', () => {
    // WHY: "does not run, publish to start it" would be false. The container can run on a host that is only out of reach.
    const out = deployment({ host: { ...studio, isReachable: false }, running: false, status: null })
    expect(deploymentState(out)).toBe('host-unreachable')
    expect(deploymentStateText(out)).toContain('does not reach Studio')
    expect(deploymentMark(out)).toBe('warning')
  })
})

describe('the people of a deployment', () => {
  const directory: SubjectDirectory = {
    organization: { id: 'org_acme', name: 'Acme' },
    teams: [{ id: 'team_design', name: 'Design', memberCount: 2 }],
    members: [{ id: 'ada', name: 'Ada', email: 'ada@acme.test' }, { id: 'bob', name: 'Bob', email: 'bob@acme.test' }, { id: 'cy', name: 'Cy' }],
  }
  const subjects: AppAccessSubject[] = [
    { subject: { kind: 'user', id: 'bob' }, role: 'viewer' },
    { subject: { kind: 'team', id: 'team_design' }, role: 'editor' },
  ]

  test('the list reads as the organization, then teams, then people, and a subject the directory no longer has is still a row', () => {
    // WHY: a person who left the organization is still on the list until the owner removes them. A row that vanished could not be removed.
    const rows = subjectRows([...subjects, { subject: { kind: 'organization', id: 'org_acme' }, role: 'viewer' }, { subject: { kind: 'user', id: 'gone' }, role: 'viewer' }], directory)
    expect(rows.map((row) => `${row.name} (${row.detail}) ${row.role}`)).toEqual(['Acme (Organization) viewer', 'Design (Team · 2 people) editor', 'Bob (bob@acme.test) viewer', 'Former member () viewer'])
  })

  test('the owner adds only what the list does not have, and never themselves', () => {
    expect(subjectCandidates(subjects, directory, 'ada').map((row) => row.name)).toEqual(['Acme', 'Cy'])
    expect(subjectCandidates(subjects, directory, 'ada', 'cy').map((row) => row.name)).toEqual(['Cy'])
    // An account in no organization has nobody to name.
    expect(subjectCandidates(subjects, null, 'ada')).toEqual([])
  })

  test('a change of one row keeps each other row, and the list goes to the host only with the access that uses it', () => {
    const changed = withSubject(subjects, { kind: 'user', id: 'bob' }, 'editor')
    expect(changed).toHaveLength(2)
    expect(changed.find((entry) => entry.subject.id === 'bob')?.role).toBe('editor')
    expect(withoutSubject(subjects, { kind: 'team', id: 'team_design' })).toEqual([subjects[0]])
    expect(sameSubjects(subjects, [...subjects].reverse())).toBe(true)
    expect(sameSubjects(subjects, changed)).toBe(false)
    expect(subjectsSummary(subjects)).toBe('1 person · 1 team')
    expect(subjectsSummary([])).toBe('Only you')

    expect(firstPublishRequest('app-1', { ...DEFAULT_DEPLOYMENT_CHOICES, access: 'people', subjects }).subjects).toEqual(subjects)
    // A list that the owner made and then left for a link is not sent: the host would keep it for an access nobody chose.
    expect('subjects' in firstPublishRequest('app-1', { ...DEFAULT_DEPLOYMENT_CHOICES, access: 'link', subjects })).toBe(false)
    expect(publishAgainRequest('app-1', deployment(), { kind: 'people', subjects })).toMatchObject({ access: 'people', subjects })
  })

  test('a change to named people puts a visitor with the link out, so it asks first', () => {
    expect(deploymentChangeQuestion({ kind: 'access', access: 'people' }, deployment(), 3)?.detail).toContain('A visitor who came in with the link is out.')
    // A change of the list of a copy that is not behind needs no question.
    expect(deploymentChangeQuestion({ kind: 'people', subjects }, deployment({ access: 'people' }), 3)).toBeNull()
    expect(deploymentChangeQuestion({ kind: 'people', subjects }, deployment({ access: 'people' }), 4)?.detail).toContain('This also publishes version 4.')
    // With named people, each one has their own role: the role of the whole app is not shown.
    expect(hasOneVisitorRole('people')).toBe(false)
    expect(hasOneVisitorRole('link')).toBe(true)
  })
})

describe('a change of a deployment', () => {
  test('a change keeps what the deployment has, with the one thing the person changed', () => {
    // WHY: each change is a publish with the whole request. A request with a default in place of the
    // current value would make a public app private, or drop its Tailscale address.
    const current = deployment({ platform: 'docker', tailscaleAddress: true, access: 'public', role: 'viewer' })
    const kept = { appId: 'app-1', platform: 'docker', tailscaleAddress: true, access: 'public', role: 'viewer' }
    expect(publishAgainRequest('app-1', current, { kind: 'again' })).toEqual(kept)
    expect(publishAgainRequest('app-1', current, { kind: 'role', role: 'editor' })).toEqual({ ...kept, role: 'editor' })
    expect(publishAgainRequest('app-1', current, { kind: 'access', access: 'link' })).toEqual({ ...kept, access: 'link' })
    expect(publishAgainRequest('app-1', current, { kind: 'tailscale', isOn: false })).toEqual({ ...kept, tailscaleAddress: false })
    expect(publishAgainRequest('app-1', current, { kind: 'new-link' })).toEqual({ ...kept, newLink: true })
  })

  test('a first publish to Solus Cloud never asks for a Tailscale address', () => {
    // WHY: the switch is of a deployment in Docker. Solus Cloud refuses a publish that asks for it.
    const choices = { ...DEFAULT_DEPLOYMENT_CHOICES, tailscaleAddress: true }
    expect(firstPublishRequest('app-1', choices).tailscaleAddress).toBe(true)
    expect(firstPublishRequest('app-1', { ...choices, platform: 'solus-cloud' }).tailscaleAddress).toBe(false)
  })

  test('a change that opens the app, puts a visitor out, or starts the container again asks first', () => {
    expect(deploymentChangeQuestion({ kind: 'access', access: 'public' }, deployment(), 3)?.confirm).toBe('Make public')
    expect(deploymentChangeQuestion({ kind: 'new-link' }, deployment(), 3)?.detail).toContain('each visitor who came in with it is out')
    expect(deploymentChangeQuestion({ kind: 'tailscale', isOn: true }, deployment(), 3)?.detail).toContain('The container starts again')
    // A change that only narrows what a visitor does, with nothing new to send, needs no question.
    expect(deploymentChangeQuestion({ kind: 'access', access: 'link' }, deployment(), 3)).toBeNull()
    expect(deploymentChangeQuestion({ kind: 'role', role: 'viewer' }, deployment(), 3)).toBeNull()
    expect(deploymentChangeQuestion({ kind: 'again' }, deployment(), 4)).toBeNull()
  })

  test('a change of a copy that is behind says that it also publishes the active version', () => {
    // WHY: a publish always sends the active version. An owner who only changes the role must not ship version 4 without a word.
    for (const change of [{ kind: 'role', role: 'viewer' }, { kind: 'access', access: 'link' }, { kind: 'access', access: 'public' }, { kind: 'new-link' }, { kind: 'tailscale', isOn: false }] as const) {
      expect(deploymentChangeQuestion(change, deployment(), 4)?.detail).toContain('This also publishes version 4.')
    }
  })

  test('a version that did not start in the copy is a problem that names the version that still runs', () => {
    expect(publishRefusalText({ active: true, error: null, deployment: deployment() })).toBeNull()
    expect(publishRefusalText({ active: false, error: 'migration 0002 failed', deployment: deployment() }))
      .toBe('The new version did not start in the copy: migration 0002 failed. Version 3 still runs there.')
  })
})

