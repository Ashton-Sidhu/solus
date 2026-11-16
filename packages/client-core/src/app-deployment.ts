import type { AppAccessMode, AppAccessSubject, AppDeploymentView, AppPlatformKind, AppPublishPlace, AppPublishPlaces, AppPublishRequest, AppVisitorRole } from '@solus/contracts/app-deployments'

/**
 * The deployment of one app, as the Deployment section shows it on desktop,
 * web, and mobile (docs/plans/app-deploy.md §9): what each choice is called,
 * how the published copy stands against the app in Solus, and what a change
 * asks of the host. Pure, so the clients say the same and the tests pin it.
 */

/** Where the container of a deployment runs: a platform, and for Docker the host that has the engine. */
export interface DeploymentPlace {
  platform: AppPlatformKind
  /** A connected host of the owner; null for the host of the app. */
  hostId: string | null
}

const HOST_PLACE_PREFIX = 'host:'

/** One place as the value of a choice. */
export function deploymentPlaceValue(place: DeploymentPlace): string {
  return place.hostId === null ? place.platform : `${HOST_PLACE_PREFIX}${place.hostId}`
}

export function deploymentPlaceOf(value: string): DeploymentPlace {
  if (value.startsWith(HOST_PLACE_PREFIX)) return { platform: 'docker', hostId: value.slice(HOST_PLACE_PREFIX.length) }
  return { platform: value === 'solus-cloud' ? 'solus-cloud' : 'docker', hostId: null }
}

/** A host that has not said which places it has: Docker on it, and Solus Cloud. */
export const UNKNOWN_PUBLISH_PLACES: AppPublishPlaces = {
  places: [{ platform: 'docker', host: null, problem: null }, { platform: 'solus-cloud', host: null, problem: null }],
  hasTailscaleKey: true,
  canNamePeople: true,
}

function placeOf(place: AppPublishPlace): DeploymentPlace {
  return { platform: place.platform, hostId: place.host?.id ?? null }
}

function placeLabel(place: AppPublishPlace): string {
  if (place.platform === 'solus-cloud') return 'Solus Cloud'
  return place.host ? `Docker on ${place.host.label}` : 'Docker on the host of the app'
}

/** The places a first publish offers, as the host of the app gave them: Docker on it, Docker on each connected host, and Solus Cloud. */
export function deploymentPlaceOptions(places: readonly AppPublishPlace[]): { value: string; label: string }[] {
  return places.map((place) => ({ value: deploymentPlaceValue(placeOf(place)), label: placeLabel(place) }))
}

/** What the chosen place lacks to run a copy now; null when it is ready or the host did not say. */
export function deploymentPlaceProblem(places: readonly AppPublishPlace[], choice: DeploymentPlace): string | null {
  return places.find((place) => deploymentPlaceValue(placeOf(place)) === deploymentPlaceValue(choice))?.problem ?? null
}

export const DEPLOYMENT_ACCESS_OPTIONS = [
  { value: 'link', label: 'People with the link' },
  { value: 'people', label: 'People you name' },
  { value: 'public', label: 'Everyone' },
] as const satisfies readonly { value: AppAccessMode; label: string }[]

export const DEPLOYMENT_ROLE_OPTIONS = [
  { value: 'editor', label: 'Use the app' },
  { value: 'viewer', label: 'Read only' },
] as const satisfies readonly { value: AppVisitorRole; label: string }[]

/** The place of a deployment, in words: "Docker", "Docker on Studio", "Solus Cloud". */
export function deploymentPlaceLabel(deployment: Pick<AppDeploymentView, 'platform' | 'host'>): string {
  if (deployment.platform === 'solus-cloud') return 'Solus Cloud'
  return deployment.host ? `Docker on ${deployment.host.label}` : 'Docker'
}

export function deploymentAccessText(access: AppAccessMode): string {
  switch (access) {
    case 'link': return 'Only a person who has the link opens the app.'
    case 'people': return 'Only you and the people, teams, and organizations that you name open the app. Each one signs in to Solus.'
    case 'public': return 'Each person who has the address opens the app.'
  }
}

/** The role of a visitor is one for the whole app with a link or in a public app. With named people, each one has their own. */
export function hasOneVisitorRole(access: AppAccessMode): boolean {
  return access !== 'people'
}

