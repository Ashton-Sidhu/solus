import type { IntegrationEnvValue } from '@solus/contracts/integration-types'
import { parseEnvNames } from '@solus/contracts/integrations/command-server'

/**
 * Variables pasted into a name field of the environment variables editor: the
 * lines of a .env file (`NAME=value`, with `export`, quotes, and comments), or
 * a list of names separated by commas or spaces. Null for text that is neither,
 * such as one name: the field takes that as typed.
 */
export function pastedVariables(text: string): IntegrationEnvValue[] | null {
  if (text.includes('=')) return envFileVariables(text)
  const names = parseEnvNames(text)
  return names.ok && names.names.length > 1 ? names.names.map((name) => ({ name, value: '' })) : null
}

function envFileVariables(text: string): IntegrationEnvValue[] | null {
  const variables: IntegrationEnvValue[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) return null
    variables.push({ name: match[1], value: envValue(match[2]) })
  }
  return variables.length > 0 ? variables : null
}

/** A quoted value keeps its text as written; an unquoted one ends at ` #`, where a comment starts. */
function envValue(text: string): string {
  const doubleQuoted = /^"((?:[^"\\]|\\.)*)"/.exec(text)
  if (doubleQuoted) return doubleQuoted[1].replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1')
  const singleQuoted = /^'([^']*)'/.exec(text)
  if (singleQuoted) return singleQuoted[1]
  return text.replace(/\s+#.*$/, '').trim()
}
