import type { Component } from 'svelte'
import { Rocket, Users } from '@lucide/svelte'
import type { AppSummary } from '@solus/contracts/apps'
import { manageSectionIcon } from '../../lib/app-manage'

/**
 * The empty state of each Manage section (Paper "Empty states · every
 * section"): what will show here and one way to get it. `ManageSectionState`
 * draws it on `PageEmpty`.
 */

/**
 * One way to fill a section. `ask` opens a new chat that asks an agent to add
 * the thing it names to the app; `askChange` opens one that changes the app.
 * The chat is a draft: nothing runs until the person sends it.
 */
export type ManageEmptyAction =
  | { label: string; run: () => void; secondary?: boolean }
  | { label: string; ask: string; secondary?: boolean }
  | { label: string; askChange: true; secondary?: boolean }

export interface ManageEmpty {
  /** Absent when filters hide every row: nothing is missing, so there is no medallion. */
  icon?: Component
  title: string
  /** Plain text. A part in backticks is code: `app.ts`. */
  description: string
  actions?: ManageEmptyAction[]
}

const ASK = 'Ask an agent to add one'

export const OVERVIEW_EMPTY: ManageEmpty = {
  icon: Rocket,
  title: 'Nothing runs yet',
  description: 'Deploy a version to start the app. Its calls, runs, and schedules show here.',
}

/** The title of an Activity log with no call in its range: the range is the reason. */
export function activityEmptyTitle(range: 'hour' | 'day' | 'week' | 'all'): string {
  if (range === 'all') return 'No calls yet'
  return `No calls in the last ${range === 'hour' ? 'hour' : range === 'day' ? '24 hours' : '7 days'}`
}

export const ACTIVITY_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('activity'),
  title: 'No calls in the last 24 hours',
  description: 'Calls and model calls from the UI, agents, schedules, and webhooks show here as they happen.',
}

export const WORKFLOWS_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('workflows'),
  title: 'No workflows',
  description: 'A workflow runs steps that can wait, sleep, and retry. Its runs show here.',
  actions: [{ label: ASK, ask: 'a workflow' }],
}

/**
 * The Runs list of Workflows has three empty states: a filter hides every run,
 * the app's workflows did not run yet, or the app declares none.
 */
export function workflowsEmpty(isFiltered: boolean, declaresWorkflows: boolean, clearFilter: () => void): ManageEmpty {
  if (isFiltered) return { title: 'No runs match', description: 'No run is in this state.', actions: [{ label: 'Clear filter', run: clearFilter, secondary: true }] }
  if (declaresWorkflows) return { icon: WORKFLOWS_EMPTY.icon, title: 'No runs yet', description: 'A run of a workflow shows here when it starts.' }
  return WORKFLOWS_EMPTY
}

export const SESSIONS_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('sessions'),
  title: 'No sessions changed this app',
  description: 'The sessions that build or change the app show here, newest first.',
}

export const SCHEDULES_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('schedules'),
  title: 'No schedules',
  description: 'A schedule runs an operation or a workflow at a time, while the host is on.',
  actions: [{ label: ASK, ask: 'a schedule' }],
}

export const WEBHOOKS_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('webhooks'),
  title: 'No webhook',
  description: 'A webhook gives another service a URL to call the app. Its deliveries show here.',
  actions: [{ label: ASK, ask: 'a webhook' }],
}

export const SIGNALS_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('signals'),
  title: 'No signals',
  description: 'The app emits a signal when something happens. Connect an action to it, such as a message or a session.',
  actions: [{ label: ASK, ask: 'a signal' }],
}

export const OPERATIONS_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('operations'),
  title: 'No operations',
  description: 'Operations are what the app’s UI and agents call. Each one you declare shows here, ready to run.',
  actions: [{ label: ASK, ask: 'an operation' }],
}

export const VERSIONS_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('versions'),
  title: 'No versions yet',
  description: 'A session saves the app’s first version. Each change after it shows here with its diff.',
  actions: [{ label: 'Start a session', askChange: true }],
}

export const DEPLOYMENT_EMPTY: ManageEmpty = {
  icon: Users,
  title: 'Only you can open this app',
  description: 'Share it with people or a team. They open it from their sidebar.',
}

export const SECRETS_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('secrets'),
  title: 'No secrets',
  description: 'The app declares no secrets. Declare one in `app.ts` to keep an API key out of the code.',
  actions: [{ label: ASK, ask: 'a secret', secondary: true }],
}

export const CONFIG_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('config'),
  title: 'No settings',
  description: 'The app declares no config. Fields it declares show here, and you change them without a deploy.',
  actions: [{ label: ASK, ask: 'a config field' }],
}

export const FILES_EMPTY: ManageEmpty = {
  icon: manageSectionIcon('files'),
  title: 'No files',
  description: 'Files you upload and files the app writes show here. Drop files anywhere on this page.',
}

/** The prompt of a new chat that asks an agent to add a thing to the app, so it changes the app with the app tools. */
export function appAddPrompt(app: Pick<AppSummary, 'name' | 'slug'>, thing: string): string {
  return `Add ${thing} to the app ${app.name} (${app.slug}). Change it with checkout_app, save_app, and deploy_app.`
}

/** The prompt of a new chat that changes the app. */
export function appChangePrompt(app: Pick<AppSummary, 'name' | 'slug'>): string {
  return `Change the app ${app.name} (${app.slug}) with checkout_app, save_app, and deploy_app.`
}

/** The description split into text and code: a part in backticks is code. */
export function emptyDescriptionParts(description: string): { text: string; isCode: boolean }[] {
  return description
    .split('`')
    .map((text, index) => ({ text, isCode: index % 2 === 1 }))
    .filter((part) => part.text.length > 0)
}

/** The title of a section whose read failed: the host did not answer, or it answered with an error. */
export function sectionErrorTitle(hostLabel: string, isHostUnreachable: boolean): string {
  return isHostUnreachable ? `${hostLabel} did not answer` : 'This section did not load'
}
