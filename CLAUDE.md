# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Kiosk controller for a Linux-on-TV setup: a small Express app that manages a Chromium kiosk, a TV (Sony Bravia over IP Control, or Panasonic Viera over its network remote), and the Linux VT/GDM session that hosts the display. Intended to run as a long-lived service on the kiosk host itself.

## Commands

- `npm install` — install deps (`express`, `node-cron`)
- `npm start` — run the server on `0.0.0.0:8080` (same as `node server.js`)
- `node -c server.js` (and `panasonic.js`) — syntax check

There is no build step, no test suite, and no linter configured.

## Architecture

`server.js` (backend + scheduler) and `public/index.html` (single-page UI, served statically) do most of the work; `panasonic.js` is the Viera TV driver. State lives in `config.json` at the repo root — gitignored, auto-created from `defaultConfig` on first load, mutated by `POST /api/config` from the UI.

### Four control surfaces

1. **Sony TV (Bravia IP Control)** — `sonyApi()` POSTs JSON-RPC to `http://<tvIp>/sony/...` with an `X-Auth-PSK` header. `tvIp` and `tvPsk` come from `config.json`; defaults are empty, and `sonyApi` rejects when either is missing. `tvOn` switches the TV to HDMI 2 ~3s after power-on, then (verify=on) polls `getPowerStatus` and re-issues the power-on up to 3× — Bravias frequently ACK `setPowerStatus` without leaving deep standby. `tvOff` likewise verifies/retries the power-off.

   **Panasonic Viera** (`tvType: 'panasonic'`, driver in `panasonic.js`) — `tvOn`/`tvOff`/`getTvPowerStatus`/remote keys branch on `config.tvType` (set in the UI's Settings, default `sony`). Unencrypted SOAP on port 55000, as spoken by pre-2018 sets (built for the TX-L55DT65B); 2018+ models need PIN pairing and are only detected (`POST /api/tv/test`), not driven. Things that differ from Sony:
   - Power is a **toggle** key (`NRC_POWER-ONOFF`), so `panasonic.on`/`off` are serialised and only toggle on a state they have just read; don't add blind retries.
   - There is no power-status call: `getState` infers it from the renderer service (200 = on, HTTP error = standby with network up, no connection = off the network). `getTvPowerStatus` maps that to true/false/null, and null is the normal "off" reading — older Vieras drop their network in standby.
   - Because of that, waking has three routes tried by state: HDMI-CEC via `cec-client` (`tvCec`, discrete on/standby), Wake-on-LAN (`tvMac`, learned from `ip neigh` while the TV is on), and the power key once the TV answers in standby.
   - `tvHdmiPort` (1–4, default 2) picks the input for both TV types.
2. **Chromium kiosk** — `launchChrome()` shells out to `chromium --kiosk` with `DISPLAY=:0` (falls back to `:1` via `getActiveDisplay()`) and `--user-data-dir=/home/hybes/.config/chromium-kiosk` (hardcoded — tied to the kiosk host's `hybes` user). Lifecycle is `pkill`/`pgrep` on `"chromium.*kiosk"`. Debian's `/etc/chromium.d/` wrapper injects extra flags (`--load-extension` etc.) at launch — that's expected, not a second launcher.
3. **Scheduler** — the desired on/off state is reconciled, not fired-and-forgotten. `node-cron` `onJob`/`offJob` (pinned to `config.timezone`, default `Europe/London`) and a periodic timer (`reconcileSec`, default 30s) plus a startup pass all call `reconcile()`, which is the single source of truth: it compares `isTvScheduledOn()` against an in-memory edge tracker (`lastScheduledDesired`), turns the TV+Chrome on when entering the window (catching up after a mid-window restart), relaunches Chrome if it died during hours, and runs the full off sequence when leaving the window (so a missed OFF cron tick still shuts down). A mutex (`reconcileRunning`) keeps overlapping calls idempotent. `isTodayActive()` combines `scheduleDays` (Mon=0..Sun=6; **not** JS's `getDay()` — conversion is inline) and per-date `dateOverrides` (absolute `YYYY-MM-DD` keys, boolean values). A keepalive (`setupKeepalive`, `keepaliveSec`) wakes the TV if it is in standby during scheduled hours (for Panasonic, also when it is unreachable) and otherwise sends a remote-key nudge to defeat TV auto-standby. Note: because `reconcile` self-heals during hours, `POST /api/chrome/stop` / `/api/shutdown` won't "stick" inside the scheduled window — Chrome is relaunched within `reconcileSec`.
4. **Display/VT** — `getDisplayInfo()` reads `/sys/class/drm/*` (connector status, DPMS, EDID size) to infer whether the panel is awake. `displayKick()` toggles VTs (`sudo chvt 1` → `sudo chvt 7`). `displayReset()` kills Chromium, `sudo systemctl restart gdm`, waits ~9s, returns to VT 7, relaunches Chromium. `KIOSK_VT = 7` is hardcoded.

### Host requirements (easy to miss)

- Linux with GDM and a `card*` entry under `/sys/class/drm/` — the display logic is Linux-only.
- Passwordless `sudo` (or root execution) for `chvt` and `systemctl restart gdm`.
- Panasonic only, optional: `cec-client` (Debian `cec-utils`) and CEC-capable HDMI hardware for `tvCec`; `ip` (iproute2) for MAC learning.
- The `hybes` user and their Chromium profile path are hardcoded in `launchChrome`; deploying elsewhere means editing that line.
- Runs on port 8080, bound to `0.0.0.0`.

### API surface

All JSON. GET `/api/config`, POST `/api/config`, GET `/api/status` (combines Chrome/TV/schedule/display), GET `/api/display/status`, and POST endpoints for `/api/chrome/{start,stop,restart}`, `/api/tv/{on,off,test}`, `/api/tv/remote/:key`, `/api/display/{kick,reset}`, `/api/launch` (TV on + Chrome), `/api/shutdown` (Chrome kill + TV off).

### Config migration

`migrateConfig()` handles legacy `weekendsEnabled` → `scheduleDays`. Any further schema changes should extend that function rather than forcing users to reset `config.json`.
