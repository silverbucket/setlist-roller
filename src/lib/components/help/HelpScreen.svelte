<script>
    import { getContext } from "svelte";

    const store = getContext("app");
</script>

<div class="help-screen">
    <h1 class="help-title">How Setlist Roller Works</h1>
    <p class="help-intro">Setlist Roller builds setlists that flow well on stage. It looks at tuning changes, instrument swaps, capo moves, and other gear transitions to put your songs in an order that keeps the chaos to a minimum.</p>

    <section class="help-section">
        <h2>Getting started</h2>
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
        <h2>What "incomplete" means</h2>
        <p>Songs show an <span class="example-pill">incomplete</span> badge when a tracked band member is missing their instrument setup for that song. The song list shows exactly what's missing — e.g. "nick: needs instrument". Tap the song to fill in the gaps.</p>
    </section>

    <section class="help-section">
        <h2>After you roll</h2>
        <ul class="tips">
            <li><strong>Drag to reorder</strong> — not happy with a song's position? Press and hold the handle (or click and drag on desktop) to move it. The card lifts up so you can see exactly where it'll land.</li>
            <li><strong>Lock it in</strong> — prevents accidental re-rolls. You can still unlock and roll again.</li>
            <li><strong>Save draft</strong> — stores a setlist while the band is still working on it.</li>
            <li><strong>Mark as performed</strong> — preserves the setlist actually used at a show, with its date and venue.</li>
            <li><strong>Print</strong> — from the <button type="button" class="inline-link" onclick={() => store.navigate("saved")}>Saved</button> tab, open a setlist and hit print. Big fonts, clean layout, made for the stage.</li>
        </ul>
    </section>

    <section class="help-section">
        <h2>Tweaking the results</h2>
        <ul class="tips">
            <li><strong>Constraints</strong> — if a member has multiple instruments or tunings, you can limit which ones to include in a setlist.</li>
            <li><strong>Variety slider</strong> — controls how adventurous the algorithm gets. Low = predictable, high = spicy.</li>
            <li><strong>Max covers / instrumentals</strong> — cap how many of each type end up in the set.</li>
        </ul>
    </section>

    <section class="help-section">
        <h2>Data & backups</h2>
        <p>Your songs and settings live in remoteStorage. Saved setlists are stored locally on this device. Use <strong>Export</strong> from the <button type="button" class="inline-link" onclick={() => store.navigate("band")}>Band</button> tab to download everything as a JSON file — songs, config, and saved setlists. Keep backups!</p>
    </section>
</div>

<style>
    .help-screen {
        display: grid;
        gap: 1rem;
        padding: 0.5rem;
        max-width: 540px;
        margin: 0 auto;
    }

    .help-title {
        font-size: 1.3rem;
        font-weight: 800;
        margin: 0;
        color: var(--ink, #182230);
    }

    .help-intro {
        margin: 0;
        font-size: 0.88rem;
        color: var(--muted, #8a95a5);
        line-height: 1.5;
    }

    .help-section {
        border: 1px solid var(--line);
        border-radius: var(--radius-lg, 16px);
        background: var(--paper);
        padding: 1rem;
        display: grid;
        gap: 0.5rem;
    }

    .help-section h2 {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 800;
        color: var(--ink, #182230);
    }

    .help-section p {
        margin: 0;
        font-size: 0.85rem;
        color: var(--muted, #8a95a5);
        line-height: 1.55;
    }

    .help-section p strong {
        color: var(--ink, #182230);
    }

    .steps {
        margin: 0;
        padding-left: 1.4rem;
        display: grid;
        gap: 0.6rem;
    }

    .steps li {
        font-size: 0.88rem;
        font-weight: 700;
        color: var(--ink, #182230);
        line-height: 1.4;
    }

    .steps li p {
        font-weight: 400;
        margin: 0.2rem 0 0;
    }

    .tips {
        margin: 0;
        padding-left: 1.4rem;
        display: grid;
        gap: 0.4rem;
    }

    .tips li {
        font-size: 0.85rem;
        color: var(--muted, #8a95a5);
        line-height: 1.5;
    }

    .tips li strong {
        color: var(--ink, #182230);
    }

    .inline-link {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        font-weight: 700;
        color: var(--accent, #e15b37);
        cursor: pointer;
        text-decoration: underline;
        text-decoration-thickness: 1.5px;
        text-underline-offset: 2px;
    }

    .inline-link:hover {
        color: var(--accent-strong);
    }

    .example-pill {
        display: inline-block;
        padding: 0.1rem 0.4rem;
        border-radius: 999px;
        background: var(--warning-soft);
        color: var(--muted);
        font-size: 0.75rem;
        font-weight: 700;
    }
</style>
