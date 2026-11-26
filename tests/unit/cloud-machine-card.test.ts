import { describe, expect, test } from 'bun:test'
import { readCloudMachineAnswer, type CloudMachineAsk } from '@solus/contracts/cloud-machine-card'
import type { ManagedHostCatalog } from '@solus/contracts/uplink'
import {
  cloudMachineFacts,
  cloudMachineSubmit,
  cloudMachineSubmitLabel,
  initialCloudMachineForm,
  setupScriptSummary,
} from '@solus/workspace-ui/components/conversation/lib/cloud-machine-card'

const catalog: ManagedHostCatalog = {
  sizes: [
    { id: 'small', label: 'Small', detail: 'For light work', cpus: 2, memoryGb: 8 },
    { id: 'large', label: 'Large', detail: 'For builds', cpus: 8, memoryGb: 32 },
  ],
  defaultSize: 'large',
  supportsPackages: true,
  supportsSetupScript: true,
}
const acme = { id: 'org-acme', name: 'Acme' }
const globex = { id: 'org-globex', name: 'Globex' }

function createAsk(draft: Extract<CloudMachineAsk, { mode: 'create' }>['draft'], organizations = [acme, globex]): CloudMachineAsk {
  return { mode: 'create', reason: 'The tests need Postgres.', organizations, catalog, draft }
}

const editAsk = (state: 'ready' | 'stopped'): CloudMachineAsk => ({
  mode: 'edit',
  reason: 'Add ripgrep.',
  host: { hostId: 'host-1', name: 'Acme builder', state, size: 'Large' },
  current: { packages: ['git', 'jq'], setupScript: 'apt-get update\nmake setup\n' },
})

const joinAsk: CloudMachineAsk = { mode: 'join', reason: 'Join the build box.', organizations: [acme, globex], address: 'https://box.example.com' }

describe('machine card: create', () => {
  test('the form takes the draft, and the catalog default when the draft names no size', () => {
    const form = initialCloudMachineForm(createAsk({ organizationId: 'org-globex', name: 'pg box', packages: ['postgresql-client'] }))
    expect(form).toEqual({ organizationId: 'org-globex', name: 'pg box', sizeId: 'large', packages: 'postgresql-client', setupScript: '' })
  })

  test('a draft size outside the catalog falls back to the default size', () => {
    expect(initialCloudMachineForm(createAsk({ size: 'huge' })).sizeId).toBe('large')
    expect(initialCloudMachineForm(createAsk({ size: 'small' })).sizeId).toBe('small')
  })

  test('the only organization is chosen; of several, none is chosen for the person', () => {
    expect(initialCloudMachineForm(createAsk({}, [acme])).organizationId).toBe('org-acme')
    expect(initialCloudMachineForm(createAsk({})).organizationId).toBe('')
    // A draft organization that the person may not choose is not a choice.
    expect(initialCloudMachineForm(createAsk({ organizationId: 'org-other' })).organizationId).toBe('')
  })

  test('a missing organization shows "Choose one" and blocks the answer', () => {
    const ask = createAsk({})
    expect(cloudMachineFacts(ask)[0]).toEqual({ label: 'Organization', value: 'Choose one', isMissing: true })
    const submit = cloudMachineSubmit(ask, initialCloudMachineForm(ask))
    expect(submit).toEqual({ ok: false, field: 'organization', problem: 'Choose an organization.' })
  })

  test('the facts give the size with its CPU and memory', () => {
    const facts = cloudMachineFacts(createAsk({ organizationId: 'org-acme', packages: ['ripgrep', 'jq'] }))
    expect(facts).toEqual([
      { label: 'Organization', value: 'Acme' },
      { label: 'Name', value: 'Acme' },
      { label: 'Size', value: 'Large · 8 CPU · 32 GB' },
      { label: 'Packages', value: 'ripgrep, jq' },
    ])
  })

  test('the answer carries each field, and the tool reads it back as the same choice', () => {
    const ask = createAsk({ organizationId: 'org-acme' })
    const form = { ...initialCloudMachineForm(ask), name: '  pg box ', sizeId: 'small', packages: 'postgresql-client, ripgrep', setupScript: 'make setup\n' }
    const submit = cloudMachineSubmit(ask, form)
    expect(submit).toEqual({
      ok: true,
      answers: { status: 'chosen', organizationId: 'org-acme', name: 'pg box', size: 'small', packages: 'postgresql-client ripgrep', setupScript: 'make setup' },
    })
    if (!submit.ok) throw new Error('expected an answer')
    expect(readCloudMachineAnswer(ask, submit.answers)).toEqual({
      status: 'chosen',
      choice: { organizationId: 'org-acme', name: 'pg box', size: 'small', packages: ['postgresql-client', 'ripgrep'], setupScript: 'make setup' },
    })
  })

  test('a field that the catalog does not offer is not sent', () => {
    const ask: CloudMachineAsk = { ...createAsk({ organizationId: 'org-acme' }), catalog: { ...catalog, supportsPackages: false, supportsSetupScript: false } } as CloudMachineAsk
    const submit = cloudMachineSubmit(ask, { ...initialCloudMachineForm(ask), packages: 'ripgrep', setupScript: 'make' })
    expect(submit).toEqual({ ok: true, answers: { status: 'chosen', organizationId: 'org-acme', size: 'large' } })
  })

  test('a bad package blocks the answer and names the package', () => {
    const ask = createAsk({ organizationId: 'org-acme' })
    const submit = cloudMachineSubmit(ask, { ...initialCloudMachineForm(ask), packages: 'ripgrep Postgres' })
    expect(submit).toEqual({ ok: false, field: 'packages', problem: '"Postgres" is not a package name.' })
  })
})

