# Shared UI System

One design language for all of Ben's app UIs (fleet monitor, kiosk control, admin panels, internal tools). Every project should feel like a sibling: same tokens, same controls, same motion, same rules. Each one keeps its own accent hue and its own layout.

Client-facing marketing sites are out of scope unless a task says otherwise.

Read this whole file before touching UI. `ui-tokens.css` is the source of truth for values; this file is the source of truth for how to use them.

---

## 0. The golden rule: unify the look, keep the behaviour

This is a **reskin and consistency pass**, not a redesign. The app must work exactly as it did before.

- Do not remove, rename or merge features, routes, actions, settings, API calls, polling, stores or URL params.
- Do not change what a button does, what a form submits, or when data loads.
- Do not restructure a screen's layout unless it breaks a rule in section 12. If a component already works and looks right, only swap its values for tokens.
- Components listed under **Project notes** (section 14) as approved are re-tokened only. Layout, proportions and iconography stay.
- If a change makes something look or feel worse, revert that component with git rather than iterating on it.
- JavaScript only. No TypeScript, no `lang="ts"`.
- No code comments except `// TODO:`.

---

## 1. Install

1. Copy `ui-tokens.css` to `assets/css/ui-tokens.css`.
2. In `assets/css/main.css`:
   ```css
   @import "tailwindcss";
   @import "./ui-tokens.css";

   :root {
     --accent-hue: 165;
   }
   ```
   Then add project-specific aliases below it (section 3).
