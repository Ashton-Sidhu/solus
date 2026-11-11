import { expect, test } from 'bun:test'
import { DEFAULT_VOICE_DICTIONARY, addVoiceTerms, applyVoiceDictionary, decodeVoiceUpload, encodeVoiceUpload, filterVoiceDictionary, parseVoiceDictionary, replaceVoiceTerm, voiceDictionarySchema } from '@solus/contracts/voice-dictionary'
import { personalSettingsDocumentSchema, personalSettingsWithDefaults } from '@solus/contracts/settings'
import { SvelteRunes } from './helpers/svelte-runes'

test('a list keeps preferred spelling and explicit aliases', () => {
  expect(parseVoiceDictionary('  Solus = soul us | sol us\r\n\nTypeScript\nC++ = see plus plus')).toEqual([
    { term: 'Solus', aliases: ['soul us', 'sol us'] },
    { term: 'TypeScript', aliases: [] },
    { term: 'C++', aliases: ['see plus plus'] },
  ])
  expect(parseVoiceDictionary('')).toEqual([])
})

test('replacements use complete phrases and preserve adjacent Unicode words', () => {
  const dictionary = parseVoiceDictionary('Solus = soul us\nC++ = see plus plus\nCafé = coffee shop')
  expect(applyVoiceDictionary('SOUL US, solus, C++ and see plus plus. Coffee shop!', dictionary))
    .toBe('Solus, Solus, C++ and C++. Café!')
  const untouched = 'solusify αsolus solusα _solus solus2 soul user; C++builder'
  expect(applyVoiceDictionary(untouched, dictionary)).toBe(untouched)
  expect(applyVoiceDictionary('sole us', dictionary)).toBe('sole us')
})

test('long phrases win and a replacement cannot start another replacement', () => {
  const dictionary = parseVoiceDictionary('Acme = example\nResult = Acme result')
  expect(applyVoiceDictionary('example result; Acme result', dictionary)).toBe('Acme Result; Result')
})

test('invalid or conflicting entries are refused before saving or transport', () => {
  for (const text of ['Solus =', '= alias', 'Solus = one = two', 'A = same\nB = SAME', 'x'.repeat(81), Array(101).fill('term').join('\n')])
    expect(() => parseVoiceDictionary(text)).toThrow()
  expect(voiceDictionarySchema.safeParse([{ term: 'bad\u0000term', aliases: [] }]).success).toBe(false)
  expect(voiceDictionarySchema.safeParse([{ term: 'term', aliases: Array(9).fill('alias') }]).success).toBe(false)
  expect(voiceDictionarySchema.safeParse([{ term: 'term', aliases: [], unexpected: true }]).success).toBe(false)
})

test('profiles without a saved dictionary start with editable coding terms', () => {
  const defaults = personalSettingsWithDefaults({}).voiceDictionary
  expect(voiceDictionarySchema.parse(defaults)).toEqual(DEFAULT_VOICE_DICTIONARY)
  expect(defaults.map(({ term }) => term)).toEqual([
    'Solus', 'TypeScript', 'JavaScript', 'GitHub', 'Node.js', 'Next.js',
    'PostgreSQL', 'SQLite', 'OpenAI', 'Anthropic', 'Claude', 'Codex',
  ])
  expect(applyVoiceDictionary('soul us uses type script on git hub. The cloud is ready.', defaults))
    .toBe('Solus uses TypeScript on GitHub. The cloud is ready.')
  defaults[0].aliases.push('my alias')
  expect(personalSettingsWithDefaults({}).voiceDictionary[0].aliases).toEqual(['soul us', 'sol us'])
})

test('saved dictionaries override defaults, including an empty dictionary, and can sync', () => {
  expect(personalSettingsWithDefaults({ voiceDictionary: [] }).voiceDictionary).toEqual([])
  const voiceDictionary = parseVoiceDictionary('Solus = soul us')
  expect(personalSettingsWithDefaults({ voiceDictionary }).voiceDictionary).toEqual(voiceDictionary)
  expect(personalSettingsDocumentSchema.parse({ voiceDictionary })).toEqual({ voiceDictionary })
})

test('voice uploads preserve Unicode hints and exact WAV bytes; malformed lengths are refused', () => {
  const wav = Uint8Array.of(82, 73, 70, 70).buffer
  const options = { vocabulary: ['Solus', 'Café', '日本語'] }
  const body = encodeVoiceUpload(wav, options)
  const upload = decodeVoiceUpload(body)
  expect(upload.options).toEqual(options)
  expect([...upload.wav]).toEqual([...new Uint8Array(wav)])
  expect(() => decodeVoiceUpload(body.subarray(0, 3))).toThrow()
  new DataView(body.buffer).setUint32(0, 0xffffffff, true)
  expect(() => decodeVoiceUpload(body)).toThrow('length')
})

