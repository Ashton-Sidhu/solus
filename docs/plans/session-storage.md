# Session storage on Artifacts and R2

Status: proposed.

A host keeps a session repository for each session, so that a second host can
continue it. This plan changes its format so that the cloud copy fits Cloudflare
Artifacts, moves code bundles to R2, and makes the transfer between two hosts a
stream. After it ships, `SOLUS_SESSION_STORAGE` can turn on in production.

## 1. Problem

The session repository has one commit for each ended turn: `manifest.json`, the
new bytes of each provider file (`threads/<threadId>/<key>/<turn>`), and the code
bundle of the turn (`code/<turn>.bundle`, `git/session-code-bundle.ts`).
`SessionPusher` (`sync/sessions/session-push.ts`) pushes the head with all the
commits that are not pushed.

We measured Artifacts on 2026-11-26 with the Solus push code, in a test
namespace:

| Limit | Result |
| --- | --- |
| One file | Refused above 32 MiB (`artifacts_git_receive_pack_object_too_large`). A random file of 32 MiB less 1 KiB was refused too (`zlib member compressed data exceeds maximum`). 31 MiB was accepted. |
| One push | Refused above 64 MiB (`artifacts_git_receive_pack_request_too_large`). 60 MiB was accepted. |
| One repository | Not enforced: 1,215 MiB was accepted. The docs say 1 GB for a repository made after 2026-09-29. |
| Repository size | The REST API gives no size. |
| Push time | About 3 to 5 s for 27 MiB from a home connection. |
| Fetch | 8.6 s for 324 MiB; 1.6 s with `--filter=blob:none`. |

The format breaks these limits in four places:

1. A code bundle is one file of up to 200 MB (`CODE_BUNDLE_MAX_BYTES`).
2. The first part of a provider file holds every byte up to the first archived
   turn. For a long thread, that is hundreds of MB in one file.
3. A host pushes all commits that are not pushed in one push. After time offline,
   or on the first push of an older session, that is more than 64 MiB.
4. A refused push reports `transport`, so `SessionPusher` retries it with backoff
   forever.

Code bundles are compressed Git packs and are written once. Git cannot delta or
dedupe them, and a history of them is not useful. They are most of the bytes of a
repository. Object storage is the right place for them.

The transfer between two hosts (`sessionRepositoryBundle` and
`sessionRepositoryBundleChunk`) sends 1 MiB base64 chunks over the WebSocket.
Each chunk costs one round trip and 33% more bytes, and it blocks the live events
on the same socket.

## 2. Decisions

1. **Code bundles leave the commit.** On a host, each bundle is a blob under its
   own ref. In Solus Cloud, it is an object in R2. The manifest names it by its
   SHA-256.
2. **Provider files are written in pieces of at most 31 MiB.**
3. **A commit adds at most 48 MiB of new files.** The writer writes a larger turn
   as several commits. Only the last commit of a turn changes the manifest.
4. **A host pushes one commit at a time.**
5. **The three refusal texts of Artifacts are permanent errors.** The host stops
   the push of that session and records why.
6. **The manifest goes to `schemaVersion: 2`.** A reader reads 1 and 2. A host
   pushes only a repository whose first commit is version 2. An older session
   stays on its host and moves only by the host path.
7. **The Solus API refuses a host that does not send `format: 2`.** It answers
   `503 storage_unavailable`, which an older host reads as unavailable and retries
   in one hour.
8. **Two hosts transfer a session as one HTTP stream.** The chunk RPC stays for one
   release, for a peer that does not have the stream, and then goes.
9. **A host counts the bytes that it pushed for each session.** It stops at
   900 MiB with a clear error, in case Artifacts starts to enforce 1 GB.
10. **One switch.** `SOLUS_SESSION_STORAGE=cloudflare-artifacts` needs both
    Artifacts and R2. `local-git` uses bare repositories and a folder on the API
    machine. `off` turns both off.
11. **Retention is not part of this plan.** Each R2 key starts with the cloud scope
    and the session id, so a later delete can remove a session by prefix.

The setting **Save sessions to Solus Cloud** (`sessionCloudCopyRefusal`) governs
the R2 upload exactly as it governs the push now. Nothing is uploaded that would
not have been pushed.

