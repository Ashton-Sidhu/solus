# Device previews

Show an iOS Simulator or Android Emulator beside a conversation, use it with
the mouse, keyboard or touch, and let the agent drive and screenshot the same
device. Desktop, web and mobile clients show the same devices and state.

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

## Put a build on a phone or iPad

Ask the agent to build the app and put it on your phone. The agent builds
the app itself (`xcodebuild`, Gradle, `expo run`), then calls
`device_install` with the build output: an iOS `.app` bundle or an Android
`.apk`. Solus records the build, installs it and opens it. Solus does not
build or sign apps.

**Connected devices.** An iPhone or iPad connected to the Solus host by cable
or on the same network, and an Android phone with USB debugging, appear in
the device list. Solus can install builds on them, but it cannot show their
screen, so they are not offered as device tabs. When a device cannot take an
install, Solus says why: not connected, does not trust this Mac, Developer
Mode off, or USB debugging not allowed.

**iOS signing.** A build for an iPhone or iPad must be signed for
development by your own team, as Xcode does it. The agent can build with
automatic signing (`xcodebuild -allowProvisioningUpdates` and your team in
the project). A simulator build cannot go on a device, and a device build
cannot go on a simulator; Solus refuses the wrong one and says which build
to make. If an install fails for signing, Solus says what to change.

**Build & run.** Build the app from the Devices pane, without the agent:

1. Open a conversation in the project and show a device in the Devices pane.
2. Select **Set up Build & run** in the device toolbar (or **Edit build
   profiles…** in its arrow menu). Add a profile from a preset — Xcode for
   the simulator, Xcode for an iPhone or iPad, or Gradle's debug APK — and
   edit the scheme and folders. A profile has a name, the platform, the
   build kind (simulator or device, for iOS), a folder, the command, the
   output path (`*` matches within one folder name; the newest match wins),
   and the app id. Save writes the profiles to the project's
   `.solus/config.json`, so they can be committed and shared.
3. Select **Build & run**. Solus builds in the conversation's own checkout
   (its worktree, if it has one), finds the output, records it under
   Builds, installs it on the device on screen and opens it. A stopped
   simulator boots first.

While it builds, the toolbar shows the stage; select it to open the log, or
**×** to cancel. Cancel stops only the build process Solus started. A failed
build stays in the toolbar with its log until the next run. The arrow menu
lists the other profiles that fit the device, the builds that fit it, and
**Show the last build log**.

The command runs without a shell, so pipes and variables are not expanded.
The first time a command runs on a host, Solus shows it and asks to run it;
a changed command asks again. Builds stop after 30 minutes. Build & run
works with devices connected to the Solus host itself, not with an SSH
device host. Signing stays with the project: a device build must use your
development team (`-allowProvisioningUpdates` in the Xcode preset).

**Run a build.** One click runs a build where you can see it:

- **On the device you are looking at.** When the project has no build
  profile for the device but a build fits it, the Devices toolbar shows
  **Run <build>** for the newest one. One click installs it there and opens it. While it
  installs, the button shows **Installing <build> on <device>…**. The arrow lists the
  other builds that fit, and **All builds**.
- **Devices pane → Builds.** The builds are one card, a row each: the
  build's name, and what it runs on and how old it is. **Run** on the right
  uses the best device (its name is in the button's tooltip): a connected
  phone first, then a running simulator or emulator, then a stopped one,
  which boots. While it installs, the button shows **Installing…**. A
  simulator or emulator then shows in the Devices tab; on a phone, the app
  opens on the phone. The **…** menu shows the app id, size, project,
  conversation and last install, runs the build on another device,
  downloads an APK, and deletes the build from the host (see below).
  **Add a build…** opens the host's folder browser at the conversation's
  folder. It lists folders and build outputs; an `.app` bundle or an `.apk`
  is chosen with a click, not opened.
- **Project panel → Environment → Devices.** The row shows how many builds
  the host has, and opens Builds when there is at least one.

When the agent installs a build on a simulator or emulator, that device also
opens beside the conversation.

A window has one Devices pane. Opening Devices again, from a run or from
the agent, shows the device in that pane and keeps the conversation beside it.

To watch another device in its own tab, choose **+ → Devices** in the tab
strip when a Devices tab is already open. The new tab starts on the device
picker and shows only the device you choose in it. Runs and the agent
continue to use the first Devices tab.

The Devices row shows only for projects that build a mobile app, at the root
or in a subfolder up to four levels down: an Xcode project or workspace, an
`android/` Gradle project, an `AndroidManifest.xml`, a `package.json` that
depends on `expo` or `react-native`, a Flutter `pubspec.yaml`, or a Capacitor
config. Dependency and build folders (`node_modules`, `Pods`, `build`, and
hidden folders) are skipped. It also shows when the conversation already has
a device open. **Open Devices** in the command palette works in any project.

**Builds.** Each build shows its kind, app id, size, age and where it was
last installed.

- **Install on…** lists the devices that can take the build now: connected
  phones first, then running simulators and emulators. The install needs
  control of the device. If you do not have it, Solus takes control for the
  install and gives it back. Solus never takes a device from an agent that
  is using it.
- **Download** (Android) downloads the APK through a link that expires
  after an hour. Open the web client in your phone's browser to download it
  straight to the phone.

**Mobile app.** Open a host, then **App builds**. On an Android phone,
**Install here** downloads the APK and Android installs it; the first time,
Android asks you to allow installs from the browser. On any phone,
**Install on…** puts the build on a device connected to the host.

The host keeps the 20 newest builds. An APK is copied into the host's
assets, so a newer build does not change one that was already offered. An
iOS build refers to the build output on the host; building again at the same
path replaces it. When a build's output is no longer on the host, the build
is not listed, and the host drops its entry.

Deleting a build deletes the output it names and nothing around it: the
`.app` bundle (only the link, when the path is a symbolic link), or the copy
of an APK in the host's assets. The APK that the project built stays.
Adding and deleting builds is for the host's administrator, like device
setup. On mobile, **Run** opens the device choice, the **…** menu says what
the build is and has **Install on this phone** (Android, APK builds) and
**Delete**, and **Add a build** browses the host's folders the same way. Builds install only on devices connected to the Solus host
itself, not on an SSH device host.

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
build-and-run on mobile, outdated-build labels,
frozen-screen annotations, native
recordings and before/after evidence, saved test conditions and checks, and
control arbitration between two Solus hosts that share one SSH Mac.
