/** The words the GitHub, Google, and Atlassian sections share with the seats. Pure, so every surface says the same thing. */

export type CloudConnectionProvider = 'github' | 'google' | 'atlassian'

const PROVIDER_NAMES = {
  github: 'GitHub',
  google: 'Google',
  atlassian: 'Atlassian',
} satisfies Record<CloudConnectionProvider, string>

/**
 * The line under a provider section's name. On a cloud row the connection is the
 * person's own and every runner of the organization reads it for their turns; on
 * a machine host the section has no line, as before.
 */
export function connectionSectionDescription(provider: CloudConnectionProvider, isCloudHost: boolean): string | undefined {
  if (!isCloudHost) return undefined
  return `Your own ${PROVIDER_NAMES[provider]} connection. Every runner uses it for your turns only.`
}
