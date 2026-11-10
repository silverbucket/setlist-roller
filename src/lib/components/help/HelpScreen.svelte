<script>
    import { getContext } from "svelte";

    const store = getContext("app");
</script>

<div class="help-screen">
    <h1 class="screen-title help-title">How Setlist Roller Works</h1>
    <p class="help-intro">Setlist Roller builds setlists that flow well on stage. It looks at tuning changes, instrument swaps, capo moves, and other gear transitions to put your songs in an order that keeps the chaos to a minimum.</p>

    <div class="help-sections">
    <section class="help-section">
        <h2 class="section-title">Getting started</h2>
        <ol class="steps">
            <li>
                <strong>Add members who switch gear</strong>
                <p>Go to the <button type="button" class="inline-link" onclick={() => store.navigate("band")}>Band</button> tab. Only add members who change instruments, tunings, or capos between songs. If your drummer plays the same kit every song, they don't need to be here — this is about tracking transitions, not taking attendance.</p>
            </li>
            <li>
                <strong>Set up their instruments</strong>
                <p>For each member, add the instruments they play. Then add the tunings for each instrument. If your guitarist plays Standard and DADGAD, add both. This is how Setlist Roller knows what changes cost time on stage.</p>
            </li>
            <li>
                <strong>Add your songs</strong>
                <p>Go to the <button type="button" class="inline-link" onclick={() => store.navigate("songs")}>Songs</button> tab and add your catalog. For each song, tell Setlist Roller which instrument and tuning each tracked member uses. The more detail you give, the smarter the setlists.</p>
            </li>
            <li>
                <strong>Roll a setlist</strong>
                <p>Go to the <button type="button" class="inline-link" onclick={() => store.navigate("roll")}>Roll</button> tab, pick how many songs you want, and hit the dice. Setlist Roller will crunch the numbers and build you an optimized setlist.</p>
            </li>
        </ol>
    </section>

    <section class="help-section">
        <h2 class="section-title">What "incomplete" means</h2>
        <p>Songs show an <span class="example-pill badge badge-warn">incomplete</span> badge when a tracked band member is missing their instrument setup for that song. The song list shows exactly what's missing — e.g. "nick: needs instrument". Tap the song to fill in the gaps.</p>
    </section>

    <section class="help-section">
        <h2 class="section-title">After you roll</h2>
        <ul class="tips">
            <li><strong>Drag to reorder</strong> — not happy with a song's position? Press and hold the handle (or click and drag on desktop) to move it. The card lifts up so you can see exactly where it'll land.</li>
            <li><strong>Lock it in</strong> — prevents accidental re-rolls. You can still unlock and roll again.</li>
            <li><strong>Save draft</strong> — stores a setlist while the band is still working on it.</li>
            <li><strong>Mark as performed</strong> — preserves the setlist actually used at a show, with its date and venue.</li>
            <li><strong>Print</strong> — from the <button type="button" class="inline-link" onclick={() => store.navigate("saved")}>Saved</button> tab, open a setlist and hit print. Big fonts, clean layout, made for the stage.</li>
        </ul>
    </section>

    <section class="help-section">
        <h2 class="section-title">Tweaking the results</h2>
        <ul class="tips">
            <li><strong>Demands</strong> — if a member has multiple instruments or tunings, limit which ones are in play tonight, and say how much that member minds changing between songs: avoid it, keep it to a minimum, or don't care. This is the main lever for tuning and instrument changes.</li>
            <li><strong>Set shape</strong> — the energy arc of the set, using each song's energy rating.</li>
            <li><strong>Song mix</strong> — how strongly play priority steers which songs get picked, from greatest hits to deep cuts, or "surprise me" for luck-heavy rolls.</li>
            <li><strong>Max covers / instrumentals</strong> — cap how many of each type end up in the set.</li>
        </ul>
    </section>

    <section class="help-section">
        <h2 class="section-title">Data & backups</h2>
        <p>Your songs and settings live in remoteStorage. Saved setlists are stored locally on this device. Use <strong>Export</strong> from the <button type="button" class="inline-link" onclick={() => store.navigate("band")}>Band</button> tab to download everything as a JSON file — songs, config, and saved setlists. Keep backups!</p>
    </section>
    </div>
</div>

<style>
    /* Help is prose: one readable column, sections separated by rules
       instead of boxed into cards. */
    .help-screen {
        display: grid;
        gap: var(--space-6);
        max-width: 640px;
        margin: 0 auto;
        padding-bottom: var(--space-4);
    }

    .help-sections {
        display: grid;
        gap: var(--space-6);
    }

    /* Desktop: the page uses the full content width like every other
       screen; the intro keeps a readable measure and the sections flow
       into two columns. */
    @media (min-width: 1000px) {
        .help-screen {
            max-width: none;
            margin: 0;
        }

        .help-intro {
            max-width: 62ch;
        }

        .help-sections {
            display: block;
            columns: 2;
            column-gap: var(--space-8);
        }

        .help-section {
            break-inside: avoid;
            margin-bottom: var(--space-6);
        }
    }

    .help-intro {
        margin: calc(var(--space-3) * -1) 0 0;
        font-size: 1.05rem;
        color: var(--ink-2);
        line-height: 1.55;
    }

    .help-section {
        padding-top: var(--space-5);
        border-top: 1px solid var(--line-strong);
        display: grid;
        gap: var(--space-3);
    }

    .help-section h2 {
        font-size: 1.2rem;
    }

    .help-section p,
    .tips li {
        margin: 0;
        font-size: 0.98rem;
        color: var(--ink-2);
        line-height: 1.6;
    }

    .help-section strong {
        color: var(--ink);
        font-weight: 600;
    }

    /* The four setup steps are a real sequence, so they get numerals. */
    .steps {
        margin: 0;
        padding: 0;
        list-style: none;
        counter-reset: step;
        display: grid;
        gap: var(--space-4);
    }

    .steps li {
        counter-increment: step;
        position: relative;
        padding-left: 2.6rem;
        font-size: 1rem;
        color: var(--ink);
        line-height: 1.4;
    }

    .steps li::before {
        content: counter(step);
        position: absolute;
        left: 0;
        top: -0.1rem;
        width: 1.8rem;
        height: 1.8rem;
        display: grid;
        place-items: center;
        border-radius: 8px;
        background: var(--accent-soft);
        color: var(--accent-text);
        font-family: var(--font-display);
        font-weight: 700;
        font-size: 0.95rem;
    }

    .steps li p {
        margin-top: 0.2rem;
    }

    .tips {
        margin: 0;
        padding-left: 1.2rem;
        display: grid;
        gap: var(--space-2);
    }

    .tips li::marker {
        color: var(--muted);
    }

    .inline-link {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        font-weight: 600;
        color: var(--accent-text);
        cursor: pointer;
        text-decoration: underline;
        text-decoration-thickness: 1.5px;
        text-underline-offset: 3px;
    }

    .inline-link:hover {
        text-decoration-thickness: 2.5px;
    }

    .example-pill {
        vertical-align: 0.05em;
    }
</style>
