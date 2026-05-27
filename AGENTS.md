# Project rules

Notes for anyone (human or AI) writing code in this repo.

## Pull requests

Always update from the latest `origin/master` before creating a PR. Branch new
PR work from current `origin/master`, not from an older local branch or a branch
whose predecessor PR has not yet been merged/deployed. If a PR is merged while
work continues, rebase or recreate the follow-up branch on the updated
`origin/master` before opening the next PR.

## CSS / UI

### Inputs must never be smaller than 16px on iOS

iOS Safari auto-zooms when you focus an `<input>`, `<select>`, or `<textarea>`
whose computed `font-size` is below 16px, and it does **not** zoom back out
cleanly afterwards. The user is left with a permanently magnified app until
they pinch-out manually.

**Rule:** every focusable text-style control must have a computed
`font-size >= 16px`. This applies to:

- `<input>` (text, search, email, url, tel, number, password, date, time, etc.)
- `<select>`
- `<textarea>`
- Anything with `contenteditable`

Range, checkbox, radio, file, color, button, submit, reset inputs do **not**
trigger the zoom and can be smaller — but it's safest to default to 16px and
only step down when you have a clear visual reason.

**How:**

- The base rule lives in `src/app.css`:
  ```css
  input, select, textarea { font-size: 16px; }
  ```
- Don't override it lower in component styles. If you must change the size,
  keep it `>= 16px` and add a comment noting why.
- Prefer `font-size: 16px` over `1rem`. If we ever change the root font-size,
  rem-based controls drift below 16px silently.
- Visually-hidden checkboxes inside custom chip/toggle components are exempt
  (they never receive direct focus that triggers zoom), but the visible label
  text still follows normal type rules.

When adding a new input, take 30 seconds to confirm the rendered size in
DevTools' computed styles panel. The bug is silent on desktop and only shows
up the first time someone opens the app on an actual iPhone.

## Cursor Cloud specific instructions

Setlist Roller is a client-side Svelte 5 + Vite PWA with no backend of its own.
Data persistence uses [remoteStorage](https://remotestorage.io).

### Quick reference

| Task | Command |
|------|---------|
| Dev server | `npm run dev` (port 4173) |
| Lint | `npm run lint` (Biome) |
| Unit tests | `npm test` (Vitest) |
| E2E tests | `npm run test:e2e` (Playwright + Chromium) |
| Build | `npm run build` |

### E2E test prerequisites

E2E tests require Docker and the armadietto remoteStorage server:

1. Docker must be running (`sudo dockerd` if not already started).
2. Start armadietto: `npm run armadietto:up` (port 8000).
3. Install Playwright browsers: `npx playwright install --with-deps chromium`.
4. The Playwright `webServer` config auto-starts the Vite dev server for E2E
   runs, so you do not need to start it separately.

### Docker-in-Docker gotchas

The Cloud Agent VM runs inside a container. To get Docker working:

- Use `fuse-overlayfs` storage driver (`/etc/docker/daemon.json`).
- Switch iptables to legacy: `sudo update-alternatives --set iptables /usr/sbin/iptables-legacy`.
- Fix socket permissions after starting dockerd: `sudo chmod 666 /var/run/docker.sock`.

### Notes

- The `songs.spec.ts › clearing search restores full list` E2E test is
  occasionally flaky (timing-sensitive); it passes on re-run.
- The dev server binds to `0.0.0.0:4173`; Playwright expects `localhost:4173`
  for OAuth redirect URI matching with armadietto.