3. Fonts: `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, imported once in `nuxt.config` `css`.
4. Icons: `@nuxt/icon` with `@iconify-json/lucide`. Lucide only, one stroke width (2, or 1.75 if the app already uses that — pick one and keep it).
5. Headless primitives: `reka-ui` (Nuxt module) for Select (rich), Tooltip, Popover, DropdownMenu, Dialog, Drawer, Toast. No styled component libraries.
6. Theme switching sets `data-theme="light|dark"` on `<html>`, or removes it for System. Nothing else changes on theme switch.

What `ui-tokens.css` enforces by design:
- The default Tailwind palette is removed. `text-green-600`, `bg-white`, `bg-slate-100` produce nothing. Only semantic colours exist.
- `text-3xl` and up, `font-bold`, and `tracking-wider/widest` don't exist. Hero type and shouting labels can't be written.
- Light and dark come from one definition per token via `light-dark()`, driven by `color-scheme`. That also makes native select dropdowns, scrollbars and form controls follow the theme.
- Touch devices automatically get 44px controls. Reduced-motion users automatically get fades instead of movement.

---

## 2. Surface profiles — density belongs to a region, not an app

Most screens mix more than one of these. Choose per region.

| Profile | Used for | Control height | Body text | Row height | Spacing feel |
|---|---|---|---|---|---|
| **Monitor** | Tables, lists, logs, fleet views | `ctl-sm` / `ctl-md` | `text-sm`–`text-base` | `row` (36px) | Tight |
| **Control** | Buttons, remotes, toggles, schedules | `ctl-lg`, 44px touch, 56px+ remote keys | `text-base` | — | Roomy |
| **Form** | Settings, editors, login | `ctl-md` | `text-base` | — | Medium |
| **Reading** | Detail drawers, docs, notes | — | `text-base`, max 70ch | `row-comfortable` | Airy |

- A user "Compact density" setting only affects **Monitor** regions. Controls and forms never shrink.
- A dense table next to a roomy control card on the same page is correct.

---

## 3. Colour

### Use only semantic tokens

| Need | Utility |
|---|---|
| Page background | `bg-canvas` |
| Card / panel | `bg-surface` + `border-border` + `shadow-card` |
| Popover, menu, drawer | `bg-surface-raised` + `shadow-popover` / `shadow-overlay` |
| Inset areas, code blocks, disabled | `bg-surface-sunken` |
| Hover / pressed backgrounds | `bg-surface-hover` / `bg-surface-active` |
| Text | `text-text`, `text-text-muted`, `text-text-subtle`, `text-text-disabled` |
| Borders | `border-border`, `border-border-subtle`, `border-border-strong`, `border-border-input` |
| Primary action, selected state | `bg-accent text-accent-fg`, hover `bg-accent-hover`, pressed `bg-accent-active` |
| Selected-but-quiet (row, nav item, day chip) | `bg-accent-muted text-accent-text` |
| Status | `success`, `warning`, `danger`, `info`, `neutral` — each has base (dots, icons), `-fg` (text), `-bg` (tint), `-border` |

### Project aliases

Projects alias domain meanings onto shared tokens in their own `main.css`, never new raw colours:

```css
@theme {
  --color-status-down: var(--color-danger);
  --color-status-degraded: var(--color-warning);
  --color-status-healthy: var(--color-success);
  --color-status-held: var(--color-neutral);
  --color-hygiene-eol: var(--color-warning-fg);
}
```

### Rules

- **One accent per app**, set with `--accent-hue`. It's used for the primary action per card, selection, focus and links. Nothing else.
- In apps that show status, keep the accent hue at least 30° away from 150 (green), 75 (amber) and 27 (red). If the brand colour is green, put the brand on the logo (`--color-brand`) and use a neutral or blue accent.
- Status colours mean status. Running/On/Live/Healthy is green on control surfaces. On monitoring tables where most rows are healthy, healthy is a small green dot with no tinted background, so problems stand out.
- Red means broken or destructive. Amber means degraded or "needs attention soon". Outdated software is amber at most, never red.
- Never colour alone: every status has a dot, icon or word too.
- Tints come from the token file (`-bg`, `-muted`). Avoid `/10`, `/20` opacity modifiers in components.
- Charts read colours from CSS variables at runtime (`getComputedStyle`), never a JS palette.

---

## 4. Typography

- Sizes: `text-xs` 12 · `text-sm` 13 · `text-base` 14 · `text-md` 16 · `text-lg` 18 · `text-xl` 20 · `text-2xl` 24. Page titles are `text-xl`. Nothing larger exists.
- Weights: `font-normal`, `font-medium`, `font-semibold`. Max two weights per component.
- `font-mono` for hosts, IPs, MACs, versions, IDs, durations in tables. Always with `text-text-muted` unless it's the primary value.
- `tabular-nums` on every number that updates or sits in a column.
- Sentence case everywhere. Uppercase only for real acronyms (PBX, SIP, IP, MAC, EOL).
- Max ~3 type sizes on one screen region.

### Eyebrows — allowed, rarely

An eyebrow is the small uppercase label above a heading. Overused, it's the clearest sign of a templated AI UI.

- Use the single `.eyebrow` class. Never hand-roll `uppercase tracking-wide text-xs`.
- **At most one per view.** Only to group a set of sections when the heading alone would be ambiguous (e.g. "Danger zone" above destructive settings, "Schedule" above several schedule cards).
- Never above the page title. The nav already says where you are.
- Never above a card title, table header, stat, modal title or form label.
- Never stacked with a subtitle. Eyebrow + heading + subtitle is a landing page.
- If removing it loses nothing, remove it.

---

## 5. Spacing & layout

| Token | Value | Use |
|---|---|---|
| `p-page` / `gap-page` | 24px (16px on phones) | Page gutter |
| `gap-section` | 24px (16px on phones) | Between cards/panels |
| `p-card` | 20px (16px on phones) | Card padding |
| `gap-group` | 20px | Between groups inside a card |
| `gap-field` | 8px | Label → control, control → helper text |
| `gap-inline` | 8px | Between adjacent buttons/chips |

- Ops UIs are full-bleed. No centred `max-w-7xl` wrappers. Reading regions cap at ~70ch.
- Buttons size to their content (min ~96px). Full-width only on phones or as the single action in a narrow form.
- Fuse buttons into a segmented control **only** for mutually exclusive state (On/Off, Light/Dark/System). Start/Restart/Stop are separate actions with gaps.
- Align to a shared edge. Don't float a status dot at the far end of a card away from its label.
- Collapse dead space rather than stretching content to fill it.
- No horizontal page scroll at 390px wide.

---

## 6. Components

Build each once in `components/ui/` and use it everywhere. Nuxt auto-imports them as `UiButton`, `UiSelect`, etc. Replace ad-hoc markup with these without changing the parent's props, events or behaviour.

### Button
- Variants: `primary` (accent fill), `secondary` (border, surface), `ghost` (no border), `danger` (danger-fg text, danger-border, danger-bg on hover), `warning` (same pattern with warning). One `primary` per card.
- Sizes map to `ctl-sm`, `ctl-md`, `ctl-lg`. Horizontal padding 12–16px. Radius `rounded-md`.
- Icon + label for actions. Icon-only buttons are square, need `aria-label` **and** a tooltip.
- States, all required: rest, hover, `pressable` (scale on press), focus-visible, disabled, **loading** (spinner replaces the icon, label stays, width doesn't jump, button disables, `aria-busy`).
- Renders `<NuxtLink>` when given `to`, `<button type="button">` otherwise.

### Input
- Height `ctl-md`, `px-3`, `rounded-md`, `border-border-input`, `bg-surface`.
- Units as an inline suffix inside the field ("150 s"), not "(sec)" in the label.
- Helper text below in `text-sm text-text-muted`; error text replaces it in `text-danger-fg` with `aria-invalid` + `aria-describedby`.
- Focus is the outline ring only. Never change border colour or width on focus (it causes the double-border bug).

### Select
`ui-tokens.css` already fixes every native `<select>` globally (chevron spacing, height, padding, dark dropdown list). Rules:
- **Native `<select>`** for plain text choices (theme, density, timezone). It's accessible and mobile-native for free.
- **Reka `SelectRoot`** only when options need icons, descriptions, groups or search. Style its trigger identical to the native one, its content with `.ui-pop` + `bg-surface-raised shadow-popover rounded-lg p-1`, items `h-ctl-sm px-2 rounded-sm`, highlighted `bg-surface-hover`, selected shows a check icon.
- Never `appearance: none` without reserving right padding for the chevron. Text must never touch or run under it.
- Never style the select with a different height, radius or font size from inputs beside it.
- Label above with `gap-field`, matching inputs.

### Toggle / switch
- For instant on/off settings only (no save button). Track uses `bg-surface-active` off, `bg-accent` on. Thumb animates with `--dur-fast` `--ease-standard`.
- Label on the left or right consistently across the app, clickable. If the effect isn't obvious, add a tooltip, not a paragraph.

### Segmented control
- For 2–4 mutually exclusive options. Selected segment `bg-surface-raised shadow-xs` inside a `bg-surface-sunken` track, or `bg-accent-muted text-accent-text`. Reflects live state.

### Checkbox / day pickers / chips
- Selected = accent fill or `accent-muted`. Unselected = outline. The two must be distinguishable at a glance and in greyscale (add a check icon if needed).

### Card
- `bg-surface border border-border rounded-lg shadow-card p-card`. Title `text-md font-semibold`. Actions top-right in the header row.
- No nested cards. Inside a card, separate groups with `gap-group` or a `border-border-subtle` divider.

### Table (Monitor profile)
- Real `<table>`. Sticky header (`bg-surface`, `z-(--z-sticky)`). Header text `text-sm text-text-muted font-medium`, sentence case.
- Rows `h-row`, hover `bg-surface-hover`. Whole row clickable if it leads somewhere (real link inside, keyboard focusable).
- Text left, numbers right with `tabular-nums`. Mono for IPs/MACs/versions.
- Relative time with absolute on tooltip. Emphasise only stale values.
- Columns where every row is identical are hidden or collapsed into a header note.

### Status indicator
- Dot (`size-2 rounded-full bg-success`) + word. In chips: `bg-success-bg text-success-fg`. Live things get `animate-live` on the dot — only the one "Live/connected" indicator per screen, not every row.

### Popover / dropdown menu
- Reka primitives with `.ui-pop` (handles open/close animation and side-aware origin). `bg-surface-raised shadow-popover rounded-lg`, padding 16px for forms, 4px for menus. `z-(--z-popover)`.
- Anchored to the trigger, flips/shifts to stay in the viewport, never overlaps sidebars or screen edges. Closes on outside click and Esc, returns focus to the trigger.

### Drawer
- Right side, `.ui-drawer`, `bg-surface-raised shadow-overlay`, width ~480–560px (full-width on phones). `.ui-scrim` behind it only when it's modal.
- URL-addressable when it shows an entity (`?server=x`). Esc closes, focus returns to the row that opened it.

### Dialog
- Only for blocking decisions: irreversible destructive actions, unsaved-changes warnings. `.ui-dialog`, `.ui-scrim`, max-width ~440px. Never for detail views (use a drawer).

### Toast
- `.ui-toast`, bottom-right (bottom-centre on phones), `z-(--z-toast)`. Only for results of actions the user took that finished elsewhere or off-screen. Not for background polls. Auto-dismiss 4–6s, pause on hover, include undo where possible.

### Empty, loading, error states
- Initial load: `.ui-skeleton` blocks shaped like the final layout. Never a full-page spinner.
- Background refresh: keep current data visible, update the freshness indicator, flash changed cells once with `.ui-flash`.
- Empty: one short line, optionally a small illustration (section 10), and the next action if there is one.
- Error: inline, in the region that failed, with a retry. A single failing item never takes down the page.

---

## 7. Motion

Motion explains what changed and where things went. It never decorates.

### Tokens
- Durations: `--dur-instant` 75ms · `--dur-fast` 120ms · `--dur-base` 160ms · `--dur-slow` 220ms · `--dur-slower` 320ms.
- Easing: `ease-out` for anything entering · `ease-in` for anything leaving · `ease-standard` for state changes in place (hover, toggle, colour) · `ease-in-out` only for looping (live pulse).

### Principles
- **Exits are faster than entries** (roughly 2/3 the time). People wait for things to arrive, not to leave.
- **Things come from where they live.** Popovers grow from their trigger side (`.ui-pop` handles `data-side`), drawers slide from their edge, toasts rise from the bottom.
- **Small distances.** 4px shift, 0.96 scale. Big swoops feel slow and cheap.
- Only animate `opacity` and `transform` (and `grid-template-rows` for collapse). Never `height`, `width`, `top`, `left` or `box-shadow` on large elements.
- Animations must be interruptible. Reopening mid-close should reverse cleanly, not queue.
- Reduced motion keeps the fades and drops all movement. This is automatic if you use the provided classes.

### Which class to use

| Thing | Reka (data-state) | Own component (`<Transition name>`) | In | Out |
|---|---|---|---|---|
| Popover, menu, select list | `.ui-pop` | `pop` | base / ease-out | fast / ease-in |
| Tooltip | `.ui-pop .ui-tooltip` | — | fast after delay | instant |
| Drawer | `.ui-drawer` + `.ui-scrim` | `drawer` + `fade` | slow / ease-out | base / ease-in |
| Dialog | `.ui-dialog` + `.ui-scrim` | — | slow / ease-out | fast / ease-in |
| Toast | `.ui-toast` | — | slow / ease-out | fast / ease-in |
| Accordion, "More keys", details | `.ui-collapse` + `data-open` | — | slow / ease-out | same |
| Swapping content in place | — | `fade` with `mode="out-in"` | base | fast |
| Reordering lists | — | `<TransitionGroup>` + `list-move` | slow / standard | — |
| Press feedback | `.pressable` | — | instant | — |
| Hover, toggle thumb, colour change | `transition-colors duration-(--dur-fast) ease-standard` | — | fast | fast |
| Changed value after refresh | `.ui-flash` | — | 1.2s fade-out | — |

### Don't
- Bounce, spring overshoot, elastic or wobble.
- Animated counters, number tickers, confetti, shimmer on anything other than skeletons.
- Page transitions between routes (keep them instant, or a 120ms fade at most).
- Staggered entrance animations on dashboards or tables.
- Animation on every poll or data refresh.
- Durations over 320ms for UI chrome.
- Animating focus rings.

---

## 8. Tooltips

Reka `TooltipProvider` once at the app root with `delay-duration="500"` and `skip-delay-duration="300"` (moving between tooltips is instant).

### Add a tooltip when
- A button is **icon-only**. Always. Include the keyboard shortcut if there is one.
- Text is **truncated** (vendor names, long hostnames, URLs). Show the full value.
- A value is **relative or abbreviated**: "2m ago" → full timestamp with timezone; "1.6.6" → full build string; "EOL" → what's EOL and since when.
- A term is **domain jargon** the label can't explain: Keepalive, Wake delay, Kick VT, DP-1, Held.
- A control is **disabled** — say why ("Chrome is already running"). Wrap the disabled button in a `<span tabindex="0">` trigger, since disabled elements don't fire pointer events.
- A status dot or icon stands alone without a word.

### Don't add a tooltip when
- It repeats the visible label ("Save" → "Save").
- The information is essential to complete the task. Put that on the page.
- It needs more than ~2 short lines. Use helper text, a popover or docs.
- Touch is the only input. Tooltips are a bonus there, never the only path to information.
- It replaces a helper sentence that should be deleted instead.

### Spec
- `.ui-pop .ui-tooltip`, `bg-surface-raised shadow-popover rounded-md px-2 py-1 text-sm text-text max-w-60`. Side `top` default, flips. 6px offset. Small or no arrow — pick one app-wide.
- Opens on hover **and** keyboard focus. Esc closes. `aria-describedby` via Reka.
- Never interactive content inside a tooltip (links, buttons). That's a popover.

---

## 9. Feedback & state

- Every action gives feedback within 100ms: pressed state immediately, loading state while in flight, then success or error.
- Success: inline in the component that triggered it ("TV turned on · just now") or a toast if the result is elsewhere. Error: inline with retry.
- Controls show **current state**: if a thing is running, "Start" is disabled (tooltip says why) and "Stop" is enabled; segmented controls show the live value.
- Confirm only irreversible destructive actions. Reversible actions (ack, snooze, toggle) happen immediately with undo.
- Data freshness lives in **one** place (top bar or status bar): live / stale (with age) / disconnected. Not repeated under every section.
- Long-running jobs show progress or at least elapsed time, never an indefinite spinner with no context.

---

## 10. Icons & images

- **Standard glyphs** (chevrons, power, play, stop, refresh, trash, copy, external link, search, close, settings, status shapes): Lucide via `<Icon name="lucide:power" />`. Size 16px in dense UI, 18–20px in control surfaces. Colour via `currentColor`.
- **Bespoke assets** (app mark, favicon set, empty-state illustrations, custom device glyphs Lucide lacks): use your **image generation skill**. Never hand-draw SVG illustrations, use emoji, or hotlink/stock images.
  - One style across all projects: flat monochrome line art, single stroke weight, transparent background, no text, no gradients, no 3D, no people, no glowing-tech clichés.
  - Neutral grey output, recoloured with CSS `mask-image` + `background-color: var(--color-text-subtle)` so it follows the theme.
  - Small and quiet: empty-state art ≤ 160px tall.
  - Log every prompt in `docs/image-prompts.md`. Reuse the same base style prompt across projects so the set stays consistent.
  - If a project already has an approved icon or mark (section 14), don't regenerate it.
- Every image has `alt`, or `alt=""` + `aria-hidden="true"` if decorative.

---

## 11. Copy

- Headings name the thing ("Controls", "Network", "Fleet"). No taglines, no "Your …", no "… in one place".
- Delete helper sentences that explain obvious UI. Keep helper text that adds real information ("2m 30s between pings").
- Facts with numbers beat adjectives: "Registrations 12, normally ~40" not "Registration anomaly".
- Buttons are verbs: "Restart Chrome", not "Chrome restart" or "OK".
- One word per concept across the app (don't mix "Held", "Paused", "Suspended" for the same state).
- Times show timezone once (status bar), not in every cell.

---

## 12. Anti-rules

Smart rules, not blanket bans — each says when it applies.

### Layout
- ❌ Landing-page patterns in tools: hero, eyebrow + giant H1 + subtitle, centred narrow column.
- ❌ Stretching buttons across a column to fill space.
- ❌ Fusing unrelated actions into one segmented bar.
- ❌ Permanent banners for steady states (read-only, a held server). Banners are for transient events (disconnected).
- ❌ KPI tiles with giant numbers that don't link anywhere.
- ❌ Nested cards.
- ❌ Modals for detail views.
- ❌ Making controls compact because a table on the same page is compact.

### Colour
- ❌ Raw palette classes, hex/rgb/oklch, or arbitrary colour values in components.
- ❌ `dark:` colour variants in components. If one is needed, the token is wrong.
- ❌ More than one accent colour.
- ❌ Accent used for status, or status colours used for decoration.
- ❌ Grey for running/healthy on control surfaces (it reads as off).
- ❌ Tinted status backgrounds on every healthy row in a monitoring table (problems stop standing out).
- ❌ Red for anything that isn't broken or destructive.
- ❌ Gradients, glassmorphism, glows, neon.

### Typography
- ❌ More than one eyebrow per view, or eyebrows above titles/cards/forms.
- ❌ Decorative uppercase + letter-spacing anywhere except the `.eyebrow` class.
- ❌ Dot-separated chains of unrelated metadata.
- ❌ Proportional numerals in columns or live values.
- ❌ Muted text on muted backgrounds below 4.5:1.

### Controls
- ❌ Changing border colour/width on focus. Use the outline ring.
- ❌ Selects whose text runs into the chevron, or whose height/radius differs from inputs.
- ❌ Buttons without hover, pressed, focus, disabled and loading states.
- ❌ Silent clicks (no visible feedback).
- ❌ Icon-only buttons without a tooltip and `aria-label`.
- ❌ Disabled controls with no explanation.
- ❌ `<div @click>` as a button or link.
- ❌ Confirmation dialogs for reversible actions.

### Motion
- ❌ Animating height/width/top/left, bounce/spring, staggered dashboards, number tickers, animation on refresh, durations > 320ms, entries and exits at the same speed.

### Data
- ❌ Columns where every row has the same value.
- ❌ Relative times without an absolute tooltip.
- ❌ Raw build strings in dense views.
- ❌ Fake or placeholder data, sparklines or trends.
- ❌ Full-page spinners on refresh.

### Code
- ❌ TypeScript. ❌ Comments other than `// TODO:`. ❌ Styled UI libraries (Vuetify, PrimeVue, Element). ❌ Business logic in templates. ❌ Re-implementing date/number formatting per component (one `useFormat` composable). ❌ Changing behaviour to make styling easier.

