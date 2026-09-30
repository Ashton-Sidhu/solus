import { randomBytes } from 'crypto'

const TEMPORARY_BRANCH_PATTERN = /^solus\/[0-9a-f]{8}$/

function slugifyBranch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/** The branch a worktree starts on, so creating it never waits on a model. */
export function temporaryWorktreeBranchName(): string {
  return `solus/${randomBytes(4).toString('hex')}`
}

/** Only a temporary branch is renamed: a name a person or agent chose stays. */
export function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMPORARY_BRANCH_PATTERN.test(branch)
}

/** The branch a generated name becomes, or null when no usable word is left. */
export function generatedWorktreeBranchName(generatedName: string): string | null {
  const slug = slugifyBranch(generatedName)
  return slug ? `solus/${slug}` : null
}
