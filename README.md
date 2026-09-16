# Setlist Roller

A dice-powered setlist generator for bands who like to live dangerously.

## The pitch

You've got 40 songs, three members who switch instruments, two alternate tunings, and a capo that keeps disappearing. Building a setlist by hand means either constant gear changes or playing the same safe order every gig.

Setlist Roller fixes that. Tell it your songs and who plays what. It figures out the order that keeps transitions smooth — fewer tuning breaks, fewer awkward silences while someone swaps guitars. Then you roll the dice and it hands you a setlist.

Think of it as a roadie for your setlist.

## How it works

1. **Add your songs** — title, key, covers, instrumentals, whatever you play
2. **Tell it about gear switches** — if someone plays acoustic on one song and electric on the next, or changes tuning, Setlist Roller wants to know
3. **Roll** — pick how many songs, hit the dice, get a setlist that flows
4. **Tweak it** — drag songs around, crank the variety slider from "safe pick" to "hold my beer", set demands like "no banjo tonight" or "at least 3 songs on the 12-string"
5. **Lock it in** — save it, print it, tape it to the monitor wedge

You only need to tell Setlist Roller about members who **switch gear between songs**. If your drummer plays the same kit every night, leave them out. This isn't about taking attendance — it's about tracking transitions.

## Your data stays yours

Most apps store your stuff on their servers. If they shut down, your data goes with them. Setlist Roller doesn't work that way.

Setlist Roller uses [remoteStorage](https://remotestorage.io) — an open standard that lets you pick where your data lives. You connect your own storage provider (there are free ones, or you can run your own), and that's where your songs and settings go. Not our server. Not anyone else's server. Yours.

**What that means in practice:**
- No account to create with us — you bring your own storage
- No one is mining your setlists for ad data
- If Setlist Roller disappeared tomorrow, your data would still be right where you left it
- Switch to a different app that supports remoteStorage? Your data comes with you

Saved setlists live on your device. Export everything as a backup file anytime. Nothing phones home.

## Features

- **Gear-aware ordering** — tracks instruments, tunings, capos, and techniques per member per song
- **Demands** — limit which instruments or tunings show up in a set
- **Variety slider** — control how adventurous the setlist gets
- **Drag to reorder** — move songs around after the roll
- **Setlist history** — keep drafts separate from setlists performed at shows
- **Export/import** — back up everything, restore on any device
- **Works on your phone** — built for the stage, not the studio desk

## Getting started

Visit the app, connect your remoteStorage address, name your band, and start adding songs. When you've got a few in the catalog, head to the Roll tab and let the dice decide.

The app walks you through it — there's a getting-started guide built right in.

## For developers

Built with [Svelte 5](https://svelte.dev), [Vite](https://vite.dev), and [remoteStorage](https://remotestorage.io). No backend, no database, no tracking. The setlist generator runs in a web worker so the UI stays snappy while it crunches numbers.

```bash
npm install
npm run dev
```

## Open source

Setlist Roller is free and open source under the [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html) license. That means anyone can use it, modify it, and share it — as long as they keep it open too. No one gets to take this and lock it behind a paywall. The code stays free, like the music should be.
