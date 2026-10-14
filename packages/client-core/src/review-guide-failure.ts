/** A guide failure as people read it: one plain sentence, and the raw error
 *  for anyone who opens the details. `details` is null when the summary
 *  already is the whole error. */
export interface GuideFailure {
  summary: string
  details: string | null
}

const FALLBACK = 'The guide could not be written.'

// The revision a checkout asked for is gone from the remote: the pull request
// was force-pushed after this client loaded it.
const GONE_REVISION = /not our ref|no such commit|bad object|unadvertised object/i
const ACCESS_DENIED = /authentication failed|repository not found|requested URL returned error: (401|403|404)|could not read (Username|Password)|invalid username or (password|token)/i

export function describeGuideFailure(error: string): GuideFailure {
  const raw = error.trim()
  if (!raw) return { summary: FALLBACK, details: null }
  if (GONE_REVISION.test(raw)) {
    return { summary: 'This pull request changed after Solus loaded it. Refresh the pull request, then try again.', details: raw }
  }
  if (ACCESS_DENIED.test(raw)) {
    return { summary: 'Solus could not read this repository. Check the git provider connection, then try again.', details: raw }
  }
  if (raw.startsWith('Command failed:')) {
    return { summary: 'A git command failed while Solus prepared the changes.', details: raw }
  }
  // A short, one-line message is already written for people.
  if (raw.length <= 160 && !raw.includes('\n')) return { summary: raw, details: null }
  return { summary: FALLBACK, details: raw }
}