describe('machine card: edit', () => {
  test('the form takes the setup that the machine has now', () => {
    expect(initialCloudMachineForm(editAsk('ready'))).toMatchObject({ packages: 'git jq', setupScript: 'apt-get update\nmake setup\n' })
  })

  test('the facts give the script as a line count', () => {
    expect(cloudMachineFacts(editAsk('stopped'))).toEqual([
      { label: 'Machine', value: 'Acme builder' },
      { label: 'State', value: 'Stopped' },
      { label: 'Packages', value: 'git, jq' },
      { label: 'Setup script', value: '2 lines' },
    ])
    expect(setupScriptSummary('')).toBe('None')
    expect(setupScriptSummary('make\n')).toBe('1 line')
  })

  test('a ready machine restarts to take the change; a stopped one only saves', () => {
    expect(cloudMachineSubmitLabel(editAsk('ready'))).toBe('Save and restart')
    expect(cloudMachineSubmitLabel(editAsk('stopped'))).toBe('Save')
  })

  test('the answer carries only the packages and the script, and an empty script removes it', () => {
    const ask = editAsk('ready')
    const submit = cloudMachineSubmit(ask, { ...initialCloudMachineForm(ask), packages: 'git jq ripgrep', setupScript: '' })
    expect(submit).toEqual({ ok: true, answers: { status: 'chosen', packages: 'git jq ripgrep', setupScript: '' } })
    if (!submit.ok) throw new Error('expected an answer')
    expect(readCloudMachineAnswer(ask, submit.answers)).toEqual({ status: 'chosen', choice: { packages: ['git', 'jq', 'ripgrep'], setupScript: '' } })
  })

  test('a bad package blocks the answer', () => {
    const ask = editAsk('stopped')
    const submit = cloudMachineSubmit(ask, { ...initialCloudMachineForm(ask), packages: 'git; rm -rf /' })
    expect(submit.ok).toBe(false)
    if (!submit.ok) expect(submit.field).toBe('packages')
  })
})

describe('machine card: join', () => {
  test('the answer carries only the organization', () => {
    expect(cloudMachineSubmit(joinAsk, initialCloudMachineForm(joinAsk)).ok).toBe(false)
    const submit = cloudMachineSubmit(joinAsk, { ...initialCloudMachineForm(joinAsk), organizationId: 'org-globex', name: 'ignored', packages: 'ignored' })
    expect(submit).toEqual({ ok: true, answers: { status: 'chosen', organizationId: 'org-globex' } })
    expect(cloudMachineSubmitLabel(joinAsk)).toBe('Join machine')
  })

  test('the facts give the address, and the organization when there is only one', () => {
    expect(cloudMachineFacts(joinAsk)).toEqual([{ label: 'Address', value: 'https://box.example.com' }])
    const single: CloudMachineAsk = { ...joinAsk, organizations: [acme] } as CloudMachineAsk
    expect(cloudMachineFacts(single)).toEqual([{ label: 'Address', value: 'https://box.example.com' }, { label: 'Organization', value: 'Acme' }])
    expect(initialCloudMachineForm(single).organizationId).toBe('org-acme')
  })
})