## 3. Manifest version 2

`sync/sessions/session-manifest.ts`:

- `schemaVersion: z.union([z.literal(1), z.literal(2)])`.
- A thread file in version 2 lists `parts` as names: `"<turn>.<piece>"`. Each name
  is a file `threads/<threadId>/<key>/<turn>.<piece>` of at most 31 MiB. A reader
  joins the parts in order. A version 1 part stays a number.
- The code bundle of a turn in version 2 is
  `{ kind: 'stored', sha256, bytes, refs }`. It replaces `written`. `empty`,
  `too-large`, and `failed` stay.

`SessionRepository.writeThreadFile` reads both forms.

## 4. The host's local repository

`sync/sessions/session-archive-writer.ts` and `session-repository.ts`:

- The writer stores the bundle as a blob, in a commit whose tree is the one file
  `bundle`, under `refs/solus/code/<sha256>`. The ref keeps the object. `main`
  does not reach it, so a push of `main` never sends it.
- The writer splits a provider file range into pieces of 31 MiB.
- When the new files of a turn pass 48 MiB, the writer writes several commits.
  Each commit before the last adds pieces and keeps the manifest of the turn
  before. The last commit writes the manifest. A reader of any head reads a
  manifest whose files all exist.
- `restoreSessionCode` (`git/session-code-restore.ts`) reads each bundle from its
  code ref.

## 5. The push

`sync/sessions/session-push.ts`:

1. For each commit from `pushed_head` to `head`, in order
   (`git rev-list --reverse`):
   1. For each `stored` bundle that the commit's manifest adds: ask the Solus API
      for a signed upload URL, and upload the blob from its code ref with `PUT`.
      An upload of a hash that is already there is safe to repeat.
   2. Push that one commit with the checked push (`SessionRepository.push`).
   3. Write `pushed_head` and add the commit's bytes to `pushed_bytes`.
2. Report the head (`reportHead`) only after a commit that writes a manifest.
3. A push or an upload refused with `artifacts_git_receive_pack_object_too_large`,
   `artifacts_git_receive_pack_request_too_large`, or
   `zlib member compressed data exceeds maximum` sets `push_refused_head` with the
   reason. `GitRemote.checkedPush` must return the remote's text to do this; now
   it returns only `transport`.
4. `pushed_bytes` above 900 MiB stops the push with the reason "This session is
   too large for the cloud copy."
5. `resume()` skips a repository whose first commit is version 1.

New columns on `session_storage`: `pushed_bytes`, and `push_error` already holds
the reason.

## 6. The Solus API

`transport/session-repository-routes.ts`:

- The token request gets `format: 2`. A request without it gets
  `503 storage_unavailable`.
- A new route, `POST /runner/session-repositories/code`, with
  `{ hostId, sessionId, sha256, bytes, access }`. It uses the same `admit` as the
  token route. It answers a URL that lasts 15 minutes. For `write`, it refuses
  `bytes` above `CODE_BUNDLE_MAX_BYTES`.
- The key is `sessions/<cloudScope>/<sessionId>/<sha256>`.

A new seam beside `RepositoryProvider` (`sync/git-storage/`):

```ts
interface ObjectStore {
  readonly storageScope: string
  signedUrl(key: string, access: 'read' | 'write', facts: { bytes: number; sha256: string }): Promise<string>
}
```

- **R2:** an S3 SigV4 signed URL for
  `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`. Settings:
  `SOLUS_SESSION_R2_BUCKET`, `SOLUS_R2_ACCESS_KEY_ID`, `SOLUS_R2_SECRET_ACCESS_KEY`,
  and the account from `SOLUS_ARTIFACTS_ACCOUNT_ID`.
- **Local folder:** for `local-git`. The files are under
  `<dataDir>/sessions/cloud-code/`. The API serves `PUT` and `GET` at
  `/runner/session-code/<key>` with an HMAC signature in the query, from the API
  signing key.

`sessionRemoteProvider` (`sync/sessions/session-remote-provider.ts`) makes both
from the one switch, and refuses a missing R2 setting at startup.

## 7. Fetch from the cloud

