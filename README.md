# Supernova

A light, fast browser for Linux that puts nothing between you and the page.
Built for [Nova](https://github.com/Andre-cmd-rgb/nova), works on any Wayland desktop.

**Work in progress: 1.0.0-beta.1 is being built.**

- Chromium's own video path on Wayland: hardware decoding on the integrated GPU, measured
  at Chrome's GPU cost and a third less memory (see `docs/ARCHITECTURE.md`).
- Ad and tracker blocking built in, YouTube's video ads included.
- Tabs in a sidebar or along the top, a command bar (Ctrl+K) for addresses, Google
  search, open tabs and history. No toolbar, no start page, no account, no telemetry.
- Netflix and Spotify play: it runs on castlabs' Electron, which carries Google's licensed Widevine.
- Imports passwords, logins, bookmarks and history from Chrome once; Chrome is not needed after.
