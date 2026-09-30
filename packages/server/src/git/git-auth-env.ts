import { sshConnectionOptions } from '../transport/handlers/lib/ssh-options'
import { writeTempSecretScript } from '../transport/handlers/lib/temp-secret-script'

/**
 * How Solus hands git a credential for one command. Shared by every git
 * operation that talks to a remote — cloning during host setup and pushing a
 * newly published repository — so the token never reaches argv, the remote
 * URL, or `.git/config` by exactly one rule rather than several copies of it.
 */

/**
 * `GIT_ASKPASS` is called once per prompt with the prompt text as argv[1]; the
 * answer goes to stdout. Keeping both values in the environment means the
 * token never reaches argv, the remote URL, or `.git/config`.
 */
const GIT_ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*|username*) printf '%s\\n' "$SOLUS_GIT_USERNAME" ;;
  *) printf '%s\\n' "$SOLUS_GIT_PASSWORD" ;;
esac
`

/**
 * A 0700 temp helper that feeds git the selected HTTPS token. Callers write it
 * per command and remove its directory in a `finally`, so no credential
 * outlives the process.
 */
export async function createGitAskpassHelper(): Promise<{ directory: string; path: string }> {
  return writeTempSecretScript('solus-git-askpass-', 'git-askpass.sh', GIT_ASKPASS_SCRIPT)
}

/**
 * The exact variables Solus sets for a remote-touching git command. A type
 * alias rather than an interface so it still satisfies the `ProcessEnv`-shaped
 * parameters of the process helpers that consume it.
 */
export type GitAuthEnv = {
  GIT_TERMINAL_PROMPT: string
  /** Set only when a token was written to an askpass helper for this command. */
  GIT_ASKPASS?: string
  SOLUS_GIT_USERNAME?: string
  SOLUS_GIT_PASSWORD?: string
  /** Set only for SSH remotes. */
  GIT_SSH_COMMAND?: string
  /** Set only with `isolateHelpers`: clears every credential helper git would ask before the askpass. */
  GIT_CONFIG_COUNT?: '1'
  GIT_CONFIG_KEY_0?: 'credential.helper'
  GIT_CONFIG_VALUE_0?: ''
}

export interface GitAuthEnvOptions {
  /** The remote is being reached over HTTPS rather than SSH. */
  isHttps: boolean
  /** The HTTPS token to answer prompts with, when there is one. */
  token: string | null
  /** Path from `createGitAskpassHelper`, when one was written for this command. */
  askpassPath: string | null
  /**
   * Git asks configured credential helpers before the askpass, so a helper the
   * host configured would answer first. Set when the command acts for someone
   * other than the host.
   */
  isolateHelpers?: boolean
}

/**
 * The environment for one remote-touching git command. An askpass helper wins
 * when a token was written for it; otherwise HTTPS merely refuses to prompt,
 * and SSH gets Solus's standard connection options.
 */
export function gitAuthEnv(options: GitAuthEnvOptions): GitAuthEnv {
  const helpers: Pick<GitAuthEnv, 'GIT_CONFIG_COUNT' | 'GIT_CONFIG_KEY_0' | 'GIT_CONFIG_VALUE_0'> = options.isolateHelpers
    ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' }
    : {}
  if (options.askpassPath && options.token) {
    return {
      GIT_ASKPASS: options.askpassPath,
      GIT_TERMINAL_PROMPT: '0',
      SOLUS_GIT_USERNAME: 'x-access-token',
      SOLUS_GIT_PASSWORD: options.token,
      ...helpers,
    }
  }
  if (options.isHttps) return { GIT_TERMINAL_PROMPT: '0', ...helpers }
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `ssh ${sshConnectionOptions().join(' ')}`,
    ...helpers,
  }
}
