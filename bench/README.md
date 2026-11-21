# Benchmarks

Every efficiency claim in Supernova's docs comes from these scripts, run on a
ThinkPad P1 Gen 4i (Intel Xe iGPU, 3840x2400 panel at scale 1.6, Hyprland
0.57, Nova). Results are appended to `results/youtube.local.jsonl`, which is
not committed (it holds machine-specific runs); the tables below are copied
from `node bench/summary.mjs`.

## What is measured

`measure.py` samples once a second for `--seconds` and prints one JSON object:

- **GPU W**: RAPL `uncore`, the iGPU's own power. The package and psys
  counters are recorded too, but anything else running on the laptop shows up
  in them, so comparisons use the iGPU and per-process numbers.
- **CPU cores**: CPU time of the browser's whole process tree, in cores busy.
- **render % / video %**: i915 engine time of the browser's processes (DRM
  fdinfo), so composition and decoding are told apart.
- **Hyprland %**: render-engine time of the compositor: what it costs to put
  the browser's frames on screen.
- **RC6 %**: how long the GPU slept; **MHz**: its average frequency.
- **PSS MiB**: proportional memory of the browser's process tree at the end.
- Whether the NVIDIA card left runtime suspend (it must not).

RAPL is root-only after every boot; `sudo chmod o+r
/sys/class/powercap/intel-rapl:*/energy_uj /sys/class/powercap/intel-rapl:*/*/energy_uj`
makes it readable until the next one. Everything else needs no root.

## The YouTube bench

`yt-bench.mjs` starts Supernova or Chrome with a fresh profile on workspace 9,
drives YouTube over the DevTools protocol (rejects the consent dialog, which can
also arrive late as an in-page lightbox, plays, skips ads), waits, measures, and
appends one line:

```sh
node bench/yt-bench.mjs --browser supernova|chrome [--seconds 30] [--quality hd1080]
     [--fullscreen] [--battery] [--hidden] [--max-height 720] [--translucent]
     [--square] [--features A,B] [--settings='{"key":value}'] [--keep]
     [--extra='--switch=value'] [--label name]
bench/series.sh [rounds=3] [seconds=30]     # alternates both browsers, then prints medians
node bench/summary.mjs [--since <iso time>] [--markdown]
```

Things that made runs disagree before they were controlled:

- **YouTube picks the stream.** In the same window, a fresh Chrome profile got
  480p in some runs and 1080p60 in others. `--quality hd1080` (the series'
  default) holds both browsers to the same AV1 1080p60 stream (format 399).
- **Fresh profiles land in different YouTube layouts** (A/B experiments), so the
  player's size moves between runs. Fullscreen runs remove that.
- **The cursor over the player keeps its controls up.** The bench parks it in
  the screen's corner before measuring.
- **A see-through window costs the compositor on every frame.** Chrome has
  Nova's opaque rule; the bench gives Supernova the one Nova ships for it
  (`opacity 1 1`) unless `--translucent`.
- **Supernova's first start downloads and compiles its filter lists.** The
  bench keeps the compiled lists between runs.
- Both browsers report `devicePixelRatio` 1.75 on this panel, not 1.6:
  Chromium multiplies the display scale by GTK's text-scaling-factor (1.0909
  here, from Nova's text size).
- **The workspace must stay on screen.** A run where Hyprland's render
  engine reads 0% measured a window nobody saw: someone switched away from
  workspace 9. Bench on a machine nobody is using.
- **A reply that never comes ends the run with an error**, not with a silent
  exit 0: every DevTools call times out after 30 s.

`--features` passes Chromium features to Supernova
(`SUPERNOVA_EXTRA_FEATURES`), `--settings` writes Supernova settings before
it starts, `--square` gives YouTube's player square corners, and `--keep`
leaves the browser running.

## Results

2026-11-20/21, Supernova 1.0.0-beta.1 (castlabs Electron 45.2.1, Chromium
156) against Google Chrome 158 with Nova's flags, on the machine above. YouTube
`aqz-KE-bpKQ` held to AV1 1080p60 (format 399), 30 s per run after an 8 s
warm-up, medians of three runs, the two browsers alternating
(`bench/series.sh`).

