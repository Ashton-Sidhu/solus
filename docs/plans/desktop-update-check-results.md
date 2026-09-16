# Desktop update check results

The desktop update store reports a manual check result only after a new status
event arrives from the native shell. The previous status must not produce a
toast when the user starts another check.

A fresh up-to-date or error event completes the pending check and supplies its
result. Finding, downloading, or preparing a release also completes the check;
the existing release prompts then apply. A later download failure or background
check must not produce a manual check failure toast.

Settings and the shared Check for Updates command use this same store. This
behavior applies to the desktop app binary. Web and mobile do not expose the
native updater; connected host and provider checks use the separate host update
store.

Regression coverage: `tests/unit/desktop-updates-store.test.ts`.
