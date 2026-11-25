# Solus mobile

Keep the mobile app as close as possible to the upstream T3 Code revision listed in `UPSTREAM.md`. Use its screens, navigation, layout, menus, gestures, and controls. Connect those components to the selected Solus host through its typed backend. Keep Solus branding.

Get explicit maintainer approval before adding custom mobile logic or changing an upstream interaction. This includes logic below the screen, such as a loader, cache, or feed builder. Identify the upstream code you checked, explain why it cannot meet the requirement, and describe the smallest change that will. Record approved differences in `UPSTREAM.md`.

For mobile features and upstream updates, read the repository skill at `.agents/skills/solus-mobile/SKILL.md` from the Solus repository root.

Reuse T3's session navigation, list state, history controls, and conversation feed builder. The Solus host translates upstream requests into Solus operations and returns records, snapshots, and live events in the format the T3 client expects. Preserve upstream behavior for paging, subscriptions, retries, and reconnects.

Apply the same rule to **every mobile feature**. Follow the phone and tablet routes into the upstream feature, its state, and its host operation. Keep the upstream query, cache, selectors, paging, subscriptions, and action handling. When the contracts differ, adapt the typed operation on the host. When migrating an existing feature, remove its mobile translation code once the upstream path handles the same cases. A screen that uses the same layout but runs a second loader can still lose the upstream performance gains.

Keep Solus in charge of account and organization scope, host selection, permissions, transport, and signed resources. A reconnect or account switch must invalidate reads for the previous connection. Show controls for operations the host supports. Record intentional differences in `UPSTREAM.md`. Verify the active route and its data path, including warm reads, retries, and a scope change when applicable.