export function deploymentRoleText(role: AppVisitorRole): string {
  return role === 'editor' ? 'A visitor reads and changes the data of the copy.' : 'A visitor reads the data of the copy and changes nothing.'
}

/** What a person chooses before the first publish. */
export interface DeploymentChoices extends DeploymentPlace {
  tailscaleAddress: boolean
  access: AppAccessMode
  role: AppVisitorRole
  /** Who opens the app with the access `people`. */
  subjects: AppAccessSubject[]
}

export const DEFAULT_DEPLOYMENT_CHOICES: DeploymentChoices = { platform: 'docker', hostId: null, tailscaleAddress: false, access: 'link', role: 'editor', subjects: [] }

/** A Tailscale address is a switch of a deployment in Docker: Solus Cloud gives each app its own address. */
export function offersTailscaleAddress(platform: AppPlatformKind): boolean {
  return platform === 'docker'
}

/** The first publish of an app, from what the person chose. */
export function firstPublishRequest(appId: string, choices: DeploymentChoices): AppPublishRequest {
  const { hostId, subjects, ...rest } = choices
  const request: AppPublishRequest = { appId, ...rest, tailscaleAddress: offersTailscaleAddress(choices.platform) && choices.tailscaleAddress }
  if (hostId !== null) request.hostId = hostId
  // A list goes only with the access that uses it.
  if (choices.access === 'people') request.subjects = subjects
  return request
}

/** One change of a deployment that is there. `again` changes nothing: it sends the active version and the app's secrets. */
export type DeploymentChange =
  | { kind: 'again' }
  | { kind: 'access'; access: AppAccessMode }
  | { kind: 'role'; role: AppVisitorRole }
  /** The whole list of who opens the app. It sets the access to `people`. */
  | { kind: 'people'; subjects: AppAccessSubject[] }
  | { kind: 'tailscale'; isOn: boolean }
  | { kind: 'new-link' }

/** A publish to a deployment that is there: it keeps what the deployment has, with the one thing the person changed. */
export function publishAgainRequest(
  appId: string,
  deployment: Pick<AppDeploymentView, 'platform' | 'host' | 'tailscaleAddress' | 'access' | 'role'>,
  change: DeploymentChange,
): AppPublishRequest {
  const request: AppPublishRequest = { appId, platform: deployment.platform, tailscaleAddress: deployment.tailscaleAddress, access: deployment.access, role: deployment.role }
  if (deployment.host) request.hostId = deployment.host.id
  switch (change.kind) {
    case 'again': return request
    case 'access': return { ...request, access: change.access }
    case 'role': return { ...request, role: change.role }
    case 'people': return { ...request, access: 'people', subjects: change.subjects }
    case 'tailscale': return { ...request, tailscaleAddress: change.isOn }
    case 'new-link': return { ...request, newLink: true }
  }
}

/** How the published copy is, in the order a person must know it. */
export type DeploymentState = 'running' | 'not-answering' | 'stopped' | 'host-unreachable'

export function deploymentState(deployment: Pick<AppDeploymentView, 'running' | 'status' | 'host'>): DeploymentState {
  // The Solus of the app does not reach the host of the container: it knows nothing of the container now.
  if (deployment.host && !deployment.host.isReachable) return 'host-unreachable'
  if (!deployment.running) return 'stopped'
  return deployment.status ? 'running' : 'not-answering'
}

/** One line on how the copy is. */
export function deploymentStateText(deployment: Pick<AppDeploymentView, 'running' | 'status' | 'version' | 'platform' | 'host'>): string {
  const place = deploymentPlaceLabel(deployment)
  switch (deploymentState(deployment)) {
    case 'host-unreachable': return `The host of the app does not reach ${deployment.host?.label ?? 'the other host'}. The copy can still run there.`
    case 'running': return `Version ${deployment.status?.activeVersion ?? deployment.version} runs in ${place}`
    case 'not-answering': return `The copy in ${place} does not answer`
    case 'stopped': return `The container in ${place} does not run. Publish to start it.`
  }
}

