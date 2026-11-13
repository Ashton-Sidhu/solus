import {
  saveCachedStart,
  savePersistedTabs,
} from '@solus/workspace-ui/contexts/workspace/tab-persistence'
import { DEVICE_LAYOUT_KEY } from '@solus/workspace-ui/contexts/app/device-settings.store.svelte'
import { ANONYMOUS_PROFILE, personalProfileStorageKey } from '@solus/workspace-ui/contexts/app/personal-settings.store.svelte'
import { DEMO_INSTALLATION_ID, type DemoFixtures } from './fixtures/types'
import { personalSettingsDocumentSchema, type PersonalSettings } from '@solus/contracts/settings'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'

/** The state every visitor arrives in: a light theme, no first-run onboarding,
 *  and the project panel open on the sections that describe the work in front
 *  of them. Automations is a catalog, so it starts closed and is opened on purpose. */
const DEMO_PERSONAL_SETTINGS = { themeMode: 'light' }

/** The task sources are a personal setting (docs/tasks.md): the demo's are the
 *  two sources its fixture read, a GitHub Project and a Jira board. */
export function demoTaskSettings(fixtures: DemoFixtures): Pick<PersonalSettings, 'taskSources'> {
  return { taskSources: fixtures.tasks.sources.map(({ source }) => source) }
}
const DEMO_DEVICE_LAYOUT = {
  onboardingCompleted: true,
  projectPanelCollapsed: { environment: false, git: false, goal: false, linked: false },
}

export function seedDemoStorage(fixtures: DemoFixtures): void {
  const profileKey = personalProfileStorageKey(ANONYMOUS_PROFILE)
  const stored = localStorage.getItem(profileKey)
  if (stored === null) {
    localStorage.setItem(profileKey, JSON.stringify({ ...DEMO_PERSONAL_SETTINGS, ...demoTaskSettings(fixtures) }))
  } else {
    // A visitor from before the sources were a personal setting keeps the
    // rest of their settings and gets the demo's sources.
    const profile = personalSettingsDocumentSchema.safeParse(parsedJson(stored))
    if (profile.success && profile.data.taskSources === undefined) {
      localStorage.setItem(profileKey, JSON.stringify({ ...profile.data, ...demoTaskSettings(fixtures) }))
    }
  }
  if (localStorage.getItem(DEVICE_LAYOUT_KEY) === null) localStorage.setItem(DEVICE_LAYOUT_KEY, JSON.stringify(DEMO_DEVICE_LAYOUT))
  savePersistedTabs(fixtures.persistedTabs)
  saveCachedStart(LOCAL_SERVER_ID, fixtures.startInfo)
  localStorage.removeItem(`solus-tab-drafts:${encodeURIComponent(DEMO_INSTALLATION_ID)}`)
}

/** A stored value as JSON, or null when it is not JSON. */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
