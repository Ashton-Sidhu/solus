import type { EffortInput, ReviewEffort } from '../../shared/effort-types'

/** Paths where a small textual diff can carry disproportionate review risk. */
export const REVIEW_RISK_PATHS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'auth/', pattern: /(^|\/)(auth|authentication|authorization)(\/|[._-]|$)/i },
  { label: 'migrations/', pattern: /(^|\/)(migrations?|db\/migrations?)(\/|$)/i },
  { label: 'public API', pattern: /(^|\/)(api|public-api|sdk)(\/|$)|(^|\/)(index|exports)\.[cm]?[jt]sx?$/i },
]

const LOCKFILE_PATTERN = /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock|gemfile\.lock|poetry\.lock|composer\.lock|go\.sum)$/i
const TEST_FILE_PATTERN = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i

function fileType(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : 'extensionless'
}

export function estimateReviewEffort(input: EffortInput): ReviewEffort {
  const { fileStats } = input
  const fileCount = fileStats.length
  const totalLines = fileStats.reduce((sum, file) => sum + file.additions + file.deletions, 0)
  const generated = new Set(input.generatedPaths)
  const renamed = new Set(input.renamedPaths)
  const readableFiles = fileStats.filter((file) => !generated.has(file.path))
  const readableLines = readableFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0)
  const lockfileOnly = fileCount > 0 && fileStats.every((file) => LOCKFILE_PATTERN.test(file.path))
  const generatedOnly = fileCount > 0 && fileStats.every((file) => generated.has(file.path))
  const renameOnly = fileCount > 0
    && fileStats.every((file) => renamed.has(file.path))
    && totalLines === 0
  const riskLabels = REVIEW_RISK_PATHS
    .filter(({ pattern }) => fileStats.some((file) => pattern.test(file.path)))
    .map(({ label }) => label)

  const signals: string[] = []
  if (lockfileOnly) signals.push('lockfile only')
  else if (generatedOnly) signals.push('generated files only')
  else if (renameOnly) signals.push('rename only')
  signals.push(`${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${totalLines} ${totalLines === 1 ? 'line' : 'lines'}`)
  for (const label of riskLabels) signals.push(`touches ${label}`)
  if (fileStats.some((file) => TEST_FILE_PATTERN.test(file.path))) signals.push('includes tests')
  const typeCount = new Set(readableFiles.map((file) => fileType(file.path))).size
  if (typeCount > 1) signals.push(`${typeCount} file types`)

  if (riskLabels.length === 0 && (lockfileOnly || generatedOnly || renameOnly)) {
    return { minutes: 1, band: 'quick', signals }
  }

  // About 80 changed lines/minute plus context-switching time per file. Risk
  // paths add a fixed reread allowance rather than pretending to infer intent.
  const minutes = Math.max(1, Math.ceil(readableLines / 80 + readableFiles.length / 4) + riskLabels.length * 3)
  const involved = riskLabels.length > 0 || fileCount >= 15 || readableLines >= 500 || minutes >= 10
  const quick = !involved && fileCount <= 3 && readableLines <= 60 && minutes <= 2

  return { minutes, band: quick ? 'quick' : involved ? 'involved' : 'standard', signals }
}
