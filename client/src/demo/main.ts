import { mount } from 'svelte'
import App from '../App.svelte'
import '../../../src/renderer/index.css'
import { setConnectionState, subscribe } from '@client-core/connection-state'
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
import { registerInsightsHandlers } from './handlers/insights'
import { registerAgentIntercept } from './handlers/agent-intercept'
import { seedDemoStorage } from './seed'
import { DemoBackend } from './server'
import { DemoStore } from './store'
import { serverConnections } from '@client-core/server-connections'
import { LOCAL_SERVER_ID } from '@client-core/server-registry'
import type { WsTransport } from '@client-core/ws-transport'
import type { DialOutcome } from '@client-core/host-supervisor'
import { armReplay, createReplayEngine } from './replay/engine'
import DemoCtaOverlay from './DemoCtaOverlay.svelte'
import DemoHintsOverlay from './DemoHintsOverlay.svelte'
import type { LocalApi } from '@client-core/host-api'

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
registerInsightsHandlers(backend)
registerAgentIntercept(backend, store)
const demoApi = createDemoSolusApi(backend)
window.solus = demoApi as unknown as LocalApi
// The demo backend runs in this page, so every dial the supervisor asks for
// succeeds immediately. Reporting acceptance is what moves the host out of
// `connecting`; without it the workspace boots into a reconnecting shell.
let reportDialOutcome: ((outcome: DialOutcome) => void) | null = null
const acceptDial = () => reportDialOutcome?.({ kind: 'accepted', recovered: false })
// The demo has exactly one host, and it stands in for the machine the visitor
// is "sitting at". Registering it under `LOCAL_SERVER_ID` is what makes every
// default land on it — a new run config, a restored tab, and a task lookup all
// fall back to that id, and any other name leaves them dialing a host that
// isn't there.
serverConnections.registerPrimary(LOCAL_SERVER_ID, demoApi, {
  events: backend.events,
  destroy: () => {},
  start: acceptDial,
  probe: () => Promise.resolve(),
  reconnectNow: () => {},
  onReset: () => () => {},
  attachDialOutcomeReporter: (report: (outcome: DialOutcome) => void) => {
    reportDialOutcome = report
    // The reporter is attached mid-`registerPrimary`; let it finish wiring the
    // connection before the phase change fans out to its listeners.
    queueMicrotask(acceptDial)
  },
} as unknown as WsTransport, {
  id: LOCAL_SERVER_ID,
  label: 'Solus Demo',
  url: window.location.origin,
  sessionToken: '',
  installationId: DEMO_INSTALLATION_ID,
  local: true,
})

seedDemoStorage(fixtures)

subscribe(({ status, attempt }) => webState.setConnectionStatus(status, attempt))
setConnectionState({ status: 'connected', attempt: 0 })

webState.setConnectedServer({
  id: LOCAL_SERVER_ID,
  label: 'Solus Demo',
  url: window.location.origin,
  sessionToken: '',
  installationId: DEMO_INSTALLATION_ID,
  lastConnected: Date.now(),
})
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

const replaySessionId = fixtures.replayScript[0]?.sessionId
const replayAgentSessionId = fixtures.persistedTabs.tabs.find((tab) => tab.sessionId === replaySessionId)?.agentSessionId
if (!replayAgentSessionId) throw new Error(`[demo] replay session has no persisted transcript: ${replaySessionId ?? 'missing'}`)

const replay = createReplayEngine(backend, store, {
  hydrated: whenSessionLoaded(replayAgentSessionId),
})
armReplay(replay)
}
