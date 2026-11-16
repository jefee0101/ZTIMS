# Google button display fix

Reproduced on the existing live sign-in page using a clean, signed-out Edge
profile: a light-rendered Google button stayed light after the page changed
to dark; its iframe inherited the dark colour scheme and showed a white
canvas around transparent padding. The hidden container also measured as zero,
so the old fixed fallback requested 320px inside a 300px phone container.

## Change

- Sign-in, sign-up and account reconfirmation share `shared/google-button.js`.
  The existing Google initialization and credential callbacks remain in place.
- Reveal the sign-in/up host before measuring. Render using its actual width,
  capped at Google's supported 400px maximum. Observe container resizing and
  the root's theme class, coalescing updates and skipping unchanged renders.
- Keep Google's standard pill: `outline` in light, `filled_black` in dark.
  No custom Google branding, hidden click target or sign-in-flow substitution.
- Only the Google iframe gets `color-scheme: light`, preserving its transparent
  canvas while Google draws the button's requested dark/light theme itself.
- Remounting disposes previous observers; hidden hosts wait for a usable size.

## Verification

- Frontend check: 44 pages, zero undefined-name errors, 145 open-days checks.
  Production build passed. Backend module loads; existing startup rate-limiter
  warnings are unrelated to this frontend-only change.
- Required local Postgres/API regression checks also passed: 61 room/report
  assertions and 36 room-payment/entrance-removal assertions, using the local
  Xendit stand-in and synthetic records only.
- 72 browser assertions passed on compiled production pages, displayed under
  the authorized site origin using local response interception. Google's actual
  SDK/button iframe was used, with the public client configuration. Tested
  sign-in, sign-up and account reconfirmation at 1440px and 390px; light → dark
  → light; resize to 320px; matching theme/width; one current button; no page
  script errors. Dark screenshots' outer-corner pixels confirm no white matte.
- All app-origin production writes were blocked. Account reconfirmation used
  synthetic account metadata; no real account was opened or deleted. No actual
  Google login, credential exchange or account deletion was performed.
- Home markup/styles, backend routes, schema, credentials, CSP hosts and the
  approved-but-unbuilt Compact rail navigation design are unchanged.

Screenshots and external test harness:
`C:/Users/HP/Documents/Codex/scratchpad/ztims-google-button`.
No personal account labels, email addresses, tokens or credentials are saved
in this report or repository.

Google's supported theme/width API:
https://developers.google.com/identity/gsi/web/reference/js-reference#GsiButtonConfiguration.
No SQL update or environment-variable change is needed for this fix.
