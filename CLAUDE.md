# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Kiosk controller for a Linux-on-TV setup: a small Express app that manages a Chromium kiosk, a Sony Bravia TV (over IP Control), and the Linux VT/GDM session that hosts the display. Intended to run as a long-lived service on the kiosk host itself.

## Commands

- `npm install` — install deps (`express`, `node-cron`)
- `npm start` — run the server on `0.0.0.0:8080` (same as `node server.js`)
- `node -c server.js` — syntax check

There is no build step, no test suite, and no linter configured.

## Architecture

Two files do all the work: `server.js` (backend + scheduler) and `public/index.html` (single-page UI, served statically). State lives in `config.json` at the repo root — gitignored, auto-created from `defaultConfig` on first load, mutated by `POST /api/config` from the UI.

### Four control surfaces

1. **Sony TV (Bravia IP Control)** — `sonyApi()` POSTs JSON-RPC to `http://<tvIp>/sony/...` with an `X-Auth-PSK` header. `tvIp` and `tvPsk` come from `config.json`; defaults are empty, and `sonyApi` rejects when either is missing. `tvOn` additionally switches the TV to HDMI 2 ~3s after power-on.
2. **Chromium kiosk** — `launchChrome()` shells out to `chromium --kiosk` with `DISPLAY=:0` (falls back to `:1` via `getActiveDisplay()`) and `--user-data-dir=/home/hybes/.config/chromium-kiosk` (hardcoded — tied to the kiosk host's `hybes` user). Lifecycle is `pkill`/`pgrep` on `"chromium.*kiosk"`.
3. **Scheduler** — `node-cron` creates `onJob`/`offJob` from `tvOnTime`/`tvOffTime`. Each firing checks `isTodayActive()`, which combines `scheduleDays` (Mon=0..Sun=6; note this is **not** JS's `getDay()` — conversion happens inline) and per-date `dateOverrides` (absolute `YYYY-MM-DD` keys, boolean values). A 4-minute keepalive (`setupKeepalive`) re-issues `setPowerStatus(true)` during scheduled hours to defeat TV auto-standby.
4. **Display/VT** — `getDisplayInfo()` reads `/sys/class/drm/*` (connector status, DPMS, EDID size) to infer whether the panel is awake. `displayKick()` toggles VTs (`sudo chvt 1` → `sudo chvt 7`). `displayReset()` kills Chromium, `sudo systemctl restart gdm`, waits ~9s, returns to VT 7, relaunches Chromium. `KIOSK_VT = 7` is hardcoded.

### Host requirements (easy to miss)

- Linux with GDM and a `card*` entry under `/sys/class/drm/` — the display logic is Linux-only.
- Passwordless `sudo` (or root execution) for `chvt` and `systemctl restart gdm`.
- The `hybes` user and their Chromium profile path are hardcoded in `launchChrome`; deploying elsewhere means editing that line.
- Runs on port 8080, bound to `0.0.0.0`.

### API surface

All JSON. GET `/api/config`, POST `/api/config`, GET `/api/status` (combines Chrome/TV/schedule/display), GET `/api/display/status`, and POST endpoints for `/api/chrome/{start,stop,restart}`, `/api/tv/{on,off}`, `/api/display/{kick,reset}`, `/api/launch` (TV on + Chrome), `/api/shutdown` (Chrome kill + TV off).

### Config migration

`migrateConfig()` handles legacy `weekendsEnabled` → `scheduleDays`. Any further schema changes should extend that function rather than forcing users to reset `config.json`.
