import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useMemberSwitch } from '@solus/server/cli-env'

/**
 * macOS cannot make users: a stand-in for the image's member switch
 * (docs/plans/member-isolation.md §2 decision 1) that keeps its form
 * (`<uid> -- <command> [args]`) and runs the command as the test's own user.
 * Imported for its effect: it installs the stand-in, as a users file's `layout.switch` would.
 */
const directory = mkdtempSync(join(tmpdir(), 'solus-member-switch-'))
export const MEMBER_SWITCH = join(directory, 'solus-switch')
writeFileSync(MEMBER_SWITCH, '#!/bin/sh\n[ "$2" = "--" ] || exit 126\nshift 2\nexec "$@"\n', { mode: 0o755 })
useMemberSwitch(MEMBER_SWITCH)
