import {
  saveCachedStart,
  savePersistedTabs,
} from '../../../src/renderer/contexts/tab-persistence'
import { DEMO_INSTALLATION_ID, type DemoFixtures } from './fixtures/types'

const SETTINGS_KEY = 'solus-settings'

export function seedDemoStorage(fixtures: DemoFixtures): void {
  if (localStorage.getItem(SETTINGS_KEY) === null) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ themeMode: 'light' }))
  }
  savePersistedTabs(fixtures.persistedTabs)
  saveCachedStart(fixtures.startInfo)
  localStorage.removeItem(`solus-tab-drafts:${encodeURIComponent(DEMO_INSTALLATION_ID)}`)
}