`execution/sessions/session-artifacts-source.ts` and `session-sync.ts`:

1. Fetch `main` from Artifacts, as now.
2. For each `stored` bundle in the manifest that Host B has no code ref for: ask
   for a signed read URL, download it, check its size and SHA-256, and write it
   under `refs/solus/code/<sha256>`.
3. Restore as now.

A missing object or a hash that does not match fails the sync with `code-restore`.

## 8. Transfer between two hosts

`sync/sessions/session-bundle-transfers.ts`, `execution/sessions/session-bundle-source.ts`,
`transport/http.ts`:

1. `sessionRepositoryBundle` (on the WebSocket, `drive.prompt`, as now) writes a
   Git bundle of `main` after `have`, with the code refs of the turns after `have`.
   It answers `transferId`, `size`, `head`, and a new `downloadSecret`: 32 random
   bytes, kept as a hash, for this one transfer.
2. Host B sends `GET /session-bundles/<transferId>` to the route that the host link
   uses, with `Authorization: Bearer <downloadSecret>`. Host A streams the file. It
   supports `Range`, so a dropped stream continues from its last byte.
3. The secret ends with the transfer: when the file is read to its end, or after
   10 minutes with no read. It is never in a URL, so no log records it.
4. A route that answers `404` is an older host. Host B then uses the chunk RPC.

This is a download, so the Cloudflare upload limit for a request body does not
apply to the tunnel route.

## 9. Turn-on order

1. **Solus:** ship sections 3 to 8 with their tests. Hosts on this release write
   version 2.
2. **solus-cloud:**
   - create the R2 bucket `solus-sessions-prod`;
   - make an R2 API token with object read and write on that bucket only;
   - put the token's keys in Worker secrets and pass them to the container in
     `cloud-worker/src/application-env.ts`, as the Artifacts token is passed now;
   - add `SOLUS_SESSION_R2_BUCKET` to `cloud-worker/wrangler.jsonc`.
3. **Live check:** run the 2026-11-26 check again, in a test namespace and a test
   bucket. Add a 200 MB code bundle, a 300 MB first provider file, and a catch-up
   of 10 turns. Each must succeed.
4. **Pin:** move `release-inputs.json` to a Solus commit with this plan, and deploy
   with storage still `off`. Check `/readyz`.
5. **Turn on:** set `SOLUS_SESSION_STORAGE` to `cloudflare-artifacts` and deploy.
   Continue a disposable session on a second host from the cloud copy, with the
   first host off.

After step 5, each updated host pushes its version 2 sessions (`resume()`), one
commit at a time. An older host gets `503` and waits.

## 10. Tests

- The writer splits a 70 MiB provider range into three pieces of at most 31 MiB,
  and a reader joins them to the same bytes.
- A turn with 100 MiB of new files becomes three commits. Only the last changes
  the manifest, and the manifest at each head names only files that exist.
- A bundle is under `refs/solus/code/<sha256>`, and a push of `main` does not send
  it.
- The pusher pushes five commits one at a time, uploads each bundle before its
  commit, and reports the head once.
- Each of the three refusal texts sets `push_refused_head`, and the pusher does
  not retry.
- `pushed_bytes` above 900 MiB stops the push.
- The token route answers `503` with no `format`.
- The code route refuses a key outside the caller's session, and a write above
  `CODE_BUNDLE_MAX_BYTES`.
- The local folder store accepts a `PUT` with a good signature, and refuses an old
  or changed one.
- A fetch rejects a bundle whose hash does not match.
- The stream route refuses a wrong secret, serves a `Range`, and refuses the
  secret after the transfer ends.
- Lab: `portable-sessions` with `SOLUS_SESSION_STORAGE=local-git`. Continue a
  session with a 40 MiB bundle on a second host with the first host off.

## 11. Open questions

1. **A checked upload.** Can an R2 signed `PUT` include the SHA-256 and the length
   in its signature, so that R2 refuses other bytes? If not, the reader's hash
   check (section 7) is the only check.
2. **R2 price.** Check the current R2 price before step 5. The design does not
   depend on it.
3. **Retention.** When does a session repository and its objects go: with the
   session, with the account, or after a time? No code removes a session
   repository now.
