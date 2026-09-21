# App stores

`createAppStore(repo)` creates one set of stores per app instance. Components
continue to use the single `app` context; the other factories are internal.

| Module | Owns |
| --- | --- |
| `app.svelte.js` | Composition, generation worker, generation options, current and saved setlist actions |
| `accounts.svelte.js` | Active account, session guards, account registry, local mirror, hydration, switch/sign-out/forget |
| `connection.svelte.js` | Connection events, watchdogs, sync indicators, incremental remote changes, settle/reconciliation, initialization and teardown |
| `catalog.svelte.js` | Catalog documents, local mutation/mirror helpers, song search and filters |
| `band.svelte.js` | Band and member editing, config autosave, first-run setup, instrument choices |
| `song-editor.svelte.js` | Song draft, staged vocabulary, song save/duplicate/delete and keep-apart cascades |
| `data-io.svelte.js` | Import/export, legacy migrations, delete-all-data |
| `ui.svelte.js` | Navigation, busy message, toast queue, confirmation dialog |

The private `stores` registry connects collaborators. Its getters defer access
until the stores have been constructed; factories must not start I/O or invoke
another store's actions during construction. `init()` starts connection listeners
and returns their cleanup function. The `generation` entry exposes only the
main store's state and actions needed by the other stores.

Catalog mutation helpers remain the common write path for local edits, imports,
and remote changes. Account hydration and resets replace catalog state through
its accessors. Async mutations keep the existing account session guards so a
late response cannot update a different account's mirror.

Preserve getters and setters when forwarding state through the public app API.
Spreading a store (`{ ...store }`) evaluates getters once and loses reactive
forwarding. Do not move mutable state to module scope: multiple app instances
must remain independent.
