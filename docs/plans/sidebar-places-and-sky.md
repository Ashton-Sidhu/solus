# Sidebar places and sky

Status: done on desktop and web. Mobile is an open decision (see "Mobile").

## Decision

The session sidebar gives its height to the sessions. Three changes do this.

1. **Places column.** Sessions, Workspace, Automations, Insights, Pull
   requests, Tasks, and Search are icon buttons in a column on the left edge
   of the sidebar.
   They replace six labelled rows, which used about 200 px above the search
   field. Each button names itself in a tooltip, with its shortcut. The sidebar
   footer (Settings, Notifications, and the account) is the foot of the same
   column, so the footer row is gone too. Pinned sessions are not a button
   here: they are the Pinned section of the session list, above Working. A
   session shows in one section only (`sidebarSectionOf`), so a pinned
   session is in Pinned and in no other section, whatever its state.
2. **Sky.** The title bar of the sidebar carries the Solus mark and wordmark on
   a sky that follows the time of day. The lockup opens a new draft.
3. **Home mark.** The new-tab home has the Solus mark behind its composer,
   drawn large in halftone dots, in the colours of the same sky scene.

## Vocabulary

- **Place**: one of the seven static destinations. A place is not a task, so it
  does not sit in the list.
- **Places column**: the column of place buttons (`SidebarPlaces.svelte`). Do
  not call it a rail: `rail` is the container name of every side panel, and
  "project rail" is the right panel.
- **Sky scene**: one of `dawn`, `day`, `dusk`, `night` (`lib/sky-scene.ts`).
- **Sky**: the picture behind the title bar (`SidebarSky.svelte`).
- **Home mark**: the Solus mark behind the composer of the new-tab home
  (`DraftMark.svelte`). It is large, made of halftone dots, and cut by the
  bottom right corner of the pane. The dots keep one size at every pane size;
  the mark is about half of the pane's width, held to the pane's height. A
  soft clearing keeps it off the headline, the composer, and the row of menus
  under it. It is one painted box behind four masks, so the dots cost no
  elements. It replaced a gradient halo around the composer: the halo was
  colour with no drawing in it.

## Sky scenes

| Scene | Starts | Picture |
|---|---|---|
| Dawn | 05:00 | A warm wash and the orbit lines of the mark. Follows the theme. |
| Day | 09:00 | A pale gold and blue wash and the orbit lines. Follows the theme. |
| Dusk | 17:00 | A dark sky, stars, and a sunset below the mark. Dark in both themes. |
| Night | 21:00 | A dark sky full of stars, a faint band of the Milky Way, and a cool glow at the mark. Dark in both themes. |

Rules:

- The hours are fixed hours on the clock of the device. Solus does not read a
  location, so the scenes do not follow the real sunrise and sunset.
- A scene is static CSS. Nothing animates. The scene changes on the shared
  minute clock (`messageTimestampClock`), so there is no new timer, and a
  hidden window does no work.
- Dusk and night are dark in the light theme too. The header of the side panel
  then re-points its colour tokens (`headerOnDark` on `SidePanel`), so every
  control in the title bar reads light without a change to the control.
- The mark is the sun of each scene. The glow and the orbit lines centre on it.
  `SidePanel` puts the lockup one gap after the macOS window buttons, or at the
  header's padding where there are none; `SidebarSky` computes the same point.
- The sky is a band, not a tinted title bar. It keeps 2.25rem under the title
  bar row for itself (`SKY_HEADER_DROP_REM`): the sidebar's content starts that
  much lower.
- The sky ends at the top of the search field. It is opaque only behind the controls
  of the title bar. From there it thins over a long fall, flat at both ends,
  so it has no edge at the top of the fall or at its foot. The stops of the
  fall are solved so that night over the light surface gets lighter on an
  even curve: a dark sky over a light surface shows an edge wherever its
  lightness changes fast, and a short fall of alpha did that. It is gone
  0.5rem below the start of the content: only its faintest trace touches the
  top edge of the search field, and the field's text is on the plain surface.
  The 2.25rem room above the content is what gives the fall its length. The colours of dusk and night get warmer or bluer as they thin,
  so the fall reads as afterglow and not as grey. The tail of dusk mixes
  toward the sidebar's surface, so in the dark theme it does not make a
  light band.
- The sunset of dusk is muted: a soft glow under the mark and dusty rose
  bands, so it stays behind the list and does not pull the eye.
- Stars fill the band and fade out above the scene's horizon: low in the band
  at night, high at dusk, above the sunset. A soft clearing keeps them off the
  lockup, so no star reads as punctuation.
- The wordmark is set in Geist at medium weight, not in the interface font, so
  it does not change with the font setting. On dawn and day its ink is the
  theme's text colour warmed with the colour of the mark, not plain text
  colour. On macOS the lockup starts 1.25rem
  after the window buttons.

## Settings

Settings → Appearance → Sky has three controls:

| Control | Key | Default |
|---|---|---|
| Scene: Time of day, Dawn, Day, Dusk, or Night | `skySceneChoice` | `auto` |
| Sky in the sidebar | `showsSidebarSky` | on |
| Mark on the new-tab home | `showsDraftMark` | on |

- The scene applies to the sky and to the home mark. They always show the same
  scene.
- With the sky off, the title bar is plain: the lockup stays, the controls keep
  the theme's colours, and the content keeps no room for the band.
- These are device layout keys (`DeviceSettingsStore`), as zoom is. They stay on
  this client and do not sync. Decoration is a choice for one screen, and a
  personal key needs the same key in the cloud contract before a client can
  write it. Move them to personal settings if people ask for them to follow the
  account.

## Places column rules

- Sessions is the place where a conversation or a new draft is on screen. It
  is selected when no page and no Settings cover the conversation. A click
  closes the page or Settings. When the conversation is already on screen
  and the sidebar is collapsed, a click opens the sidebar.
- The selected place has the style of the selected session row: a raised
  card. Settings at the foot of the column uses the same style.
- When the sidebar collapses, the sidebar pane stops at the width of the
  places column, not at zero (`WorkspaceBody`). The column is the same
  element in both states, so the icons do not move, and the content slides
  on the curve of the pane. The card of the sidebar fades out as it
  collapses: no background, border, shadow, or sky stay, only the icons and
  the column's own hairline stay on the background of the pane. The hairline
  is the same divider as in the open sidebar: it fades in at the top and
  fades out the same distance above the foot of the column. The collapsed
  pane holds the whole card around the column, so the card does not clip
  the hairline. After the collapse, the list and the title bar
  controls are hidden, so Tab does not go to them. The expand button stays
  where it was, beside the window buttons.
- A place button shows a review count as small muted numerals, as the saved
  sessions button does. A filled badge is for Notifications only.
- A guest of a share link sees Search only, as before. Search was named
  History: it is now the search of every type
  ([unified search](unified-search.md), "Search types").
- The column is 2.75rem wide at every sidebar width, with a hairline between
  it and the list. The hairline fades in at its top, so no line crosses the
  sky. The wordmark in the title bar drops below 17rem (`@max-[17rem]/rail`)
  so the title bar controls keep their room.
- Capability is unchanged: the six places before Sessions keep their
  shortcuts and command palette entries. Sessions has no shortcut of its own.

## Customizing the column

The person decides what the column shows, and in which order.

- **Sessions** is always first. It cannot hide or move: it is the way back to
  the conversation.
- **Solus places** (Workspace, Automations, Insights, Pull requests, Tasks,
  and Search) come next. Each can hide and move. A hidden place keeps its
  shortcut and its command palette entry.
- **Pinned apps** come below a horizontal divider. The divider separates the
  Solus places from the person's own pages. It shows only while one pinned app
  or more shows. An app has no icon, so its button shows the first letter of
  its name. A click opens the app as the destination; a second click closes
  it. A pinned app is selected while it is the destination, as its own view
  or its Manage page. Many pins scroll below the divider; the places and the
  footer stay.

Ways to change it:

| Where | What |
|---|---|
| Right-click anywhere in the column (a button, the empty space, or the footer), or the context-menu key (Shift+F10) on a button | The column's menu. On a place or an app it starts with Move up, Move down, and Hide or Unpin for that row. Then a checkbox for each place, a Pinned apps submenu with a checkbox for each app of every connected host, and Reset places to default. |
| Drag a button | Moves it within its group: a place among the places, an app among the apps. The whole column takes the drop: the gap is the pointer's height against the middle of each button of the group, so a release below the last button makes it last. A line shows the gap. |
| The app's menu (`AppMenu`) | Pin to sidebar or Unpin from sidebar. Delete also unpins the app. |
| Settings → Appearance → Sidebar places | Opens the same menu, and Reset. |

Storage: two personal settings, so the column follows the account to each
client (`packages/contracts/src/settings.ts`).

- `sidebarPlaces`: `{ order, hidden }`, place ids. A place that `order` does
  not name follows in the default order. Ids that this client does not know
  stay stored, so an older and a newer client never erase each other's
  choices. Reset writes the default.
- `sidebarApps`: an ordered list of `{ host, appId }`. `host` is the host's
  installation id, because a server id names a host only on one client. A pin
  whose host is not connected, or whose app is gone, does not show and stays
  stored.

The helpers are in `packages/workspace-ui/src/lib/sidebar-places.ts`; the
column is `SidebarPlaces.svelte`, and its menu is `SidebarPlacesMenu.svelte`.
A guest of a share link sees Search only and cannot open the menu.

## Mobile

The native app has its own navigation, so the places column does not apply to
it. This is a recorded exception for the column's customization too
(2026-11-13): `sidebarPlaces` and `sidebarApps` sync to the mobile profile,
but the native app does not read them. Its apps stay in the Apps list. The sky and the home mark are decoration with no new capability. They are not in
the native app. A product decision is necessary: add them to the native home
and new task screens, or record an exception here.