/** The calls of the copy in the last 24 hours, or null when it does not answer. */
export function deploymentCallsText(deployment: Pick<AppDeploymentView, 'status'>): string | null {
  const { status } = deployment
  if (!status) return null
  if (status.calls24h === 0) return 'No calls in 24 h'
  const calls = `${status.calls24h} ${status.calls24h === 1 ? 'call' : 'calls'} in 24 h`
  return status.failed24h > 0 ? `${calls} · ${status.failed24h} failed` : calls
}

/**
 * The version that a publish sends now, when the copy does not have it: a
 * deploy in Solus does not reach the copy. Null when the copy has the active
 * version, or the app has none.
 */
export function versionToPublish(deployment: Pick<AppDeploymentView, 'version'>, activeVersion: number | null): number | null {
  return activeVersion !== null && activeVersion !== deployment.version ? activeVersion : null
}

/** What a person agrees to before a change. */
export interface DeploymentQuestion {
  title: string
  detail: string
  /** The word on the control that agrees. */
  confirm: string
}

/**
 * The question before one change, or null for a change that needs none.
 * Each change is a publish, and a publish sends the active version: the
 * question says so when the copy is behind.
 */
export function deploymentChangeQuestion(change: DeploymentChange, deployment: Pick<AppDeploymentView, 'version'>, activeVersion: number | null): DeploymentQuestion | null {
  const version = versionToPublish(deployment, activeVersion)
  const also = version === null ? '' : ` This also publishes version ${version}.`
  switch (change.kind) {
    case 'again': return null
    case 'access':
      if (change.access === 'public') return { title: 'Make the app public?', detail: `Each person who has the address opens the app, with no link.${also}`, confirm: 'Make public' }
      if (change.access === 'people') return { title: 'Open the app only to people you name?', detail: `Each visitor signs in to Solus. A visitor who came in with the link is out.${also}`, confirm: 'Change' }
      return version === null ? null : { title: 'Make the app private?', detail: `Only a person who has the link opens the app.${also}`, confirm: 'Make private' }
    case 'people':
      return version === null ? null : { title: 'Change who opens the app?', detail: `Only you and the ones you name open the app.${also}`, confirm: 'Change' }
    case 'role':
      return version === null ? null : { title: 'Change what a visitor does?', detail: `${deploymentRoleText(change.role)}${also}`, confirm: 'Change' }
    case 'tailscale':
      return {
        title: change.isOn ? 'Turn on the Tailscale address?' : 'Turn off the Tailscale address?',
        detail: `The container starts again${change.isOn ? ', and the app gets an address on your tailnet' : ', and the address on your tailnet stops'}. The data stays.${also}`,
        confirm: change.isOn ? 'Turn on' : 'Turn off',
      }
    case 'new-link':
      return { title: 'Make a new link?', detail: `The old link stops, and each visitor who came in with it is out.${also}`, confirm: 'New link' }
  }
}

export const UNPUBLISH_QUESTION: DeploymentQuestion = {
  title: 'Unpublish the app?',
  detail: 'The copy and the data it holds are removed. The app in Solus does not change. This cannot be undone.',
  confirm: 'Unpublish',
}

/** What the person must know when a publish answered but the version did not start in the copy. */
export function publishRefusalText(receipt: { active: boolean; error: string | null; deployment: Pick<AppDeploymentView, 'version'> }): string | null {
  if (receipt.active) return null
  return `The new version did not start in the copy: ${receipt.error ?? 'no reason given'}. Version ${receipt.deployment.version} still runs there.`
}

