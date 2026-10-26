# TV Control UI verification — 26 October 2026

Restores green running states, separate action buttons, 64px remote controls and clear selects. Tailwind utilities are compiled locally; the browser no longer loads DaisyUI or Tailwind from a CDN. Controller scripts, remote-key availability and request cadence are unchanged.

## Verified

- 9 baseline states, 36 viewport captures: 1440×900 and 390×844, light and dark. No JavaScript exceptions or horizontal page overflow in the completed captures.
- 7 automated tests pass. The repository’s existing build command passes where applicable.
- Keyboard and focus checks retain Escape dismissal and focus return. Native selects reserve 36px for the chevron and use a single outline. Coarse-pointer checks cover 44px controls and label targets; TV remote keys are 64px.
- Script bodies in the captured Vue/HTML entry points match the baseline. Presentation-only theme handling and success styling are the documented exceptions. No new production transactions, calls, audio processing, TV commands or router provisioning were used for verification.

## Scope and implementation notes

The supplied DESIGN.md and ui-tokens.css are retained. ui-base.css is the plain-browser adaptation used by existing applications; Tailwind-only directives are converted and nested keyframes lifted. Inter Variable and JetBrains Mono Variable are local assets with their licences. Existing controls use shared token aliases without changing their public props or events.

Existing specialised layout dimensions and working interaction primitives are retained. This pass does not replace every legacy primitive with Reka, introduce a new component for each HTML element, or claim a complete WCAG audit. Existing device-specific icons and native title tooltips remain where replacing them would add a separate interaction change. No new TODO comments were added.

The baseline is in ui-baseline/ and the after captures in ui-after/. Images use isolated simulation or dated recorded data, not live activity. Physical camera scanning, live warehouse writes, purchases, real audio/GPU jobs and hardware effects are covered by unchanged source contracts and relevant automated tests rather than executed on production.

The dependency audit also reports existing Express transitive advisories (body-parser, proxy-addr and qs). The new stylesheet compiler introduced none of those. Production dependencies are unchanged by this static UI release; security upgrades are separate work.
