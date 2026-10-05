import { expect, test } from 'bun:test'
import { configureCloudAccount, cookieCloudAccount } from '@solus/client-core/cloud-account'
import { SvelteRunes } from './helpers/svelte-runes'

test('cloud connections stay correct with no host status, survive an outage, and refresh after disconnect', async () => {
  const runes = new SvelteRunes()
  let connected = true
  let offline = false
  let seatReads = 0
  const source = cookieCloudAccount('https://app.solus.sh', (async (input) => {
    if (String(input).endsWith('/v1/account')) return Response.json({ userId: 'ab', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [] })
    seatReads++
    if (offline) return new Response(null, { status: 503 })
    return Response.json({ seats: [
      { provider: 'claude-code', connected, updatedAt: connected ? '2026-10-02T18:34:43.873Z' : null },
      { provider: 'codex', connected: false, updatedAt: null },
    ] })
  }) as typeof fetch)
  configureCloudAccount(source)
  try {
    const stub = runes.module('host-deps', `
      export const serverConnections = { connectionFor: (id) => ({ target: { uplink: { kind: id === 'cloud' ? 'managed' : 'personal' } } }) };
      export const localApi = { openExternal: async () => {} };
    `)
    const path = runes.source('cloud-seats', 'packages/workspace-ui/src/contexts/seats/cloud-agent-seats.store.svelte.ts', {
      '@solus/client-core/cloud-account': SvelteRunes.file('packages/client-core/src/cloud-account.ts'),
      '@solus/client-core/server-connections': stub,
      '@solus/client-core/local-api': stub,
    })
    // Get started must see the account connection even with no execution host.
    const onboardingDeps = runes.module('onboarding-deps', `
      export { cloudAccount, startupAccountRead } from ${JSON.stringify(SvelteRunes.file('packages/client-core/src/cloud-account.ts'))};
      export { cloudAgentSeatsStore } from ${JSON.stringify(path)};
      export const serverConnections = { apiFor: () => { throw new Error('must not check a host'); } };
      export const uplinkAccountSource = () => null;
      export const serversStore = { servers: [], activeCloudServerId: null };
      export const workspaceProjectsStore = { hasLoaded: () => false };
      export const connectionsStore = {};
      export const computeChoices = () => ({ cloudHost: null, ownMachines: [], sharedMachines: [] });
      export const defaultComputeHost = () => null;
      export const createHostFailureMessage = () => '';
      export const awaitsManagedCompute = () => false;
      export const managedHostNeedsStart = () => false;
      export const ensureRepositoryCheckout = () => { throw new Error('must not reach a host'); };
    `)
    const onboardingPath = runes.source('cloud-onboarding', 'packages/workspace-ui/src/components/onboarding/cloud-onboarding.store.svelte.ts', {
      '@solus/client-core/cloud-account': onboardingDeps,
      '@solus/client-core/server-connections': onboardingDeps,
      '@solus/client-core/uplink-account': onboardingDeps,
      '../../contexts': onboardingDeps,
      './lib/cloud-compute': onboardingDeps,
      '@solus/client-core/server-registry': onboardingDeps,
      '../../contexts/seats/cloud-agent-seats.store.svelte': onboardingDeps,
      '../../contexts/workspace/repository-checkout': onboardingDeps,
      '@solus/contracts/chat': SvelteRunes.file('packages/contracts/src/chat.ts'),
    })
    const { CloudAgentSeatsStore, usesCloudAgentSeats } = await import(path) as typeof import('@solus/workspace-ui/contexts/seats/cloud-agent-seats.store.svelte')
    const store = new CloudAgentSeatsStore()
    expect(store.connected('claude-code')).toBeNull()
    expect(usesCloudAgentSeats('cloud')).toBe(true)
    expect(usesCloudAgentSeats('personal')).toBe(false)
    await Promise.all([store.refresh(), store.refresh()])
    expect(seatReads).toBe(1)
    expect(store.connected('claude-code')).toBe(true)
    expect(store.connected('codex')).toBe(false)

    const { cloudOnboardingStore } = await import(onboardingPath) as typeof import('@solus/workspace-ui/components/onboarding/cloud-onboarding.store.svelte')
    const { cloudAgentSeatsStore } = await import(path) as typeof import('@solus/workspace-ui/contexts/seats/cloud-agent-seats.store.svelte')
    await cloudAgentSeatsStore.refresh()
    expect(cloudOnboardingStore.getStartedFacts.hasMachine).toBe(false)
    expect(cloudOnboardingStore.getStartedFacts.hasSignedInAgent).toBe(true)
    cloudOnboardingStore.reopenAt('agents')
    expect(cloudOnboardingStore.reopenedAt).toBe('agents')
    offline = true
    await store.refresh()
    expect(store.connected('claude-code')).toBe(true)
    expect(store.error).not.toBeNull()
    const unknown = new CloudAgentSeatsStore()
    await unknown.refresh()
    expect(unknown.connected('claude-code')).toBeNull()
    offline = false
    connected = false
    await store.refresh()
    expect(store.connected('claude-code')).toBe(false)
    expect(store.error).toBeNull()
    await cloudAgentSeatsStore.refresh()
    expect(cloudOnboardingStore.getStartedFacts.hasSignedInAgent).toBe(false)
  } finally {
    configureCloudAccount(null)
    runes.dispose()
  }
})
