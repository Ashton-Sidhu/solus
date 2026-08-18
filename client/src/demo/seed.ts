import {
  saveCachedStart,
  savePersistedTabs,
} from '../../../src/renderer/contexts/workspace/tab-persistence'
import { DEMO_INSTALLATION_ID, type DemoFixtures } from './fixtures/types'

const SETTINGS_KEY = 'solus-settings'

/** The state every visitor arrives in. The project panel opens on the sections
 *  that describe the work in front of them; Automations is a catalog, so it
 *  starts closed and is opened on purpose. */
const DEMO_SETTINGS = {
  themeMode: 'light',
  projectPanelCollapsed: { environment: false, git: false, goal: false, task: false, automations: true },
}

export function seedDemoStorage(fixtures: DemoFixtures): void {
  if (localStorage.getItem(SETTINGS_KEY) === null) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(DEMO_SETTINGS))
  }
  savePersistedTabs(fixtures.persistedTabs)
  saveCachedStart(fixtures.startInfo)
  localStorage.removeItem(`solus-tab-drafts:${encodeURIComponent(DEMO_INSTALLATION_ID)}`)
}
