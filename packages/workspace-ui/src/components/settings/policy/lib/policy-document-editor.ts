import type { PolicyDocument, PolicyKind } from '@solus/contracts/policy'
import { mobileconfigBlocker, policyExportFile, type PolicyExportFile, type PolicyExportFormat } from '@solus/client-core/policy-export'
import { checkPolicyText, policyDifferences, policyText, type PolicyDifference, type PolicyTextCheck } from './policy-editor'

/**
 * The document editor's answers: the check of its text, what it changes, what
 * an import would change, and each export. Kept apart from the component so the
 * rules are tested without a DOM.
 */

/** An import read and checked, waiting for the person to confirm it. */
export type PendingImport =
  | { ok: true; fileName: string; text: string; differences: PolicyDifference[] }
  | { ok: false; fileName: string; issues: string[] }

/** `current`: the check of the text in the editor now; the import is compared with it. */
export function readImport(fileName: string, text: string, current: PolicyTextCheck, kind: PolicyKind): PendingImport {
  const checked = checkPolicyText(text, kind)
  if (!checked.ok) return { ok: false, fileName, issues: checked.issues }
  return { ok: true, fileName, text: policyText(checked.document), differences: policyDifferences(current.ok ? current.document : null, checked.document) }
}

/** What the edit changes from the document that was read; empty when the edit does not pass the check. */
export function editDifferences(base: PolicyDocument | null, edited: PolicyTextCheck): PolicyDifference[] {
  return edited.ok ? policyDifferences(base, edited.document) : []
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
