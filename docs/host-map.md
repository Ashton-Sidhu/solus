# Host Map

**Settings → Hosts → Map** shows every machine your agents can run on, how
this device reaches each one, and which of your hosts reach each other. It is
on desktop and web. Below a width of 37.5rem, the map shows the same routes as
a tree.

## Routes

Each host with a card has one line for each saved route from this device, in
the order that Solus tries them. A mark near the card shows the kind of the
route (local network, Tailscale, VPN, public address, SSH forward). Its tooltip
gives the address and the state.

| State | Line | Mark |
| --- | --- | --- |
| In use | Solid, green, as wide as its traffic | Solid border |
| Standby | Solid, thin, quiet | Solid border |
| Connecting | Dotted, amber, moving | Dotted border |
| Not in use | Dashed, quiet | Dashed border |
| Not answering | Long dashes, red | Dashed border |
| Refused, different server | Dash and dot, red | Dashed border with × |
| Blocked here | Sparse dots, quiet | Dotted border with ⊘ |

Each state that is not healthy has its own dash pattern. The map is therefore
readable without color, in forced colors, and with reduced motion. A host card
shows its state in its outline too: dashed when the host does not answer, and
dotted while it reconnects. In a folded zone every host is one square tile, colored
by its state; the summary row above the tiles counts each state with an icon, and
each tile names its state in its tooltip.

A zone with more hosts than its cards (5 for your machines, 3 for Solus Cloud,
1 for shared hosts) shows small tiles and one line. Use the unfold button in
the zone header to show a card for each host in place, up to 40. The zone page
(the arrow) lists all of them.

## Hosts that reach each other

A person's hosts reach each other with no step: a device that is the owner of
two hosts introduces them automatically. The map draws a line between two of
your hosts that reach each other, on the outer side of **Your machines**. An
arrowhead points into each host that is reached, so a two-way line has one at
each end. A healthy line is neutral. A line that expires soon, fails, or has
expired has its own dash pattern and color.

To introduce two hosts yourself, for example after you forgot an
introduction:

- Drag the **+** beside one of your hosts onto another host. A drop on a
  machine marked **Found nearby** adds that machine, on the map. A machine
  that runs Solus gets an approval request, and the **Add host** dialog opens
  focused on its **Approve** tab: the check code in large type and what to do
  on that machine, with the line between the two machines filling while it
  waits. **Other ways** shows the dialog's other tabs. **Stop** ends the
  request, **Use a pairing code** moves to the **Address** tab with the
  machine's address filled in, and a denied or expired request offers
  **Ask again**. A machine that runs an older Solus has no approval requests:
  the dialog says so and offers only **Use a pairing code**. That machine shows
  its code in **Settings › Hosts › This device › Access**. The machine's card on the
  map shows the code too while the request waits. A machine found on Tailscale pairs as a
  Tailscale route, by approval or by code. A WSL distro is set up; a machine from your SSH
  config opens the SSH form, filled in. A drop on empty space says what a drop
  takes.
- While you drag, the line leaves the side of the host that faces the pointer,
  snaps to the nearest edge of a host or found machine a drop would act on, and
  turns green for a drop that works or red and dashed for one that does not. A
  label beside the pointer says what the drop will do.
- Shift-click or Shift-drag to pick several hosts, then drop the **+** on one
  of them to introduce the host to all of them.
- From the keyboard, open the host's menu (the menu key) and use
  **Introduce to**, or select the host and use **Introduce to** in its details.

An introduction made this way also undoes an earlier **Forget** on either
host. Only hosts that this device owns and that answer can be introduced.
Solus Cloud machines reach your hosts through your account, and shared hosts
belong to someone else. If you drop the **+** on a host that cannot be
introduced, the map says why at the top.

Select a line to see each direction and its health. **Forget** stops an
introduction on both hosts. The two hosts stay forgotten until you introduce
them again. A pairing made from chat or the CLI shows its health but has no
**Forget** on the map.

## Selecting, moving, and finding

- Use **Status**, **CPU**, or **Sessions** to change the color of host tiles.
  Use the live updates button to pause or resume updates, and the radar button
  to scan for machines you can add. Hover over a control or move keyboard focus
  to it to see its tooltip.
- Click a host to select it. Its details show its routes and the hosts it
  reaches. Click it again, or press Enter again, to open the host's page.
- Drag the background to move the map. Pinch, or hold Ctrl or ⌘ and scroll,
  to zoom. The buttons in the corner zoom and fit the map.
- In **Find**, press Enter to go to the next match and Shift+Enter to go to the
  match before it. The map opens a folded zone if necessary, centers the host,
  and selects it.

The map is one Tab stop. Arrow keys move between hosts, Space picks a host,
`+` and `-` zoom, `0` fits the map, and Escape clears the selection.

## Mobile

The mobile app has no host map. It keeps its connections list. This is a
product decision for this change: the map's capabilities (route states, reach
between hosts, introduce, and forget) are on desktop and web only.
