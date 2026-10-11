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
   - **Wake guard:** `tvWakeOk` in `config.json` is server-managed (stripped from `POST /api/config`). A failed `tvOn` sets it false, and while it is false the *scheduled* off (`tvOff({ scheduled: true })`) leaves the TV on, because a set that can't be woken would stay dark until someone presses its button. Only a wake by power key (TV answering in standby) sets it true again — a TV that comes on during a Wake-on-LAN/CEC attempt may have been switched on by hand. Manual off always goes through; to clear the flag for a WoL/CEC-only set, edit `config.json`.
   - **Screen-off mode** (`tvOffMode: 'screen'`, for sets that can never be woken): off is `panasonic.screenOff`, which replays key presses to set the TV's own Screen Display option to Off (panel dark, TV still on and on the network); on sends `exit` twice, because any key wakes the panel. Nothing here is verifiable: `X_ScreenState` stays `on`, so `/api/status` `tvScreen` is only the last thing commanded. The presses are blind and depend on where the TV menu was last left, which `tvMenuAt` (server-managed, stripped from `POST /api/config`) tracks: `screen-display` after our own screen-off (use `tvScreenOffKeys`), `top` after a power cycle, when the menu resets (use `tvScreenOffKeysCold`, once), `unknown` after the portal remote sends `menu` (screen-off is skipped until `POST /api/tv/menu-synced`). `watchTvMenuReset()` (every 20s) infers a power cycle only from the TV being off the network and the DisplayPort link being down within 10 minutes of each other; either alone has other causes, and the after-power-on presses sent from the wrong place could change a picture setting. No keepalive nudges out of hours in this mode, since a nudge would switch the panel back on.
   - Keepalive nudges a Viera with `exit` (not `right`, which changes values in its menus) and skips the nudge for 5 minutes after the portal remote is used. `menu`/`exit` keys exist only for Panasonic.
   - `POST /api/tv/test` falls back to `panasonic.discover()` when the saved IP doesn't answer (or is blank): it sweeps the kiosk's own /24 for port 55000 and saves the address of the one Viera it finds.
2. **Chromium kiosk** — `launchChrome()` shells out to `chromium --kiosk` with `DISPLAY=:0` (falls back to `:1` via `getActiveDisplay()`) and `--user-data-dir=/home/hybes/.config/chromium-kiosk` (hardcoded — tied to the kiosk host's `hybes` user). Lifecycle is `pkill`/`pgrep` on `"chromium.*kiosk"`. Debian's `/etc/chromium.d/` wrapper injects extra flags (`--load-extension` etc.) at launch — that's expected, not a second launcher.
3. **Scheduler** — the desired on/off state is reconciled, not fired-and-forgotten. `node-cron` `onJob`/`offJob` (pinned to `config.timezone`, default `Europe/London`) and a periodic timer (`reconcileSec`, default 30s) plus a startup pass all call `reconcile()`, which is the single source of truth: it compares `isTvScheduledOn()` against an in-memory edge tracker (`lastScheduledDesired`), turns the TV+Chrome on when entering the window (catching up after a mid-window restart), relaunches Chrome if it died during hours, and runs the full off sequence when leaving the window (so a missed OFF cron tick still shuts down). A mutex (`reconcileRunning`) keeps overlapping calls idempotent. `isTodayActive()` combines `scheduleDays` (Mon=0..Sun=6; **not** JS's `getDay()` — conversion is inline) and per-date `dateOverrides` (absolute `YYYY-MM-DD` keys, boolean values). A keepalive (`setupKeepalive`, `keepaliveSec`) wakes the TV if it is in standby during scheduled hours (for Panasonic, also when it is unreachable) and otherwise sends a remote-key nudge to defeat TV auto-standby. Note: because `reconcile` self-heals during hours, `POST /api/chrome/stop` / `/api/shutdown` won't "stick" inside the scheduled window — Chrome is relaunched within `reconcileSec`.
4. **Display/VT** — `getDisplayInfo()` reads `/sys/class/drm/*` (connector status, DPMS, EDID size) to infer whether the panel is awake. `displayKick()` toggles VTs (`sudo chvt 1` → `sudo chvt 7`). `displayReset()` kills Chromium, `sudo systemctl restart gdm`, waits ~9s, returns to VT 7, relaunches Chromium. `KIOSK_VT = 7` is hardcoded. On a DisplayPort output the connector can read connected/DPMS On while nothing reaches the TV: after the TV power-cycles, nouveau leaves the link to the HDMI adapter untrained and still reports it good. `getDpLinkOk()` reads the adapter's own lane status over the aux channel (`sudo dd` on `/dev/drm_dp_auxN`, matched to the connector via `/sys/class/drm_dp_aux_dev/*/name`), `/api/status` exposes it as `display.link`, and `healDisplayLink()` (called from `reconcile` during hours, only while the TV reports on) cycles the output with `xrandr --off` / `--mode` to retrain it. A VT switch alone does not retrain.

### Host requirements (easy to miss)

- Linux with GDM and a `card*` entry under `/sys/class/drm/` — the display logic is Linux-only.
- Passwordless `sudo` (or root execution) for `chvt` and `systemctl restart gdm`.
- Panasonic only, optional: `cec-client` (Debian `cec-utils`) and CEC-capable HDMI hardware for `tvCec`; `ip` (iproute2) for MAC learning.
- The `hybes` user and their Chromium profile path are hardcoded in `launchChrome`; deploying elsewhere means editing that line.
- Runs on port 8080, bound to `0.0.0.0`.

### API surface

All JSON. GET `/api/config`, POST `/api/config`, GET `/api/status` (combines Chrome/TV/schedule/display), GET `/api/display/status`, and POST endpoints for `/api/chrome/{start,stop,restart}`, `/api/tv/{on,off,test,menu-synced}`, `/api/tv/remote/:key` (key names per TV type from GET `/api/tv/keys`; the UI hides buttons the TV doesn't have), `/api/display/{kick,reset}`, `/api/launch` (TV on + Chrome), `/api/shutdown` (Chrome kill + TV off).

### Remote panel

Buttons carry `data-key` and go through `remote()` in `public/index.html`, which sends presses one at a time in order and drops key auto-repeat while a press is in flight. Keyboard control is off until toggled from the panel (hidden on touch devices): arrows, Enter = OK, Backspace = Back, Esc = Menu, X/H/I/O/M, +/−, digits, PageUp/PageDown; Space switches it off. It ignores keys while a form field has focus or the settings dialog is open.

### Config migration

`migrateConfig()` handles legacy `weekendsEnabled` → `scheduleDays`. Any further schema changes should extend that function rather than forcing users to reset `config.json`.
