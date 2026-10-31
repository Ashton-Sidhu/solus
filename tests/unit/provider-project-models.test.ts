import { describe, expect, test } from 'bun:test'
import { newProviderInstance, type ProviderInstancesSnapshot } from '@solus/contracts/provider-instances'
import { agentForProject, changeProjectProviderOverride, instanceModelCatalog, providerProjectOverride } from '@solus/contracts/provider-instance-models'
import { MODEL_PROFILES, SOLUS_WORKTREE_DIR, type AgentMetadata } from '@solus/contracts/types'
import { newSessionModel, selectModel } from '../../apps/mobile/src/features/conversation/lib/run-settings'

function fixture() {
  const base = newProviderInstance('codex', 'codex', 'Codex')
  const work = newProviderInstance('codex', 'work', 'Work')
  work.defaultModel = 'private-model'
  work.enabled = false
  work.customModels.push({ id: 'private-model', label: 'Private model', reasoningLevels: ['low'], defaultReasoningEffort: 'low', contextWindows: [32000], defaultContextWindow: 32000, supportsFastMode: false })
  const snapshot: ProviderInstancesSnapshot = { revision: 0, instances: [base, work], selected: { codex: 'codex', 'claude-code': 'claude-code' }, projects: [], healthCheckSeconds: 0, idleCompaction: 'onReturn' }
  const metadata: AgentMetadata = { id: 'codex', label: 'Codex', defaultModel: 'builtin', ...instanceModelCatalog(base), instancePreferences: {
    selected: 'codex', instances: [base, work].map((instance) => ({ ...instance, binaryAvailable: true })),
    projects: [{ projectRoot: '/repo', selected: { codex: 'work' }, enabled: { work: true } }],
  } }
  return { snapshot, metadata }
}
describe('project provider model choices', () => {
  test('a project uses its selected catalog while its default comes from model profiles', () => {
    const { metadata } = fixture()
    const effective = agentForProject(metadata, '/repo')
    const builtin = Object.keys(MODEL_PROFILES.codex!).find((id) => MODEL_PROFILES.codex![id]!.isDefault)
    expect(effective.defaultModel).toBe(builtin)
    expect(effective.available).toBe(true)
    expect(effective.models.some((model) => model.id === 'private-model')).toBe(true)
    expect(metadata.models.some((model) => model.id === 'private-model')).toBe(false)
    expect(agentForProject(metadata, '/other').defaultModel).toBe(builtin)
    expect(agentForProject(metadata, `/repo/${SOLUS_WORKTREE_DIR}/branch`).defaultModel).toBe(builtin)
  })
  test('native defaults honor personal preferences and explicit choices keep their model', () => {
    const { metadata } = fixture()
    const effective = agentForProject(metadata, '/repo')
    const builtin = Object.keys(MODEL_PROFILES.codex!)[0]!
    const personal = { defaultModels: { codex: builtin }, modelOptionsByProvider: {} }
    expect(newSessionModel('codex', personal, effective).preferredModel).toBe(builtin)
    expect(selectModel('codex', builtin, personal, effective).preferredModel).toBe(builtin)
  })
  test('fresh installs use model profiles and personal choices override them across projects', () => {
    const { metadata } = fixture()
    const effective = agentForProject(metadata, '/repo')
    const builtin = Object.keys(MODEL_PROFILES.codex!).find((id) => MODEL_PROFILES.codex![id]!.isDefault)!
    expect(newSessionModel('codex', null, effective).preferredModel).toBe(builtin)
    const personal = { defaultModels: { codex: 'private-model' }, modelOptionsByProvider: {} }
    expect(newSessionModel('codex', personal, effective).preferredModel).toBe('private-model')
    expect(newSessionModel('codex', { ...personal, defaultModels: { codex: 'auto' } }, effective).preferredModel).toBe('auto')
    expect(newSessionModel('codex', { ...personal, defaultModels: { codex: 'auto' } }, effective, false).preferredModel).toBe(builtin)
  })
  test('reset removes both selection and availability while individual resets preserve other overrides', () => {
    const { snapshot } = fixture()
    snapshot.projects.push({ projectRoot: '/repo', selected: { codex: 'work' }, enabled: { codex: false, work: true } })
    const enabled = changeProjectProviderOverride(snapshot, '/repo', { kind: 'enabled', instanceId: 'work', enabled: null })
    expect(enabled).toEqual({ projectRoot: '/repo', selected: { codex: 'work' }, enabled: { codex: false } })
    expect(changeProjectProviderOverride(snapshot, '/repo', { kind: 'reset' })).toEqual({ projectRoot: '/repo', selected: {}, enabled: {} })
    expect(providerProjectOverride(snapshot.projects, '/repo-other')).toBeUndefined()
    expect(providerProjectOverride([{ projectRoot: 'C:\\code\\repo', selected: {}, enabled: {} }], 'c:/CODE/repo/')?.projectRoot).toBe('C:\\code\\repo')
  })
})