---

## 13. Accessibility

- WCAG 2.2 AA in both themes, including muted text, chips and focus rings.
- Everything works by keyboard: focus order follows visual order, `focus-visible` rings on every interactive element, Esc closes overlays and returns focus.
- Touch targets ≥ 44px on coarse pointers (automatic for `ctl-*` tokens).
- Status never relies on colour alone.
- Live regions announce state **changes** only, never routine polls.
- `prefers-reduced-motion` respected (automatic via tokens).

---

## 14. Project notes

Fill this in per repo. Codex: read it, respect it, don't edit it.

```
Project: 
Accent hue: 
Profiles used: 
Approved — re-token only, don't redesign:
  - 
Known quirks / don't touch:
  - 
```

---

## 15. Process for each project

1. **Baseline.** Before changing anything: screenshot every route and major state at 1440×900 and 390×844, light and dark, into `docs/ui-baseline/`. Write `docs/ui-behaviour.md` listing every action, what it does, and every setting. This is the contract that must still hold at the end.
2. **Install tokens** (section 1). Set the accent hue. Add project aliases.
3. **Map old values.** Replace every hardcoded colour, size, radius, shadow and duration with tokens. Report anything that had no clear mapping.
4. **Shared components.** Create/align `components/ui/` (Button, Input, Select, Toggle, SegmentedControl, Card, Tooltip, Popover, Drawer, Dialog, Toast, StatusDot, Skeleton). Swap usages without changing props, events or behaviour.
5. **Motion.** Apply the classes from section 7 to every overlay, disclosure and press.
6. **Tooltips audit.** Walk every screen against section 8. Add where required, remove where redundant.
7. **Copy & eyebrow audit.** Section 4 and 11.
8. **Verify.**
   - Re-screenshot the same set and compare with the baseline. Anything that looks worse gets reverted or fixed.
   - Walk `docs/ui-behaviour.md` and confirm every action still works.
   - Keyboard-only pass. Reduced-motion pass. Phone-width pass.
   - Run the grep below — it must return nothing in `components/`, `pages/`, `layouts/`, `app.vue`.
9. **Report** what changed, what was restored, and every `// TODO:` left behind.

```bash
grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|-\[[^]]*\]|\b(text|bg|border|ring|fill|stroke)-(red|green|amber|yellow|blue|slate|gray|zinc|neutral|stone|white|black)(-[0-9]+)?\b|\bdark:|lang=\"ts\"|uppercase tracking" components pages layouts app.vue
```

### Acceptance
- The app behaves exactly as `docs/ui-behaviour.md` says.
- Side by side with another project, it's obviously the same family: same controls, type, spacing, motion, focus ring.
- No select text touches its chevron. No two controls closer than 8px. No control under 44px on touch.
- Every overlay opens and closes with the shared motion, faster out than in.
- Every icon-only button, truncated value, relative time, jargon term and disabled control has a tooltip.
- At most one eyebrow per view.
- Grep is clean.