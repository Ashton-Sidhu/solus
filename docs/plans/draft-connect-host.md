# Draft: connect a host

A draft that no host can run does not show a composer. The draft surface shows
a page that asks the user to connect a host. When a host connects, the composer
comes back.

## Vocabulary

- **Connect page** — the page that replaces the composer while no host can run
  the draft.
- **Host gate** — the rule that selects the composer or the connect page.

## Host gate

The connect page replaces the composer only on a known answer:

| Hosts | Result |
|---|---|
| One or more hosts are online | Composer |
| No host is saved | Connect page |
| A host is dialing, inside the reconnect grace | Composer |
| A host was never checked | Composer |
| All other cases (every host offline, stopped, or refused) | Connect page |

The reconnect grace is `RECONNECT_ESCALATE_MS` (12 seconds), the same grace
that `ConnectionStatusOverlay` uses before it shows its card. A short drop thus
does not remove the composer while the user types.

Mobile has no offline timestamp per host. On mobile, the supervisor's
`offline` phase is the known answer, because the supervisor sets it only after
its retry ladder stops.

## Connect page

- **Headline.** "Connect a host to start" when no host is saved. "<Host> is
  offline" when one host is saved. "Your hosts are offline" when more than one
  host is saved. "Connecting to <Host>" after the user selects a host.
- **Host cards.** One card for each saved host, with its status and one action:
  Retry (offline), Start (stopped cloud host), or Pair again (refused, or a
  different server answered). A host that is dialing has no action.
- **Nearby hosts** (desktop and web). One card for each host that discovery
  found, with Connect.
- **Ways to add a host.** Add host, Scan network (desktop and web), and, when
  no host is saved, Pair another machine and Cloud host.
- **Draft kept.** If the draft has text, the page shows it. The text stays on
  the draft and shows again in the composer.
- **Connecting.** After Retry or Start, the page waits on that host. "Choose
  another host" goes back to the list. If the host does not answer, its card
  says "Did not answer · try again". There is no Cancel, because the store has
  no way to stop a dial.

## Surfaces

| Surface | Where |
|---|---|
| Desktop and web | `SessionDraftPane.svelte` selects `ConnectHostPage.svelte` with `draftHostGate` (`session-draft/lib/host-gate.ts`). A draft beside another pane shows the same page in compact form. |
| Web, before a host connects | `apps/client/src/routes/HostlessHome.svelte` uses the same headline and cards: saved hosts (Open, Forget), the host on this address (Connect), Solus Cloud (Sign in, or how to link a computer), and Pair another machine, which opens the pairing form. The card and field classes are in `routes/lib/hostless-styles.ts`. |
| Mobile, first launch | `WelcomeScreen` uses the same headline and cards (`connection/ConnectOptionCard.tsx`): Pair a machine, and Solus Cloud. |
| Mobile | `NewTaskRouteScreen` selects `NewTaskConnectHost` with `newTaskHostGate` (`features/threads/new-task-host-gate.ts`). The gate applies to the project picker and to the draft. |

Keyboard: the first card gets focus. The arrow keys move between cards, and
Enter runs the action of the card.

The composer docked on a page (`DraftComposer` with `floating`) is not gated.
It sits over a page, which stays usable without a host.
