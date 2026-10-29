# Work Git storage

Local works keep draft content in the database and archive versions in a bare Git repository under the host's configured data directory. Published works use the cloud's selected storage adapter. Sharing follows the same access rules for both adapters.

## Sub-features

- Native Git history for documents, diagrams, slides, and HTML works.
- Existing local history moves to Git without changing content versions.
- Local history survives a host restart and is retained on publication.
- Members and guests read shared works; editors can save; viewers and other organizations cannot.
- Stale saves are refused, revoked links cannot reconnect, and deletion removes the repository.

## How to get to it (user POV)

Create and edit a local work, open its version history, then publish it to an organization and use its Share action.

## Driving it with the Lab

- Run `bun lab build`, then the doctor.
- `bun lab run work-git-storage --host personal` tests local Git on the source and destination. It uses disposable data directories and stops its hosts.
- To use a real Cloudflare destination, set `SOLUS_LAB_ARTIFACTS=1`, `SOLUS_LAB_ARTIFACTS_ACCOUNT_ID`, `SOLUS_LAB_ARTIFACTS_NAMESPACE`, and `SOLUS_LAB_ARTIFACTS_TOKEN` in the process environment. Supply the token from the credential store in memory; never put it in command arguments or evidence. Only the isolated API service gets the production storage settings.
- Run `bun lab run all` for the broader multiplayer regression checks.
- Evidence: the printed PASS/FAIL checks and `.solus-local/lab-cloud/evidence/work-git-<time>/` logs.

## Gotchas

- A stale save returns `STALE_VERSION`. The source of a published work returns `MOVED`; it does not return null.
- Archive completion is asynchronous for edits. The scenario waits for the accepted generation, not an arbitrary delay. Publication waits for archive acceptance before returning.
- Real Cloudflare tests create synthetic repositories. Cleanup deletes only those repositories and checks the 404 response.
- A Git repository is an internal work archive, not a code checkout. Editing it outside Solus is not supported.
