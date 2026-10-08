import {
  saveCachedStart,
  savePersistedTabs,
} from '@solus/workspace-ui/contexts/workspace/tab-persistence'
import { DEVICE_LAYOUT_KEY } from '@solus/workspace-ui/contexts/app/device-settings.store.svelte'
import { ANONYMOUS_PROFILE, personalProfileStorageKey } from '@solus/workspace-ui/contexts/app/personal-settings.store.svelte'
import { DEMO_INSTALLATION_ID, type DemoFixtures } from './fixtures/types'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'

/** The state every visitor arrives in: a light theme, no first-run onboarding,
 *  and the project panel open on the sections that describe the work in front
 *  of them. Automations is a catalog, so it starts closed and is opened on purpose. */
const DEMO_PERSONAL_SETTINGS = { themeMode: 'light' }
const DEMO_DEVICE_LAYOUT = {
  onboardingCompleted: true,
  projectPanelCollapsed: { environment: false, git: false, goal: false, linked: false },
}

export function seedDemoStorage(fixtures: DemoFixtures): void {
  const profileKey = personalProfileStorageKey(ANONYMOUS_PROFILE)
  if (localStorage.getItem(profileKey) === null) localStorage.setItem(profileKey, JSON.stringify(DEMO_PERSONAL_SETTINGS))
  if (localStorage.getItem(DEVICE_LAYOUT_KEY) === null) localStorage.setItem(DEVICE_LAYOUT_KEY, JSON.stringify(DEMO_DEVICE_LAYOUT))
  savePersistedTabs(fixtures.persistedTabs)
  saveCachedStart(LOCAL_SERVER_ID, fixtures.startInfo)
  localStorage.removeItem(`solus-tab-drafts:${encodeURIComponent(DEMO_INSTALLATION_ID)}`)
}
