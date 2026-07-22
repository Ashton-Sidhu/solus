import { mount } from 'svelte'
import App from '../App.svelte'
import '../../../src/renderer/index.css'
import { setConnectionState, subscribe } from '@client-core/connection-state'
import { setTabPersistenceServerInstallationId } from '@renderer/contexts/tab-persistence'
import { router } from '../lib/router.svelte'
import { webState } from '../lib/web-state.svelte'
import { createDemoSolusApi } from './api'
import { demoFixtures } from './fixtures'
import { DEMO_INSTALLATION_ID } from './fixtures/types'
import { registerBootHandlers } from './handlers/boot'
import { registerSessionsHandlers, whenSessionLoaded } from './handlers/sessions'
import { registerPlansHandlers } from './handlers/plans'
import { registerWorksHandlers } from './handlers/works'
import { registerPrHandlers } from './handlers/pr'
import { registerTasksHandlers } from './handlers/tasks'
import { registerAutomationsHandlers } from './handlers/automations'
import { registerDiffHandlers } from './handlers/diff'
import { registerFilesHandlers } from './handlers/files'
import { registerAgentIntercept } from './handlers/agent-intercept'
import { seedDemoStorage } from './seed'
import { DemoBackend } from './server'
import { DemoStore } from './store'
import { armReplay, createReplayEngine } from './replay/engine'
import DemoCtaOverlay from './DemoCtaOverlay.svelte'
import DemoHintsOverlay from './DemoHintsOverlay.svelte'

// The demo is only reachable through the landing-page iframe. A direct visit
// to /demo/ redirects home; append ?standalone to bypass (local dev/testing).
const isEmbedded = window.self !== window.top
const allowStandalone = new URLSearchParams(window.location.search).has('standalone')
if (isEmbedded || allowStandalone) {
  boot()
} else {
  window.location.replace('/')
}

function boot() {
document.documentElement.classList.add('solus-demo')
const fixtures = demoFixtures
const backend = new DemoBackend()
const store = new DemoStore(fixtures)
registerBootHandlers(backend, store)
registerSessionsHandlers(backend, store)
registerPlansHandlers(backend, store)
registerWorksHandlers(backend, store)
registerPrHandlers(backend, store)
registerTasksHandlers(backend, store)
registerAutomationsHandlers(backend, store)
registerDiffHandlers(backend, store)
registerFilesHandlers(backend, store)
registerAgentIntercept(backend, store)
window.solus = createDemoSolusApi(backend)

setTabPersistenceServerInstallationId(DEMO_INSTALLATION_ID)
seedDemoStorage(fixtures)

subscribe(({ status, attempt }) => webState.setConnectionStatus(status, attempt))
setConnectionState({ status: 'connected', attempt: 0 })

webState.setConnectedServer({
  id: 'demo',
  label: 'Solus Demo',
  url: window.location.origin,
  sessionToken: '',
  installationId: DEMO_INSTALLATION_ID,
  lastConnected: Date.now(),
})
router.start()
router.navigateToChat()

mount(App, { target: document.getElementById('root')! })

const overlayEl = document.createElement('div')
document.body.appendChild(overlayEl)
mount(DemoCtaOverlay, { target: overlayEl })

const hintsOverlayEl = document.createElement('div')
document.body.appendChild(hintsOverlayEl)
mount(DemoHintsOverlay, { target: hintsOverlayEl })

// The landing page scales the demo down to desktop-screenshot density. CSS
// zoom re-lays-out the page at the target size — unlike a parent-side
// transform, which rasterizes at layout size and scales bitmaps (blurry text).
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'demo:zoom') return
  const zoom = Number(event.data.zoom)
  if (Number.isFinite(zoom) && zoom > 0) document.documentElement.style.zoom = String(zoom)
})

const replayTabId = fixtures.replayScript[0]?.tabId
const replaySessionId = fixtures.persistedTabs.tabs.find((tab) => tab.tabId === replayTabId)?.agentSessionId
if (!replaySessionId) throw new Error(`[demo] replay tab has no persisted session: ${replayTabId ?? 'missing'}`)

const replay = createReplayEngine(backend, store, {
  hydrated: whenSessionLoaded(replaySessionId),
})
armReplay(replay)
}
