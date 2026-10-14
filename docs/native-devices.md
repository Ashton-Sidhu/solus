# Device previews

Show an iOS Simulator or Android Emulator beside a conversation, use it with
the mouse, keyboard or touch, and let the agent drive and screenshot the same
device. Desktop and web clients show the devices; the mobile app shows the
screenshots an agent takes (see [Agents](#agents)).

## Set up

Go to **Settings → Devices**, or open the command palette and choose
**Open device settings**. The page shows the settings of one host. When you
connect to more than one host, select the host at the top of the page. On a
phone, Devices is one of the settings chips. **Connections → host →
Environment → Devices** shows the state of that host and opens the same page.
In the Devices pane, the **Device setup** button (gear) opens the same page for the host of the
conversation. When device support is off, the pane shows
**Open device settings**.

If a change fails, the page shows the error and the switch stays at the value
that the host stored.

1. **Device support.** Turn it on. The first time, Solus installs
   `expo-device-hub` 0.12.0 into the host's data directory and starts it on
   loopback. Opening setup installs and starts nothing.
2. **Agent access** is on by default: once device support is on, agents can
   drive devices with `agent-device` 0.21.12. Turn it off to keep agents away
   from devices; manual previews work without it. Solus keeps that choice when
   device support is turned off and on again.
3. **Show devices agents open.** When on, a device an agent opens appears
   beside that agent's conversation. It never switches you to another
   conversation and never takes typing focus.

### Requirements on the machine with the devices

- **Node.js 22.12 or newer** on the PATH. The helpers use native modules
  built for Node, not Electron.
- **iOS:** macOS with the full Xcode app selected
  (`sudo xcode-select -s /Applications/Xcode.app`) and at least one iOS
  simulator runtime (Xcode → Settings → Components). Command Line Tools alone
  are not enough; setup says which one you have.
- **Android:** the Android SDK with Platform-Tools, the Emulator and
  Command-line Tools (latest). Solus looks in `ANDROID_HOME`,
  `ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, `~/Android/Sdk`, and next to
  `adb` on the PATH.

The client you view from needs none of this.

### SSH device hosts

A Linux Solus host can show simulators on a Mac. Under
**Settings → Devices → Add SSH device host**, give an id, a name, an SSH
alias or `user@host`, and optionally a port and an identity file on the Solus
host.

- **Test connection** checks SSH, Node, npm, Xcode and the Android SDK on that
  machine. It installs and starts nothing.
- SSH uses key authentication with your normal host-key checks. Solus never
  answers a password prompt and never turns off host-key checking.
- An alias that resolves to the Solus host itself is skipped: its devices
  already appear under **This machine**.
- Solus installs the pinned tools under `~/.solus/devices` on that machine and
  forwards their ports to the Solus host's loopback.

## Use a device

The Devices pane shows the conversation's devices as tabs. Select **+** to
add one; a stopped device boots first. Double-click a tab, or press F2, to
rename it — this changes the label only. Closing a tab never powers the
device off. **Power off** is separate, and it warns when other sessions use
the device.

Click to tap, drag to swipe, and scroll with the wheel or trackpad. A wheel
burst is one finger drag on the device: the finger goes down where the
scroll began, follows the wheel, and lifts when the wheel stops. Only the
primary mouse button touches the screen. With the
screen focused, keys go to the device. The keyboard button opens a text field
for a touch keyboard. The Devices pane has the same layout as the browser
pane: device tabs grouped by device host in the top row, then a toolbar over
the screen. The toolbar has Home, Back (Android), App switcher or Recents,
Rotate (iOS), the device name and state, the control chip, the keyboard,
screenshot download, **3D view** and **Flat view**, **Tools**, and **Power off**.

### 3D view

By default the screen shows on a 3D phone or tablet body. Drag on the screen
to tap and swipe. Drag outside the screen, Alt-drag anywhere, or swipe with two
fingers on a trackpad to turn the device; it springs back to a view that faces
you. **Restore 3D view** turns it to face you. In 3D the wheel turns the
device; select **Flat view** to scroll with the wheel. The choice applies to
every device on this client and stays after a restart.

The body is drawn in code, one shape each for an iOS phone, an iOS tablet, an
Android phone and an Android tablet; the device name and screen shape pick
one. It does not copy any real hardware model, and no 3D model files ship with
Solus. three.js loads the first time a 3D view opens. A browser without WebGL
shows the flat view, and **3D view** says why it is not available.

**Tools** reads settings back from the device and shows only what it
confirmed: appearance, the four text sizes, reduce motion, increase contrast,
reduce transparency, button shapes and VoiceOver (iOS), Liquid Glass and
colour filters (iOS), network and four orientations (Android), location,
app permissions, open URL, launch and terminate, and a test push (iOS).
Controls a platform cannot do are not shown. A missing helper says so instead
of pretending to work.

## Run app

Open **Run app** from the Devices pane, the command palette, or the
project panel. The mobile app does not have Run app.
Choose **Dev server** or **Production build**, then a project.

- **Dev server** opens the app on simulators and emulators with the
  project's Metro dev server, for live reload. It builds nothing: each
  simulator must already have a debug build of the app (for example from
  `npx expo run:ios` once). Choose a simulator and **Open on simulator**;
  repeat it to open the app on more simulators against the same server.
  If Metro for this project already runs on port 8081, Solus joins it. If
  the port is free, Solus starts Metro in the project folder and stops it
  when you stop the run. Solus never adopts a dev server that serves
  another project. It uses the project as it is on disk, uncommitted
  changes included. An Expo app with `expo-dev-client` opens through its
  `exp+<slug>` link; other debug builds restart and load from Metro.
  Android uses an adb connection to the server.
- **Production build** builds a Release app with its JavaScript included,
  once, from the chosen branch. **Build for** chooses what it runs on:
  iOS Simulator, iPhone or iPad, or Android. An iOS simulator build and an
  iPhone build are different apps. When the build is ready, choose a device
  under **Install on** and click **Install**; repeat it for every device
  that should have the same build. An Android build can also be
  downloaded as an APK to install on a phone that is not connected.

A production build uses the newest commit of the chosen branch in a
separate checkout that Solus owns. It does not switch your conversation's
checkout. Uncommitted changes are not built.

**Cancel** stops only the processes Solus started. Stop a running app run
before you start another one.

Solus detects standard Xcode and Gradle commands from the project.
Solus prepares an Expo native project when its native folder is absent.
Other projects must have their native project folder. When detection is
not sufficient, add `deviceRuns` to the project's `.solus/config.json` with
the command, folder, output path, and app id. iPhone and iPad builds need
an Apple signing certificate and a development team. Configure these in
Xcode and the project. The host asks before it runs a new repository
command, and before it starts a dev server for the first time.

The current stage and error appear on the page. **Log** opens the
bounded log as Steps, Issues, or Raw output. Run app copies iOS output
into its own cache, so a failed retry cannot replace the last useful app.
It removes only its own cached outputs. Agent and project app folders stay
intact. A host restart stops a live run; its state then asks you to run it
again. Solus does not claim that a dev server survived a restart.

On an Android phone, **Download APK** opens a download.
Install it from your downloads. A download is not a confirmed install;
Solus cannot confirm the phone's own installer result.

App runs use devices connected to the selected Solus host. SSH device
hosts remain available for device viewing and control, but app build and
install does not transfer builds to them. Desktop and web
use the same host RPC operations and device control leases. An install
borrows a free lease and releases it afterward. It cannot take a device
from an agent or another client.

Agents can still build an app and call `device_install` with its `.app`
or `.apk` output. A simulator opened by the agent appears beside the
conversation. Connected phones can take builds, but Solus cannot show
their screens.

The Devices pane can show more than one simulator in separate device
tabs. Open another with **+ → Devices**. Device support appears in the
project panel for a mobile app or for a conversation with an open device.
**Open Devices** in the palette opens device viewing in any project.

## Control

Only one person or agent controls a device at a time. The pane always says
who. Watching never takes control.

- Your first touch, button or Tools action takes control of a free device,
  or of one another person controls.
- **Take control** from an agent pauses the agent's device actions and gives
  you control at once. An action the agent already started can finish.
- **Release** gives up your control. The agent stays paused.
- **Resume agent** lets agents act on the device again.

An agent that finds a device paused or controlled by someone else is told to
wait or to open another simulator. Agents do not take devices from people.

## Agents

With agent access on, Claude and Codex sessions get five tools:
`device_list`, `device_open`, `device_screenshot`, `device_close` and
`device_install`.
`device_open` boots the device if needed, shows it beside the conversation
and returns the exact `agent-device` command and flags to drive it. The
screenshot reaches the agent as an image and is saved as a host asset.

The mobile app has no Devices pane. When you ask the agent to show you
something on a device, it calls `device_screenshot`, and the screenshot
appears in the conversation on every client, the phone included.

The agent's CLI talks to the device through Solus, never directly. Solus
checks control before each command that changes the device, keeps each
session on its own device, and never gives the agent the daemon credential.
This does not sandbox an agent that already has a shell: `simctl`, `adb` and
Xcode stay usable on the host.

For an SSH device host, the agent builds and installs the app on that
machine. If the app needs Metro, make Metro reachable from that machine;
Solus does not rewrite `localhost`.

## Video

Desktop and web over HTTPS decode H.264 with WebCodecs. Without WebCodecs (a
plain-HTTP remote origin, some mobile browsers), iOS falls back to JPEG
frames and Android shows that this client cannot decode the stream. A hidden
pane stops its subscription; the host stops reading a device's video when
nobody watches it.

## Turn things off

| Action | Effect |
| --- | --- |
| Close a device tab | The session stops showing it. The device keeps running. |
| Power off | The device shuts down. Every session's tab for it closes. |
| Agent access off | The agent daemon stops and agent bindings stop working. Manual previews continue. |
| Device support off | Solus's helpers stop and all tabs close. Simulators keep running. |
| Remove an SSH device host | Its tunnels close and Solus's helpers there stop when reachable. Its simulators keep running. |

## Not available yet

These parts of plan 016 are not built: the floating preview, imported 3D
hardware models and folding-device controls, Run on device with saved build profiles (agents
build, and `device_install` installs), installs on an SSH device host,
outdated-build labels,
frozen-screen annotations, native
recordings and before/after evidence, saved test conditions and checks, and
control arbitration between two Solus hosts that share one SSH Mac.