test('a pasted list adds new terms first and merges phrases into a term already saved', () => {
  const saved = parseVoiceDictionary('Solus = soul us\nClaude')
  expect(addVoiceTerms(saved, 'Bun\nsolus = sol us\nBun = bun js')).toEqual([
    { term: 'Bun', aliases: ['bun js'] },
    { term: 'Solus', aliases: ['soul us', 'sol us'] },
    { term: 'Claude', aliases: [] },
  ])
  expect(saved[0].aliases).toEqual(['soul us'])
})

test('a pasted list that breaks a rule changes nothing', () => {
  const saved = parseVoiceDictionary('Solus = soul us')
  expect(() => addVoiceTerms(saved, 'Soul = soul us')).toThrow('more than one preferred spelling')
  expect(() => addVoiceTerms(saved, 'a = b = c')).toThrow('one =')
  const full = parseVoiceDictionary(Array.from({ length: 100 }, (_, index) => `term ${index}`).join('\n'))
  expect(() => addVoiceTerms(full, 'one more')).toThrow('up to 100 terms')
})

test('an edit names its term, so a term that sync removed or a taken name is refused', () => {
  const saved = parseVoiceDictionary('Solus = soul us\nClaude')
  expect(replaceVoiceTerm(saved, 'Solus', { term: ' Solus Pro ', aliases: ['soul us', ' soul us ', 'sol us'] })[0])
    .toEqual({ term: 'Solus Pro', aliases: ['soul us', 'sol us'] })
  expect(() => replaceVoiceTerm(saved, 'Gone', { term: 'Gone', aliases: ['x'] })).toThrow('no longer')
  expect(() => replaceVoiceTerm(saved, 'Claude', { term: 'solus', aliases: [] })).toThrow('already in your dictionary')
  expect(() => replaceVoiceTerm(saved, 'Claude', { term: 'Claude', aliases: ['SOUL US'] })).toThrow('more than one preferred spelling')
  expect(() => replaceVoiceTerm(saved, 'Claude', { term: ' ', aliases: [] })).toThrow('Enter a term')
})

test('the filter finds a term by its spelling or by what dictation writes', () => {
  const saved = parseVoiceDictionary('Solus = soul us\nClaude')
  expect(filterVoiceDictionary(saved, ' SOUL ').map(({ term }) => term)).toEqual(['Solus'])
  expect(filterVoiceDictionary(saved, 'clau').map(({ term }) => term)).toEqual(['Claude'])
  expect(filterVoiceDictionary(saved, '')).toBe(saved)
})

test('the settings rows save each edit, keep the saved list after a refused one, and show the error on its row', async () => {
  const runes = new SvelteRunes()
  try {
    const source = runes.source('dictionary-editor', 'packages/workspace-ui/src/components/settings/lib/voice-dictionary-editor.svelte.ts', {
      '@solus/contracts/voice-dictionary': SvelteRunes.file('packages/contracts/src/voice-dictionary.ts'),
    })
    const { VoiceDictionaryEditor } = await import(source)
    let current = parseVoiceDictionary('Solus = soul us\nClaude')
    const editor = new VoiceDictionaryEditor(() => current, (entries: typeof current) => { current = entries; return true })

    expect(editor.addAlias('Claude', 'soul us')).toBe(false)
    expect(editor.error).toEqual({ term: 'Claude', message: '“soul us” has more than one preferred spelling' })
    expect(current).toEqual(parseVoiceDictionary('Solus = soul us\nClaude'))

    editor.query = 'zzz'
    expect(editor.add('Bun')).toBe(true)
    expect(editor.error).toBeNull()
    expect(editor.query).toBe('')
    expect(editor.visible[0].term).toBe('Bun')

    expect(editor.rename('Solus', 'Solus')).toBe(true)
    expect(editor.rename('Solus', 'Solus Pro')).toBe(true)
    expect(editor.removeAlias('Solus Pro', 'soul us')).toBe(true)
    expect(editor.remove('Bun')).toBe(true)
    expect(editor.remove('Claude')).toBe(true)
    expect(current).toEqual([{ term: 'Solus Pro', aliases: [] }])
    expect(editor.remove('Solus Pro')).toBe(true)
    expect(current).toEqual([])
  } finally { runes.dispose() }
})
