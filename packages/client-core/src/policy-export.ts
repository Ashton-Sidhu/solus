import { z } from 'zod'
import type { PolicyDocument } from '@solus/contracts/policy'

/**
 * The three ways an administrator installs a policy document as the MDM policy
 * of a machine (plans/030 §5.1, §7): the `policy.json` file, a macOS device
 * configuration profile for the domain `com.solus.app`, and a PowerShell script
 * that writes the Windows registry value. Pure: the editor offers each as a
 * download, and the host's reader turns each back into the same document.
 */

export const POLICY_PREFERENCE_DOMAIN = 'com.solus.app'
export const POLICY_REGISTRY_KEY = 'HKLM\\SOFTWARE\\Policies\\Solus'
export const POLICY_REGISTRY_VALUE = 'Policy'

export interface PolicyExportFile {
  fileName: string
  mimeType: string
  text: string
}

export type PolicyExportFormat = 'json' | 'mobileconfig' | 'powershell'

export const POLICY_EXPORT_FORMATS: readonly { format: PolicyExportFormat; label: string; description: string }[] = [
  { format: 'json', label: 'policy.json', description: 'The file for macOS, Windows, or Linux.' },
  { format: 'mobileconfig', label: 'macOS profile', description: 'A device configuration profile for your MDM tool.' },
  { format: 'powershell', label: 'Windows script', description: 'Writes the registry value. Run it as an administrator.' },
]

export function policyJson(document: PolicyDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

/** The registry value: the document as one line of JSON. */
export function policyRegistryValue(document: PolicyDocument): string {
  return JSON.stringify(document)
}

/** A profile cannot hold `null`; a document that needs one is installed as the file. Null when the document has none. */
export function mobileconfigBlocker(document: PolicyDocument): string | null {
  const path = firstNullPath(plistNodeSchema.parse(document), [])
  return path ? `A macOS profile cannot hold null (${path.join('.')}). Install policy.json instead.` : null
}

/** The payload's keys are the document's top-level keys, beside the payload's own `Payload*` keys. */
export function mobileconfigPayload(document: PolicyDocument, payloadUuid: string) {
  return {
    PayloadType: POLICY_PREFERENCE_DOMAIN,
    PayloadIdentifier: `${POLICY_PREFERENCE_DOMAIN}.policy.${payloadUuid}`,
    PayloadUUID: payloadUuid,
    PayloadVersion: 1,
    PayloadDisplayName: 'Solus policy',
    ...document,
  }
}

/** `uuid` names the profile and its payload; pass fixed values for a stable file. */
export function policyMobileconfig(document: PolicyDocument, uuid: () => string = () => crypto.randomUUID()): string {
  const blocker = mobileconfigBlocker(document)
  if (blocker) throw new Error(blocker)
  const profileUuid = uuid().toUpperCase()
  const payloadUuid = uuid().toUpperCase()
  const profile = {
    PayloadContent: [mobileconfigPayload(document, payloadUuid)],
    PayloadDisplayName: `Solus policy (${document.organization.name})`,
    PayloadDescription: document.name ?? 'Managed policy for Solus.',
    PayloadIdentifier: `${POLICY_PREFERENCE_DOMAIN}.policy`,
    PayloadOrganization: document.organization.name,
    PayloadScope: 'System',
    PayloadType: 'Configuration',
    PayloadUUID: profileUuid,
    PayloadVersion: 1,
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistXml(plistNodeSchema.parse(profile), ''),
    '</plist>',
    '',
  ].join('\n')
}

export function policyPowerShell(document: PolicyDocument): string {
  // A single-quoted PowerShell string is literal; only a quote is doubled.
  const value = policyRegistryValue(document).replaceAll("'", "''")
  return [
    '#Requires -RunAsAdministrator',
    `# Installs the Solus policy of ${document.organization.name.replace(/[\r\n]/g, ' ')}. Restart Solus to apply it.`,
    "$ErrorActionPreference = 'Stop'",
    `$key = 'HKLM:\\SOFTWARE\\Policies\\Solus'`,
    `$policy = '${value}'`,
    'New-Item -Path $key -Force | Out-Null',
    `New-ItemProperty -Path $key -Name '${POLICY_REGISTRY_VALUE}' -PropertyType String -Value $policy -Force | Out-Null`,
    '',
  ].join('\r\n')
}

export function policyExportFile(document: PolicyDocument, format: PolicyExportFormat): PolicyExportFile {
  switch (format) {
    case 'json': return { fileName: 'policy.json', mimeType: 'application/json', text: policyJson(document) }
    case 'mobileconfig': return { fileName: `${POLICY_PREFERENCE_DOMAIN}.mobileconfig`, mimeType: 'application/x-apple-aspen-config', text: policyMobileconfig(document) }
    case 'powershell': return { fileName: 'Set-SolusPolicy.ps1', mimeType: 'text/plain', text: policyPowerShell(document) }
  }
}

/** A property-list value. JSON decodes into it at the export boundary; `null` is kept so the blocker can name its path. */
type PlistNode =
  | { kind: 'boolean'; value: boolean }
  | { kind: 'integer' | 'real'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'null' }
  | { kind: 'array'; items: PlistNode[] }
  | { kind: 'dict'; entries: [string, PlistNode][] }

const plistNodeSchema: z.ZodType<PlistNode> = z.lazy(() => z.union([
  z.null().transform((): PlistNode => ({ kind: 'null' })),
  z.boolean().transform((value): PlistNode => ({ kind: 'boolean', value })),
  z.number().transform((value): PlistNode => ({ kind: Number.isInteger(value) ? 'integer' : 'real', value })),
  z.string().transform((value): PlistNode => ({ kind: 'string', value })),
  z.array(plistNodeSchema).transform((items): PlistNode => ({ kind: 'array', items })),
  // An absent optional key is not written.
  z.record(z.string(), plistNodeSchema.optional()).transform((record): PlistNode => ({
    kind: 'dict',
    entries: Object.entries(record).flatMap(([key, child]): [string, PlistNode][] => (child ? [[key, child]] : [])),
  })),
]))

function plistXml(node: PlistNode, indent: string): string {
  const inner = `${indent}  `
  switch (node.kind) {
    case 'array':
      if (node.items.length === 0) return `${indent}<array/>`
      return [`${indent}<array>`, ...node.items.map((item) => plistXml(item, inner)), `${indent}</array>`].join('\n')
    case 'dict':
      if (node.entries.length === 0) return `${indent}<dict/>`
      return [
        `${indent}<dict>`,
        ...node.entries.flatMap(([key, child]) => [`${inner}<key>${escapeXml(key)}</key>`, plistXml(child, inner)]),
        `${indent}</dict>`,
      ].join('\n')
    case 'boolean': return `${indent}<${node.value}/>`
    case 'integer':
    case 'real': return `${indent}<${node.kind}>${node.value}</${node.kind}>`
    case 'string': return `${indent}<string>${escapeXml(node.value)}</string>`
    case 'null': throw new Error('A macOS profile cannot hold null.')
  }
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function firstNullPath(node: PlistNode, path: string[]): string[] | null {
  switch (node.kind) {
    case 'null': return path
    case 'array':
      for (const [index, item] of node.items.entries()) {
        const found = firstNullPath(item, [...path, String(index)])
        if (found) return found
      }
      return null
    case 'dict':
      for (const [key, child] of node.entries) {
        const found = firstNullPath(child, [...path, key])
        if (found) return found
      }
      return null
    default: return null
  }
}
