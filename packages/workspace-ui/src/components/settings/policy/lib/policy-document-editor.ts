import type { PolicyKind } from '@solus/contracts/policy'
import { mobileconfigBlocker, policyExportFile, type PolicyExportFile, type PolicyExportFormat } from '@solus/client-core/policy-export'
import { checkPolicyText, policyDifferences, type PolicyDifference, type PolicyTextCheck } from './policy-editor'

/**
 * The document editor's answers: the check of its text, what it changes, what
 * an import would change, and each export. Kept apart from the component so the
 * rules are tested without a DOM.
 */

/** An import read and checked, waiting for the person to confirm it. */
export type PendingImport =
  | { ok: true; fileName: string; text: string; differences: PolicyDifference[] }
  | { ok: false; fileName: string; issues: string[] }

/** `current`: the text in the editor now; the import is compared with it. */
export function readImport(fileName: string, text: string, current: string, kind: PolicyKind): PendingImport {
  const checked = checkPolicyText(text, kind)
  if (!checked.ok) return { ok: false, fileName, issues: checked.issues }
  const before = parsedOrNull(current)
  return { ok: true, fileName, text: `${JSON.stringify(checked.document, null, 2)}\n`, differences: policyDifferences(before, checked.document) }
}

/** What the edit changes from the document that was read; empty when nothing changed or the text does not parse. */
export function editDifferences(base: unknown, text: string): PolicyDifference[] {
  const edited = parsedOrNull(text)
  return edited === null ? [] : policyDifferences(base, edited)
}

/** Each export, or why it cannot be made: a document that fails the check exports nothing. */
export function exportChoice(check: PolicyTextCheck, format: PolicyExportFormat): { file: PolicyExportFile } | { blocked: string } {
  if (!check.ok) return { blocked: 'Fix the issues in this document first.' }
  if (format === 'mobileconfig') {
    const blocker = mobileconfigBlocker(check.document)
    if (blocker) return { blocked: blocker }
  }
  return { file: policyExportFile(check.document, format) }
}

function parsedOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
