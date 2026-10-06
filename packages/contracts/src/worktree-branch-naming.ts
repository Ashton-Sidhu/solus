import { z } from 'zod'

// ─── Worktree branch naming ───
//
// How Solus names the branch of a worktree it creates. The host config holds
// the default; a project's `.solus/config.json` can override it. Every mode is
// a template:
//
// - `generated` is `{prefix}/{slug}`. The worktree starts on a temporary branch
//   (`{slug}` is the short id) and is renamed when a title is generated.
// - `static` is `{prefix}/{id}`. The first name is the final name.
// - `custom` is the user's template. It is renamed only when it uses `{slug}`.
//
// This module is pure, so the server and the Settings preview give the same
// answer. A name is never left invalid: a template that does not make a valid
// git branch falls back to the default.

export const WORKTREE_BRANCH_NAMING_MODES = ['generated', 'static', 'custom'] as const
export type WorktreeBranchNamingMode = (typeof WORKTREE_BRANCH_NAMING_MODES)[number]

export interface WorktreeBranchNaming {
  mode: WorktreeBranchNamingMode
  /** The `{prefix}` token. Empty means no prefix. */
  prefix: string
  /** Read only in `custom` mode. */
  template: string
}

export const WORKTREE_BRANCH_TOKENS = ['prefix', 'slug', 'id', 'user'] as const
type WorktreeBranchToken = (typeof WORKTREE_BRANCH_TOKENS)[number]

export const DEFAULT_WORKTREE_BRANCH_NAMING: WorktreeBranchNaming = {
  mode: 'generated',
  prefix: 'solus',
  template: '{prefix}/{slug}',
}

export const worktreeBranchNamingSchema = z.object({
  mode: z.enum(WORKTREE_BRANCH_NAMING_MODES),
  prefix: z.string().max(100),
  template: z.string().max(200),
}).strict()

/** What the server knows when it names a branch. */
export interface WorktreeBranchNamer {
  naming: WorktreeBranchNaming
  /** The git user, already a slug. Null when git has none. */
  user: string | null
}

export interface WorktreeBranchValues {
  /** Eight lowercase hex characters. */
  id: string
  /** Null until a title is generated: `{slug}` then takes the id. */
  slug: string | null
}

const TOKEN_PATTERN = /\{([^{}]*)\}/g
const SHORT_ID_PATTERN = '[0-9a-f]{8}'
/** Survives `cleanBranchName` unchanged, so a rendered sample can become a pattern. */
const ID_SENTINEL = 'qidsentinelq'

function isToken(name: string): name is WorktreeBranchToken {
  return WORKTREE_BRANCH_TOKENS.some((token) => token === name)
}

export function worktreeBranchTemplate(naming: WorktreeBranchNaming): string {
  if (naming.mode === 'static') return '{prefix}/{id}'
  if (naming.mode === 'custom') return naming.template.trim()
  return '{prefix}/{slug}'
}

/** A branch named from a title starts on a temporary name and is renamed
 *  later. Reads the effective naming, so an unusable template answers as the default. */
export function namesFromTitle(naming: WorktreeBranchNaming): boolean {
  return worktreeBranchTemplate(effectiveWorktreeBranchNaming(naming)).includes('{slug}')
}

/** The words of a title as a branch slug, or empty when no usable word is left. */
export function slugifyBranchTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')
}

/**
 * The rules of `git check-ref-format --branch`, so a client can check a name
 * without git and the server does not spawn a process per candidate.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name === '@' || name === 'HEAD' || name.length > 200) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/**
 * Turns any text into a likely branch name: forbidden characters become `-`,
 * repeated separators collapse, and each path part loses the leading dots and
 * the trailing `.lock` git refuses. `isValidBranchName` still has the last word.
 */
export function cleanBranchName(raw: string): string {
  return raw
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x20\x7f~^:?*[\\]+/g, '-')
    .replace(/@\{/g, '-')
    .replace(/\.{2,}/g, '.')
    .split('/')
    .map((part) => part.replace(/^[.-]+/, '').replace(/(\.lock)+$/, '').replace(/-{2,}/g, '-').replace(/[.-]+$/, ''))
    .filter(Boolean)
    .join('/')
}