/** True for an address that only the host of the app opens: a loopback port of that host. */
export function isHostOnlyAddress(address: string | null): boolean {
  if (!address) return false
  try {
    const { hostname } = new URL(address)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/** The address without its scheme, as a person reads it. */
export function deploymentAddressText(address: string): string {
  return address.replace(/^https?:\/\//, '')
}

/** What the person must know of the address, or null. */
export function deploymentAddressNote(deployment: Pick<AppDeploymentView, 'address' | 'host'>): string | null {
  if (!isHostOnlyAddress(deployment.address)) return null
  return `This address opens only on ${deployment.host?.label ?? 'the host of the app'}. Turn on the Tailscale address to open the app from your other devices.`
}

// ─── Named people (docs/plans/app-deploy.md §7.3) ───

/** The people and teams of the owner's organization, as a list of who opens the app names them. */
export interface SubjectDirectory {
  organization: { id: string; name: string }
  teams: readonly { id: string; name: string; memberCount: number }[]
  /** `id` is the person's user key. */
  members: readonly { id: string; name: string; email?: string }[]
}

type Subject = AppAccessSubject['subject']

function sameSubject(a: Subject, b: Subject): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** One row of the list: who it is, and a line that tells a team from an organization and a person. */
export interface SubjectRow {
  subject: Subject
  name: string
  detail: string
  role: AppVisitorRole
}

function describeSubject(subject: Subject, directory: SubjectDirectory | null): { name: string; detail: string } {
  if (subject.kind === 'organization') {
    return subject.id === directory?.organization.id ? { name: directory.organization.name, detail: 'Organization' } : { name: 'Another organization', detail: 'Organization' }
  }
  if (subject.kind === 'team') {
    const team = directory?.teams.find((candidate) => candidate.id === subject.id)
    return team ? { name: team.name, detail: `Team · ${team.memberCount} ${team.memberCount === 1 ? 'person' : 'people'}` } : { name: 'A team', detail: 'Team' }
  }
  const member = directory?.members.find((candidate) => candidate.id === subject.id)
  // A person the list names and the organization no longer lists.
  return member ? { name: member.name, detail: member.email ?? '' } : { name: 'Former member', detail: '' }
}

/** The list as rows: the organization, then the teams, then the people, each group in the order of its names. */
export function subjectRows(subjects: readonly AppAccessSubject[], directory: SubjectDirectory | null): SubjectRow[] {
  const order = { organization: 0, team: 1, user: 2 } as const
  return subjects
    .map(({ subject, role }) => ({ subject, role, ...describeSubject(subject, directory) }))
    .sort((a, b) => order[a.subject.kind] - order[b.subject.kind] || a.name.localeCompare(b.name))
}

/** Who the owner can add: what the directory has and the list does not, without the owner. `query` narrows by name or email. */
export function subjectCandidates(subjects: readonly AppAccessSubject[], directory: SubjectDirectory | null, ownerKey: string | null, query = ''): Omit<SubjectRow, 'role'>[] {
  if (!directory) return []
  const all: Subject[] = [
    { kind: 'organization', id: directory.organization.id },
    ...directory.teams.map((team): Subject => ({ kind: 'team', id: team.id })),
    ...directory.members.filter((member) => member.id !== ownerKey).map((member): Subject => ({ kind: 'user', id: member.id })),
  ]
  const needle = query.trim().toLowerCase()
  return all
    .filter((subject) => !subjects.some((entry) => sameSubject(entry.subject, subject)))
    .map((subject) => ({ subject, ...describeSubject(subject, directory) }))
    .filter((row) => !needle || row.name.toLowerCase().includes(needle) || row.detail.toLowerCase().includes(needle))
}

/** The list with one subject at a role: added when absent. */
export function withSubject(subjects: readonly AppAccessSubject[], subject: Subject, role: AppVisitorRole): AppAccessSubject[] {
  return [...subjects.filter((entry) => !sameSubject(entry.subject, subject)), { subject, role }]
}

export function withoutSubject(subjects: readonly AppAccessSubject[], subject: Subject): AppAccessSubject[] {
  return subjects.filter((entry) => !sameSubject(entry.subject, subject))
}

/** The list in a few words, for a place that cannot show its rows: "2 people · 1 team · the organization". */
export function subjectsSummary(subjects: readonly AppAccessSubject[]): string {
  const count = (kind: Subject['kind']) => subjects.filter((entry) => entry.subject.kind === kind).length
  const parts = [
    count('user') > 0 ? `${count('user')} ${count('user') === 1 ? 'person' : 'people'}` : null,
    count('team') > 0 ? `${count('team')} ${count('team') === 1 ? 'team' : 'teams'}` : null,
    count('organization') > 0 ? (count('organization') === 1 ? 'the organization' : `${count('organization')} organizations`) : null,
  ].filter((part) => part !== null)
  return parts.length > 0 ? parts.join(' · ') : 'Only you'
}

/** True when two lists name the same subjects at the same roles. */
export function sameSubjects(a: readonly AppAccessSubject[], b: readonly AppAccessSubject[]): boolean {
  return a.length === b.length && a.every((entry) => b.some((other) => sameSubject(entry.subject, other.subject) && entry.role === other.role))
}