| | GPU W | CPU cores | render % | video % | Hyprland % | RC6 % | PSS MiB | player |
|---|---|---|---|---|---|---|---|---|
| Chrome, window | 1.32 | 0.184 | 14.3 | 7.1 | 16.4 | 63 | 581 | 2662x1497 |
| Supernova, window | 1.04 | 0.174 | 12.5 | 7.4 | 13.7 | 66 | 616 | 2357x1326 |
| Supernova, window, on battery | 1.06 | 0.185 | 12.4 | 7.5 | 13.5 | 66 | 613 | 2357x1326 |
| Chrome, fullscreen | 3.92 | 0.282 | 13.4 | 7.2 | 46.1 | 37 | 582 | 3842x2401 |
| Supernova, fullscreen (2 of 3 runs played) | 3.94 | 0.278 | 13.4 | 7.2 | 45.7 | 38 | 622 | 3842x2401 |

What they say:

- **The video pipeline is Chrome's.** At the same size (fullscreen) GPU power,
  CPU time, and decode and render engine time are within 1-2%. Decoding is 7%
  of the video engine in both.
- **In a window the difference is the player's size.** Supernova's window uses
  21% less GPU power, and its player has 22% fewer pixels: the sidebar
  narrows the page, and YouTube sizes the player to the page. Moving
  Supernova's tabs to the top did not make the two comparable: YouTube switched
  to its two-column layout (a 1521x855 player) and the runs did not play
  steadily.
- **Fullscreen costs the compositor, not the browser.** Hyprland's render
  engine is 46% busy redrawing a 3840x2400 frame 60 times a second, the same
  for both browsers. Its cost grows with the area on screen: 14-16% for the
  windowed player, 46% fullscreen. This is a Nova-wide cost, not a browser
  one.
- **Battery mode costs nothing here**: YouTube's 1080p60 is under the default
  1080p battery cap, and the 30 fps animation limit does not touch video.
- **Memory**: Supernova's tree is about 35 MiB (6%) above Chrome's with one
  YouTube tab. That is the built-in ad blocker's engine and the UI's own
  renderer (28-36 MiB); Chrome draws its UI in the browser process and has no
  blocker. The find bar and prompts' renderer exists only while shown (it
  saved about 22 MiB when it stopped being permanent).

### A see-through window costs every frame

Supernova, window, three runs each, alternating (`--translucent` against
Nova's `opacity 1 1` rule):

| | GPU W | Hyprland % | RC6 % |
|---|---|---|---|
| opaque (the rule Nova ships) | 1.11 | 14.1 | 65 |
| translucent | 1.36 | 21.5 | 61 |

Window rules added with `hyprctl eval` stay until `hyprctl reload`: between
translucent and opaque runs, reload, or the next run inherits the rule. (One
of the three translucent runs here measured like an opaque one.)

### Tried, and no better

Single runs; kept here so they are not tried again blind.

- `--force-device-scale-factor=1.6`, so Chromium renders at Hyprland's scale
  instead of 1.75: fullscreen 4.32 W and 0.72 CPU cores against 3.65 W and
  0.28 in the run before it. Worse on both counts; windowed, YouTube picked
  another player size, so that run compares nothing.
- `--fullscreen` with `video.maxHeightOnBattery` and the rAF limit made no
  difference beyond the run-to-run spread (3.87-4.07 W); one battery run that
  measured 1.3 W had YouTube serve 480p30.

### Not settled

- **`WaylandOverlayDelegation`** (Chromium hands the video to Hyprland as its
  own Wayland surface) with `--square` (rounded corners keep a video out of an
  overlay): one windowed run measured 0.74 W against 1.12 W just before, with
  the same player, the same Hyprland % and more CPU (0.23 cores against 0.14).
  The first run with it did not play. A three-round series was cut short
  because the desktop was in use. Worth a proper series before anyone turns it
  on: `--features WaylandOverlayDelegation --square` against `--square`.
- **The bench's Chrome stopped staying up** on 2026-11-21: it exits on its
  own, with status 0, about 20 s after starting, also outside the bench and on
  example.com; not looked into yet. The Chrome numbers above are from
  2026-11-20, before that started.