/** Why a naming cannot be used, or null when it can. Shown in Settings. */
export function worktreeBranchNamingError(naming: WorktreeBranchNaming): string | null {
  const template = worktreeBranchTemplate(naming)
  if (!template) return 'Enter a template.'
  for (const [, token] of template.matchAll(TOKEN_PATTERN)) {
    if (!isToken(token)) return `Unknown token {${token}}. Use {prefix}, {slug}, {id}, or {user}.`
  }
  if (!render(naming, { id: '0a1b2c3d', slug: 'example-title' }, 'user')) {
    return 'The template does not make a valid git branch name.'
  }
  return null
}

/** The naming a host uses: the configured one, or the default when it is not usable. */
export function effectiveWorktreeBranchNaming(naming: WorktreeBranchNaming | null | undefined): WorktreeBranchNaming {
  return naming && !worktreeBranchNamingError(naming) ? naming : DEFAULT_WORKTREE_BRANCH_NAMING
}

function render(naming: WorktreeBranchNaming, values: WorktreeBranchValues, user: string | null): string | null {
  const tokens = {
    prefix: cleanBranchName(naming.prefix),
    slug: values.slug ?? values.id,
    id: values.id,
    user: user ?? '',
  } satisfies Record<WorktreeBranchToken, string>
  let unknownToken = false
  const raw = worktreeBranchTemplate(naming).replace(TOKEN_PATTERN, (_, token: string) => {
    if (isToken(token)) return tokens[token]
    unknownToken = true
    return ''
  })
  if (unknownToken) return null
  const name = cleanBranchName(raw)
  return isValidBranchName(name) ? name : null
}

/**
 * The branch a new worktree starts on. Always a valid name: when the naming
 * cannot make one (for example `{user}` alone with no git user), the default
 * naming makes it, so a session never waits for, or lacks, a branch.
 */
export function initialWorktreeBranchName(namer: WorktreeBranchNamer, id: string): string {
  const values = { id, slug: null }
  return render(effectiveWorktreeBranchNaming(namer.naming), values, namer.user)
    ?? render(DEFAULT_WORKTREE_BRANCH_NAMING, values, null)!
}

/**
 * The branch a generated title becomes, or null when the title has no usable
 * word, the naming does not use a title, or the result is not a valid branch.
 * Null keeps the temporary branch. `id` is the temporary branch's id, so a
 * template with both `{id}` and `{slug}` keeps the same id.
 */
export function generatedWorktreeBranchName(title: string, namer: WorktreeBranchNamer, id: string): string | null {
  const naming = effectiveWorktreeBranchNaming(namer.naming)
  if (!namesFromTitle(naming)) return null
  const slug = slugifyBranchTitle(title)
  if (!slug) return null
  return render(naming, { id, slug }, namer.user)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The id of a branch that is still the temporary name of this naming, with
 * or without a collision suffix, or null for any other branch. Only a
 * temporary branch is renamed: a name a person or agent chose stays. The
 * flat form (`solus-<id>`) counts too: the server uses it when a branch named
 * like a parent segment (`solus`) blocks the namespace.
 */
export function temporaryWorktreeBranchId(branch: string, namer: WorktreeBranchNamer): string | null {
  const naming = effectiveWorktreeBranchNaming(namer.naming)
  if (!namesFromTitle(naming)) return null
  const sample = render(naming, { id: ID_SENTINEL, slug: null }, namer.user)
  if (!sample) return null
  for (const form of new Set([sample, sample.replace(/\//g, '-')])) {
    const [first, ...rest] = escapeRegExp(form).split(ID_SENTINEL)
    // The first id captures; a repeat (`{id}` and `{slug}`) must be the same id.
    const pattern = first + rest.map((part, index) => (index === 0 ? `(${SHORT_ID_PATTERN})` : '\\1') + part).join('')
    const id = new RegExp(`^${pattern}(?:-\\d+)?$`).exec(branch)?.[1]
    if (id) return id
  }
  return null
}

/** An example of the final name, for the Settings preview. */
export function worktreeBranchPreview(naming: WorktreeBranchNaming, user: string | null = 'you'): string {
  const effective = effectiveWorktreeBranchNaming(naming)
  return render(effective, { id: '0a1b2c3d', slug: 'fix-login-redirect' }, user)
    ?? initialWorktreeBranchName({ naming: effective, user }, '0a1b2c3d')
}
