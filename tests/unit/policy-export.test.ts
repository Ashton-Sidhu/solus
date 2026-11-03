import { describe, expect, test } from 'bun:test'
import { validatePolicyDocument, type PolicyDocument } from '@solus/contracts/policy'
import {
  mobileconfigBlocker,
  policyExportFile,
  policyJson,
  policyMobileconfig,
  policyPowerShell,
  policyRegistryValue,
} from '@solus/client-core/policy-export'

// plans/030 §5.1: one document, installed three ways. The host reads each back
// into the same document, so every export must round-trip exactly.

const document: PolicyDocument = {
  schemaVersion: 1,
  organization: { name: "O'Brien & <Partners>" },
  supportUrl: 'https://it.example.com/solus',
  revision: 3,
  host: { remoteAccess: false, cloudTunnel: false, analyticsEnabled: false, archivedAutomationRetentionDays: 30, updates: { mode: 'auto' } },
  sessions: {
    settings: { extraInstructions: "Never push to main.\nAsk first, it's safer." },
    limits: {
      maxPermissionMode: 'accept-edits',
      providers: { allowed: ['claude-code'], launch: { 'claude-code': { environment: [{ name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' }] } } },
      models: { 'claude-code': ['claude-opus-5-5', 'claude-sonnet-5-5'] },
    },
  },
}

const fixedUuids = () => {
  let n = 0
  return () => `00000000-0000-4000-8000-00000000000${n++}`
}

/** A small reader for the XML property lists this module writes: what `plutil -convert json` gives the host. */
function readPlist(xml: string): unknown {
  const tokens = [...xml.replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/g, '').matchAll(/<(\/?)(\w+)(\/?)>([^<]*)/g)]
  let index = 0
  const unescape = (text: string) => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  const value = (): unknown => {
    const [, , tag, selfClosing, text] = tokens[index++]!
    if (tag === 'plist') {
      const inner = value()
      index++
      return inner
    }
    if (selfClosing) return tag === 'true' ? true : tag === 'false' ? false : tag === 'dict' ? {} : []
    if (tag === 'string' || tag === 'integer' || tag === 'real') {
      index++
      return tag === 'string' ? unescape(text!) : Number(text)
    }
    if (tag === 'array') {
      const out: unknown[] = []
      while (tokens[index]![1] !== '/') out.push(value())
      index++
      return out
    }
    const out: { [key: string]: unknown } = {}
    while (tokens[index]![1] !== '/') {
      const key = unescape(tokens[index]![4]!)
      index += 2
      out[key] = value()
    }
    index++
    return out
  }
  return value()
}

describe('policy export', () => {
  test('policy.json is the document itself', () => {
    expect(JSON.parse(policyJson(document))).toEqual(document)
  })

  test('the macOS profile carries the document as the payload of com.solus.app, and reads back as the same document', () => {
    const profile = readPlist(policyMobileconfig(document, fixedUuids())) as { PayloadType: string; PayloadScope: string; PayloadContent: { [key: string]: unknown }[] }
    expect(profile.PayloadType).toBe('Configuration')
    expect(profile.PayloadScope).toBe('System')
    const payload = profile.PayloadContent[0]!
    expect(payload.PayloadType).toBe('com.solus.app')
    // Managed Preferences hold the payload's keys; the Payload* keys are the profile's own.
    const keys = Object.fromEntries(Object.entries(payload).filter(([key]) => !key.startsWith('Payload')))
    expect(keys).toEqual(document)
    expect(validatePolicyDocument(keys, 'mdm').ok).toBe(true)
  })

  test('a document that needs null cannot be a profile, and says to use the file', () => {
    const withNull: PolicyDocument = { ...document, sessions: { settings: { leadModel: null } } }
    expect(mobileconfigBlocker(withNull)).toContain('sessions.settings.leadModel')
    expect(() => policyMobileconfig(withNull)).toThrow('policy.json')
    expect(mobileconfigBlocker(document)).toBeNull()
  })

  test('the PowerShell script writes one line of JSON to HKLM\\SOFTWARE\\Policies\\Solus value Policy', () => {
    const script = policyPowerShell(document)
    const assignment = script.split('\r\n').find((line) => line.startsWith('$policy = '))!
    const literal = assignment.slice("$policy = '".length, -1).replaceAll("''", "'")
    expect(literal).toBe(policyRegistryValue(document))
    expect(literal.includes('\n')).toBe(false)
    expect(JSON.parse(literal)).toEqual(document)
    expect(script).toContain("$key = 'HKLM:\\SOFTWARE\\Policies\\Solus'")
    expect(script).toContain("-Name 'Policy' -PropertyType String")
    expect(script.startsWith('#Requires -RunAsAdministrator')).toBe(true)
  })

  test('each format has the file name an administrator installs', () => {
    expect(policyExportFile(document, 'json').fileName).toBe('policy.json')
    expect(policyExportFile(document, 'mobileconfig').fileName).toBe('com.solus.app.mobileconfig')
    expect(policyExportFile(document, 'powershell').fileName).toBe('Set-SolusPolicy.ps1')
  })
})
