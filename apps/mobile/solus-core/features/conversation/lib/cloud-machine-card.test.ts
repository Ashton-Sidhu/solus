import { readCloudMachineAnswer, type CloudMachineAsk } from '@solus/contracts/cloud-machine-card'
import { describe, expect, it } from 'vite-plus/test'
import {
  cardFacts,
  chosenAnswers,
  declinedAnswers,
  fieldsProblem,
  initialFields,
  restartsOnSave,
  scriptLines,
  submitLabel,
} from './cloud-machine-card'

const catalog = {
  sizes: [
    { id: 'small', label: 'Small', detail: 'For light work', cpus: 2, memoryGb: 4 },
    { id: 'standard', label: 'Standard', detail: 'For builds', cpus: 4, memoryGb: 16 },
  ],
  defaultSize: 'standard',
  supportsPackages: true,
  supportsSetupScript: true,
}
const organizations = [
  { id: 'acme', name: 'Acme' },
  { id: 'side', name: 'Side project' },
]
const create = (draft: Extract<CloudMachineAsk, { mode: 'create' }>['draft'] = {}): CloudMachineAsk => ({
  mode: 'create', reason: 'A machine with Docker.', organizations, catalog, draft,
})
const edit = (state: 'ready' | 'stopped'): CloudMachineAsk => ({
  mode: 'edit',
  reason: 'You did not say what to change.',
  host: { hostId: 'h1', name: 'Build box', state, size: 'Standard' },
  current: { packages: ['docker.io', 'jq'], setupScript: '#!/bin/sh\nset -eu\n' },
})
const join: CloudMachineAsk = { mode: 'join', reason: 'To share it.', organizations, address: 'dev@10.0.0.5' }

// Each answer must pass the tool's own check (`readCloudMachineAnswer`), or the tool refuses what the person chose.

describe('the create card', () => {
  it('selects the catalog default size and asks for an organization when there are two', () => {
    const fields = initialFields(create({ name: 'Build box', packages: ['docker.io'] }))
    expect(fields).toEqual({ organizationId: null, name: 'Build box', size: 'standard', packagesText: 'docker.io', setupScript: '' })
    expect(cardFacts(create({ name: 'Build box', packages: ['docker.io'] }), fields)).toEqual([
      { label: 'Organization', value: 'Choose one', missing: true },
      { label: 'Name', value: 'Build box' },
      { label: 'Size', value: 'Standard · 4 CPU · 16 GB' },
      { label: 'Packages', value: 'docker.io' },
    ])
  })

  it('keeps the size and organization that the agent chose, and the only organization', () => {
    expect(initialFields(create({ organizationId: 'side', size: 'small' }))).toMatchObject({ organizationId: 'side', size: 'small' })
    const single: CloudMachineAsk = { mode: 'create', reason: '', organizations: [organizations[0]!], catalog, draft: {} }
    expect(initialFields(single).organizationId).toBe('acme')
  })

  it('ignores a draft size or organization that the ask does not offer', () => {
    expect(initialFields(create({ organizationId: 'other', size: 'huge' }))).toMatchObject({ organizationId: null, size: 'standard' })
  })

  it('blocks the submit until an organization is chosen', () => {
    const ask = create()
    const fields = initialFields(ask)
    expect(fieldsProblem(ask, fields)).toBe('Choose an organization.')
    expect(fieldsProblem(ask, { ...fields, organizationId: 'acme' })).toBeNull()
  })

  it('blocks the submit for a package name that Solus Cloud refuses', () => {
    const ask = create({ organizationId: 'acme' })
    const fields = { ...initialFields(ask), packagesText: 'docker.io rm;-rf' }
    expect(fieldsProblem(ask, fields)).toBe('"rm;-rf" is not a package name.')
  })

  it('answers with each field, and the tool accepts it', () => {
    const ask = create({ organizationId: 'acme', name: 'Build box', setupScript: 'echo hi' })
    const answers = chosenAnswers(ask, { ...initialFields(ask), packagesText: 'docker.io, jq' })
    expect(answers).toEqual({
      status: 'chosen', organizationId: 'acme', name: 'Build box', size: 'standard', packages: 'docker.io jq', setupScript: 'echo hi',
    })
    expect(readCloudMachineAnswer(ask, answers)).toEqual({
      status: 'chosen',
      choice: { organizationId: 'acme', name: 'Build box', size: 'standard', packages: ['docker.io', 'jq'], setupScript: 'echo hi' },
    })
  })

  it('sends no packages or script when the catalog does not offer them', () => {
    const ask: CloudMachineAsk = {
      mode: 'create', reason: '', organizations, catalog: { ...catalog, supportsPackages: false, supportsSetupScript: false }, draft: { organizationId: 'acme' },
    }
    expect(chosenAnswers(ask, initialFields(ask))).toEqual({ status: 'chosen', organizationId: 'acme', size: 'standard' })
  })
})

describe('the edit card', () => {
  it('starts from the current setup and shows it as facts', () => {
    const ask = edit('ready')
    const fields = initialFields(ask)
    expect(fields.packagesText).toBe('docker.io jq')
    expect(cardFacts(ask, fields)).toEqual([
      { label: 'Machine', value: 'Build box' },
      { label: 'State', value: 'Ready', state: 'ready' },
      { label: 'Packages', value: 'docker.io, jq' },
      { label: 'Setup script', value: '2 lines' },
    ])
  })

  it('warns of a restart only for a machine that runs', () => {
    expect(restartsOnSave(edit('ready'))).toBe(true)
    expect(submitLabel(edit('ready'))).toBe('Save and restart')
    expect(restartsOnSave(edit('stopped'))).toBe(false)
    expect(submitLabel(edit('stopped'))).toBe('Save')
  })

  it('answers with packages and the script only; empty packages clear them', () => {
    const ask = edit('stopped')
    const answers = chosenAnswers(ask, { ...initialFields(ask), packagesText: '', setupScript: '' })
    expect(answers).toEqual({ status: 'chosen', packages: '', setupScript: '' })
    expect(readCloudMachineAnswer(ask, answers)).toEqual({ status: 'chosen', choice: { packages: [], setupScript: '' } })
  })

  it('blocks the submit for too many packages', () => {
    const ask = edit('ready')
    const packagesText = Array.from({ length: 65 }, (_, index) => `p${index}`).join(' ')
    expect(fieldsProblem(ask, { ...initialFields(ask), packagesText })).toBe('A machine takes at most 64 packages.')
  })
})

describe('the join card', () => {
  it('shows the address, asks for an organization, and answers with it only', () => {
    const fields = initialFields(join)
    expect(cardFacts(join, fields)).toEqual([
      { label: 'Address', value: 'dev@10.0.0.5' },
      { label: 'Organization', value: 'Choose one', missing: true },
    ])
    expect(fieldsProblem(join, fields)).toBe('Choose an organization.')
    const answers = chosenAnswers(join, { ...fields, organizationId: 'side' })
    expect(answers).toEqual({ status: 'chosen', organizationId: 'side' })
    expect(readCloudMachineAnswer(join, answers)).toEqual({ status: 'chosen', choice: { organizationId: 'side' } })
    expect(submitLabel(join)).toBe('Join machine')
  })
})

it('declines with the status only', () => {
  expect(declinedAnswers()).toEqual({ status: 'declined' })
})

it('counts the lines of a script', () => {
  expect(scriptLines('')).toBe('None')
  expect(scriptLines('echo hi\n')).toBe('1 line')
  expect(scriptLines('a\nb\nc')).toBe('3 lines')
})
