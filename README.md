# Supernova

A light, fast browser for Linux that puts nothing between you and the page.
Built for [Nova](https://github.com/Andre-cmd-rgb/nova), works on any Wayland desktop.

Version 1.0.0-beta.1.

- **Video on the GPU.** Chromium's own Wayland and VA-API path: YouTube's AV1
  1080p60 is decoded in silicon and stays on the GPU, and the browser asks the
  integrated GPU for everything, so a laptop's NVIDIA card stays asleep. A
  video in a hidden tab stops decoding (the sound plays on). On battery the
  page's animations run at 30 frames a second, and video quality and frame rate
  can be capped in the settings.
- **Ad and tracker blocking built in**, YouTube's video ads included
  (Ghostery's engine with EasyList, EasyPrivacy, Peter Lowe's list and uBlock
  Origin's filters, refreshed once a day), with a per-site switch.
- **Netflix, Spotify and the rest play.** It runs on castlabs' Electron, which
  carries Google's licensed Widevine.
- **Leaves Chrome behind in one step.** The first start offers to import
  Chrome's (or Chromium's, Brave's) passwords, sign-ins, bookmarks and history,
  or a Google Password Manager CSV. Chrome is not needed afterwards.
- **Passwords saved and filled in**, encrypted with a key kept in the login
  keyring. With no keyring it refuses to store them, rather than use a fixed
  key. On secure pages a single saved login is filled in by itself. On plain
  http to another machine, and in another site's frames, it is offered when
  you click the field.
- **Out of the way.** Tabs in a sidebar or along the top, a command bar
  (Ctrl+K) for addresses, Google search, open tabs, bookmarks and history.
  There is no toolbar, start page, account or telemetry. On Nova it takes the
  desktop theme's colours and follows theme changes live.
- Private windows (Ctrl+Shift+N), downloads, find in page, zoom per site,
  permission prompts it remembers, and the session restored on start.

## Install

**On Nova**, once a Nova release ships it from the `[nova]` repository:

```sh
sudo pacman -S supernova
```

**On Arch** (or until then), build the package from this repository:

```sh
git clone https://github.com/Andre-cmd-rgb/supernova
cd supernova/packaging/arch
makepkg -si
```

`makepkg` builds the committed `HEAD`, runs the unit tests and starts the built
browser headless before packaging it. For hardware video decoding on Intel,
install `intel-media-driver`. AMD's VA-API driver comes with `mesa`.

**From source**, for development:

```sh
npm ci
npm start      # bundles the preloads, downloads the pinned castlabs build, runs it
npm test       # unit tests, in a clean environment (tools/test.sh)
```

## Measured

YouTube, AV1 1080p60, against Chrome on a ThinkPad P1 Gen 4i (Intel Xe iGPU,
3840x2400 at scale 1.6, Hyprland). Medians of three alternating runs (two for
Supernova fullscreen, where one run did not play); method, caveats and raw
numbers are in [`bench/README.md`](bench/README.md).

| | GPU power | CPU | memory (PSS) |
|---|---|---|---|
| Fullscreen, Chrome | 3.92 W | 0.28 cores | 582 MiB |
| Fullscreen, Supernova | 3.94 W | 0.28 cores | 622 MiB |
| Window, Chrome (player 2662x1497) | 1.32 W | 0.18 cores | 581 MiB |
| Window, Supernova (player 2357x1326) | 1.04 W | 0.17 cores | 616 MiB |

- Decoding and drawing video cost what they cost in Chrome: both run the same
  Chromium pipeline. At the same size (fullscreen) the two are within 1%.
- In a window, Supernova uses 21% less GPU power, but most of that is
  YouTube's layout: next to the sidebar, its player is 22% smaller.
- Memory is about 35 MiB (6%) above Chrome's, the price of the built-in ad
  blocker and the browser UI's own small renderer.
- Without Nova's opaque-window rule the same window costs 1.36 W instead of
  1.11 W, because Hyprland blends every video frame. Nova ships that rule for
  Supernova.

## Keyboard

| | |
|---|---|
| Ctrl+K, Ctrl+L, Alt+D, F6 | command bar |
| Ctrl+T / Ctrl+W / Ctrl+Shift+T | new tab / close tab / reopen closed tab |
| Ctrl+Tab, Ctrl+PgDn / Ctrl+Shift+Tab, Ctrl+PgUp | next / previous tab |
| Ctrl+1 … Ctrl+8, Ctrl+9 | tab 1–8, last tab |
| Ctrl+F, F3, Shift+F3 | find, next, previous |
| Ctrl+D | bookmark the page |
| Ctrl+S | show or hide the sidebar |
| Ctrl+H | history (command bar) |
| Ctrl+J | downloads folder |
| Ctrl+M | mute the tab |
| Ctrl+= / Ctrl+- / Ctrl+0 | zoom in / out / reset |
| F11 | hide the browser around the page |
| Ctrl+N / Ctrl+Shift+N | new window / new private window |
| Ctrl+, | settings |
| F12, Ctrl+Shift+I | developer tools |

## Privacy

Nothing phones home. It only connects for:
- the pages you open
- Google's search suggestions while you type in the command bar (can be
  turned off)
- the ad-block lists, once a day
- Widevine updates
- spellcheck dictionaries

There are no crash reports, metrics or field trials.

Everything stays in `~/.config/supernova`. Passwords are in one encrypted
file whose key is in the login keyring. Private windows keep nothing.

## Licence

MIT (see [LICENSE](LICENSE)). Supernova runs on castlabs' Electron for
Content Security (Electron and Chromium, under their own licences) and uses
Ghostery's ad blocker (MPL-2.0); see [NOTICE](NOTICE). The architecture and
the rules for contributing code are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
