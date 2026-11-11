import { z } from 'zod'

export const VOICE_DICTIONARY_LIMIT = 100

const phraseKey = (phrase: string) => phrase.trim().normalize('NFC').toLowerCase()

const termSchema = z.string().trim().min(1, 'Enter a term').max(80, 'A term can have up to 80 characters').regex(/^[^\r\n=|\p{Cc}]+$/u, 'Terms cannot contain =, |, or control characters')
export const voiceDictionarySchema = z.array(z.object({
  term: termSchema,
  aliases: z.array(termSchema).max(8, 'A term can have up to 8 phrases'),
}).strict()).max(VOICE_DICTIONARY_LIMIT, `A dictionary can have up to ${VOICE_DICTIONARY_LIMIT} terms`).superRefine((entries, context) => {
  const owners = new Map<string, string>()
  for (const entry of entries) for (const phrase of [entry.term, ...entry.aliases]) {
    const key = phraseKey(phrase)
    const owner = owners.get(key)
    if (owner && owner !== entry.term) context.addIssue({ code: 'custom', message: `“${phrase}” has more than one preferred spelling` })
    owners.set(key, entry.term)
  }
})
export type VoiceDictionary = z.infer<typeof voiceDictionarySchema>

/** Editable starting terms. Keep aliases specific so ordinary speech is preserved. */
export const DEFAULT_VOICE_DICTIONARY: VoiceDictionary = [
  { term: 'Solus', aliases: ['soul us', 'sol us'] },
  { term: 'TypeScript', aliases: ['type script'] },
  { term: 'JavaScript', aliases: ['java script'] },
  { term: 'GitHub', aliases: ['git hub'] },
  { term: 'Node.js', aliases: ['node js'] },
  { term: 'Next.js', aliases: ['next js'] },
  { term: 'PostgreSQL', aliases: [] },
  { term: 'SQLite', aliases: [] },
  { term: 'OpenAI', aliases: [] },
  { term: 'Anthropic', aliases: [] },
  { term: 'Claude', aliases: [] },
  { term: 'Codex', aliases: [] },
]

function validVoiceDictionary(entries: VoiceDictionary): VoiceDictionary {
  const parsed = voiceDictionarySchema.safeParse(entries)
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  return parsed.data
}

/** Reads one term per line, with `=` before its phrases and `|` between them. */
export function parseVoiceDictionary(text: string): VoiceDictionary {
  return validVoiceDictionary(text.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const [term, ...rest] = line.split('=')
    if (rest.length > 1) throw new Error('Use one = per line')
    return { term: term.trim(), aliases: rest.length ? rest[0].split('|').map(alias => alias.trim()) : [] }
  }))
}

/** New terms go first, where the person can see them. A term already in the
 * list keeps its spelling and place and gains the new phrases. */
export function addVoiceTerms(entries: VoiceDictionary, text: string): VoiceDictionary {
  const kept = entries.map(entry => ({ ...entry }))
  const added: VoiceDictionary = []
  for (const entry of parseVoiceDictionary(text)) {
    const same = [...added, ...kept].find(({ term }) => phraseKey(term) === phraseKey(entry.term))
    if (same) same.aliases = [...new Set([...same.aliases, ...entry.aliases])]
    else added.push(entry)
  }
  return validVoiceDictionary([...added, ...kept])
}

/** Finds the entry by its term, so a change that sync moved or removed cannot land on another row. */
export function replaceVoiceTerm(entries: VoiceDictionary, term: string, replacement: VoiceDictionary[number]): VoiceDictionary {
  if (!entries.some(entry => entry.term === term)) throw new Error('This term is no longer in your dictionary')
  const duplicate = entries.find(entry => entry.term !== term && phraseKey(entry.term) === phraseKey(replacement.term))
  if (duplicate) throw new Error(`“${duplicate.term}” is already in your dictionary`)
  const aliases = [...new Set(replacement.aliases.map(alias => alias.trim()))]
  return validVoiceDictionary(entries.map(entry => entry.term === term ? { term: replacement.term, aliases } : entry))
}

export function filterVoiceDictionary(entries: VoiceDictionary, query: string): VoiceDictionary {
  const key = phraseKey(query)
  if (!key) return entries
  return entries.filter(({ term, aliases }) => [term, ...aliases].some(phrase => phraseKey(phrase).includes(key)))
}

/** One pass: replacements cannot trigger other replacements. Match complete
 * phrases, including punctuation in terms such as C++, with Unicode boundaries. */
export function applyVoiceDictionary(text: string, entries: VoiceDictionary): string {
  const replacements = new Map<string, string>()
  for (const { term, aliases } of entries) for (const phrase of [term, ...aliases])
    replacements.set(phrase.toLowerCase(), term)
  if (!replacements.size) return text
  const alternatives = [...replacements.keys()].sort((a, b) => b.length - a.length)
    .map(phrase => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{M}\\p{N}_])`, 'giu')
  return text.replace(pattern, match => replacements.get(match.toLowerCase()) ?? match)
}

export const voiceTranscriptionOptionsSchema = z.object({
  vocabulary: z.array(termSchema).max(100),
}).strict()
export type VoiceTranscriptionOptions = z.infer<typeof voiceTranscriptionOptionsSchema>

// An upload with hints has a bounded JSON prefix before its WAV. Keeping the
// terms out of HTTP headers avoids header-size limits and carries Unicode.
export const VOICE_UPLOAD_CONTENT_TYPE = 'application/vnd.solus.voice'
export const MAX_VOICE_OPTIONS_BYTES = 40_000
export function encodeVoiceUpload(wav: ArrayBuffer, options: VoiceTranscriptionOptions) {
  const metadata = new TextEncoder().encode(JSON.stringify(voiceTranscriptionOptionsSchema.parse(options)))
  if (metadata.length > MAX_VOICE_OPTIONS_BYTES) throw new Error('Voice vocabulary is too large')
  const body = new Uint8Array(4 + metadata.length + wav.byteLength)
  new DataView(body.buffer).setUint32(0, metadata.length, true)
  body.set(metadata, 4)
  body.set(new Uint8Array(wav), 4 + metadata.length)
  return body
}

export function decodeVoiceUpload(body: Uint8Array) {
  if (body.length < 4) throw new Error('Invalid voice upload')
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true)
  if (length > MAX_VOICE_OPTIONS_BYTES || length > body.length - 4) throw new Error('Invalid voice vocabulary length')
  const options = voiceTranscriptionOptionsSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(4, 4 + length))))
  return { options, wav: body.subarray(4 + length) }
}
