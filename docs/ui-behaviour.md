# TV Kiosk Control: UI behaviour baseline

26 October 2026. Baseline revision: f493d98f; current static release on port 8080.

This records existing behaviour before the next UI pass. It is not permission to implement, deploy, roll back, change permissions or carry out operational actions. DESIGN.md section 15 step 1 only.

Screenshots use Chromium at **1440×900** and **390×844**, in light and dark. Each screenshot is a viewport capture; supplementary `-full.png` files show long pages. Phone width is browser emulation, not physical touch-device testing. See [baseline images](ui-baseline/index.html) and [capture metadata](ui-baseline/manifest.json).

Data is isolated simulation or explicitly labelled recorded/fixture data. Screenshots do not report current service health, real orders, purchases or transcription performance. Static assets were checked against the deployed release. Production transactions, TV commands, router provisioning and audio processing were not exercised. Descriptions of those effects come from source review.

The [source control inventory](ui-source-controls.md) enumerates event bindings, editable values and static control identifiers with file/line references. It supplements the behaviour descriptions below so small controls are not lost in a later pass.

## Routes and states

One route, `/`. Major regions are status, Controls, Display URL, Schedule/calendar, Remote, Display recovery, Dashboard login and Network. Settings is a modal; More keys is a disclosure. Panasonic/Sony settings, keyboard mode, disconnected and initial-loading states are captured separately. Supported remote keys are conditional on the TV backend; the fixture has a smaller supported-key list than the user's screenshot. The attached screenshot is additional evidence for the full remote layout.

## Actions and effects

| Action | Existing effect and constraint |
| --- | --- |
| TV on & start Chrome | POST `/api/launch`; coordinated TV/kiosk start. |
| Stop Chrome & TV off | POST `/api/shutdown`; coordinated shutdown. |
| Chrome Start / Restart / Stop | Separate POST requests to `/api/chrome/start`, `/restart`, `/stop`. These are actions, not a single mutually exclusive preference. |
| Clear cache | Existing confirmation precedes `/api/chrome/clear-cache`; clears cache and restarts the kiosk while retaining cookies/logins. Preserve that distinction, confirmation and feedback. |
| TV On / Off | POST `/api/tv/on` or `/off`; off behaviour depends on configured mode. |
| Display URL: Save & restart | Saves the entered URL and restarts Chrome. Editing the field alone does not perform the restart. |
| Schedule enable, times, default days, keepalive, wake delay | Save immediately through the existing config request. Do not turn these into unsaved form drafts incidentally. |
| Calendar previous / next | Changes displayed month only. |
| Calendar date | For an editable date, toggles an override relative to the weekly default; toggling back removes the override. Past dates stay disabled. Saves config. |
| Stop Sonos at off time | Saves whether the scheduled TV-off action also stops Sonos. It does not start playback automatically. |
| Sonos Play / Pause | POST `/api/sonos/play` or `/pause`; immediate device actions. |
| Remote keys | POST `/api/tv/remote/<key>`; keys include input/home/menu, information/options, arrows/confirm/back/exit, volume/mute, digits, channels, coloured keys, apps and aspect when supported. Preserve the backend's supported-key filtering. |
| Keyboard | Locally enables/disables remote keyboard capture. Preserve key mappings, editable-field exclusions, pressed feedback and the visible enabled state. |
| More keys | Expands/collapses the additional remote controls, without sending a remote key. |
| Menu is back on Screen Display | Acknowledges the TV menu state via `/api/tv/menu-synced`; distinct from sending a menu-navigation key. |
| Kick VT / Reset display | POST `/api/display/kick` or `/reset`; real display recovery actions. |
| Auto-login toggle / Re-login now | Toggle saves config; re-login POSTs `/api/relogin` using the existing saved credentials. Do not expose credentials in the UI. |
| Network Online only | Browser-local filter persisted as `networkOnlineOnly`. |
| Network Refresh | Reads `/api/network/hosts`; IP links retain their existing destinations. |
| Settings open / Cancel / Close | Opens/closes the settings dialog. Cancel does not save. |
| Settings Save | Persists the settings fields through existing config handling. |
| Save & test | Saves TV connection settings, then POSTs `/api/tv/test`; not a passive connection display. |
| Theme | Browser-local light/dark preference (`theme`); follows the system when no choice is saved. |

## Every editable setting

| Group | Fields and meaning |
| --- | --- |
| Display | Display URL. |
| Schedule | Enabled; on time; off time; Monday–Sunday defaults; per-date overrides; keepalive seconds (30–3600); wake delay seconds (0–60); Stop Sonos at off time. |
| TV connection | Sony Bravia/Panasonic Viera; TV IP; HDMI port 1–4; Sony pre-shared key; TV MAC; HDMI-CEC option. These are existing settings, not new authorisation to alter them. |
| TV power mode | Standby versus screen off; normal and cold-start screen-off key sequences, where supported. Preserve model-specific field visibility. |
| Other integrations | Network scanner URL; Sonos IP; dashboard auto-login enabled. |
| Browser | Theme; Network Online only; temporary keyboard-control mode; open calendar month and More keys disclosure. |

## Polling and feedback

Status reads every 10 seconds; network list and clock update every 30 seconds. Operational actions schedule additional status refreshes. Existing toasts and inline status must remain; no action may become a silent click. Closing this page does not stop the server's existing kiosk scheduling.

## Baseline defects to keep visible for the next decision

The current stylesheet makes successful/running control states neutral grey. `.join` has a measured 0px gap; Start/Restart/Stop and volume actions are visually fused. Buttons are 32–36px in desktop control regions and 40px at 390px width, below the new brief's 44px touch target. Fields and control spacing are compressed. Remote arrangement, key mappings and calendar behaviour must survive any correction. The user prefers the earlier TV presentation; do not interpret this baseline as approval of the current appearance.
