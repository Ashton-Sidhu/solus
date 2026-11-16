# Live Activity push updates

The iOS Live Activity card (Lock Screen, Always-On Display, Dynamic Island) shows the
agent work this phone knows. Before this change only the app updated the card. When iOS
suspended the app, a session that finished on a host stayed "Working" on the card until
the stale date (10 minutes) marked it "Out of date".

Now the hosts update the card while the app is suspended, through the control plane and
APNs. This is the T3 Code model (a relay builds the card), with one difference: Solus
hosts are on many machines, so each host reports only its own rows and the control plane
merges them.

## Vocabulary

- **card** — the one Live Activity of a phone (`AgentActivityCard` in
  `packages/contracts/src/uplink.ts`). It has at most five **rows**, one per session.
- **push token** — the APNs token iOS gives for one card. It can change while the card
  lives.
- **generation** — the phone's clock when it gave the hosts a card. A higher generation
  replaces a lower one.
- **relay** — the control plane's owner of cards: `src/lib/server/live-activities/` in
  `solus-cloud`.

## Flow

1. The phone starts the card with push enabled (`enablePushNotifications` in
   `apps/mobile/app.json`). When iOS gives the push token, and each time the card
   changes, the phone calls `liveActivityRegister` on each host with the token, the
   card, the generation, and the phone's id for that host
   (`apps/mobile/src/features/live-activity/`).
2. The host keeps the rows that are its own (`packages/server/src/host/live-activity-relay.ts`).
   When one of those sessions changes status, it maps the status to a row with
   `agentActivityRowStatus` (`packages/contracts/src/live-activity.ts`, which the phone
   uses too). Then it sends `PUT /v1/hosts/:hostId/live-activities` with its control
   token: the card, its generation, and its own rows. A burst of statuses in 300 ms is
   one report. If the phone's card shows a status that is out of date, the host
   corrects it at registration. Every 5 minutes the host also reports each card on which
   one of its sessions is still live, so a long turn with no new status does not go stale.
3. The relay keeps the newest card of each push token. It replaces the rows that the
   host reported, counts the live rows again, and sends the card to APNs if the content
   changed. While a session is live it sends `update` with a 10-minute stale date. When
   no session is live it sends `end`, and stops sending for that card. A live card that
   did not change is sent again when its last push is 4 minutes old or more, to move the
   stale date.
4. When a row changes to a phase that needs the person, the push has an `alert` with a
   sound and priority 10: "Needs approval", "Needs input", "Failed", or "Done", with the
   session title as the body. The most urgent change gives the alert. The `end` push also
   has priority 10. All other pushes (Working, Background, Rate limited, stale-date
   refreshes) have priority 5, because iOS limits priority-10 Live Activity pushes.
5. When the card ends on the phone, or the token changes, the phone calls
   `liveActivityUnregister`.

Reports are serialized in the host, with the newest pending state sent after an
in-flight report completes. A refused report or network failure stays pending and
retries after 30 seconds, including a terminal result; it does not depend on another
session event. Persisted cards are reported at host startup. The cloud returns
`503 push_delivery_failed` when APNs refuses a push, so the host can retain it.
After a cloud restart, the first report uses the original card's update time to
decide whether a freshness push is due, rather than treating receipt of an old
card as a fresh update on the phone.

The phone continues to update the card while the app runs. A push and a local update can
both arrive; they carry the same content.

## Decisions

- **Expiry offers a quiet refresh action.** At the ten-minute stale date, unfinished
  rows show "Check status" and the Lock Screen headline becomes "Tap to refresh".
  Compact and minimal Dynamic Island presentations show the refresh symbol; expanded
  count labels become "Refresh". A tap opens an unconfirmed session in Solus, where
  the normal foreground refresh renews the card. Confirmed Done and Failed rows keep
  their outcomes. This is an approved departure from T3's "Out of date" wording.
  The freshness deadline remains: an old card must not claim work is still running.
  This is a fallback for interrupted delivery, not the normal update flow. The
  host and cloud must update the card automatically while the app is suspended.
- **The relay merges rows by host.** One host does not know the other hosts' sessions.
  If each host sent the full card, a host could overwrite another host's newer row. A
  host changes only rows with its id (`hostId` is the phone's id for the host).
- **A host does not add rows.** A session that starts while the phone is suspended does
  not appear on the card until the app runs. The card counts it if the phone counted
  it (`activeCount` above the live rows), so the card does not end early.
- **The host saves its registrations; the relay keeps cards in memory.** A card lives at
  most eight hours. A suspended phone cannot register again, so the host writes its
  registrations to `live-activities.json` in its data directory (mode 600: it holds push
  tokens). Each report carries the card, so a restarted relay learns it again from the
  next report.
- **APNs environment.** A debug build reports `sandbox`, a release build `production`.
  If APNs answers `BadDeviceToken`, the relay tries the other gateway once and keeps the
  one that worked. A token that APNs refuses with `410` or `BadDeviceToken` gets no more
  pushes.
- **Permission.** `liveActivityRegister` and `liveActivityUnregister` need
  `host.sessions.read`: the card shows statuses of sessions the caller can list.

## Limits

- The Lock Screen card uses ActivityKit's system background material and hierarchical
  text colors, as T3 does on hosts without its Liquid Glass extension. Solus's default
  light and dark palette still supplies the status colors. The widget extension does
  not follow the app's appearance override. A white card can be the system's light
  appearance; it does not by itself indicate a stale card.
- A host that is not registered with the control plane (no `HostRegistration`) cannot
  report. Its rows go stale as before.
- Without APNs credentials the relay answers `503 push_not_configured`, and the card
  changes only while the app runs.
- Android has no Live Activity. Desktop and web have no card. Claude and Codex are
  the same here: the host reads the normalized session status.

## Configuration

The control plane reads `APNS_TEAM_ID`, `APNS_KEY_ID`, and `APNS_PRIVATE_KEY` (the
`.p8` key, PEM; `\n` in a one-line secret is a line break). `APNS_BUNDLE_ID` is
`sh.solus.mobile` by default. Pushes go to the topic
`<bundle>.push-type.liveactivity`. The key must have the Apple Push Notifications
service enabled, and the app ID must have the Push Notifications capability.
