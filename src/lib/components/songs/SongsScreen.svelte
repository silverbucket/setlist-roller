<script>
    import { getContext } from "svelte";
    import ChipToggle from "../shared/ChipToggle.svelte";
    import Icon from "../shared/Icon.svelte";
    import SongEditor from "./SongEditor.svelte";

    const store = getContext("app");

    const TYPE_FILTERS = [
        { id: "all", label: "All" },
        { id: "originals", label: "Originals" },
        { id: "covers", label: "Covers" },
        { id: "instrumentals", label: "Instrumentals" },
    ];

    const STATUS_FILTERS = [
        { id: "incomplete", label: "Incomplete", countKey: "incompleteSongCount" },
        { id: "unpracticed", label: "Unpracticed", countKey: "unpracticedSongCount" },
    ];

    function memberSummary(song) {
        // One phrase per member ("nick on guitar"); the template keeps each
        // phrase unbroken so lines only wrap between members.
        return Object.entries(song.members || {}).map(([name, setup]) => {
                const instruments = (setup.instruments || [])
                    .map((i) => i.name)
                    .filter(Boolean)
                    .join(", ");
                return instruments ? `${name} on ${instruments}` : name;
            });
    }
</script>

<div class="songs-screen">
    <header class="screen-header">
        <h2 class="screen-title">Songs <span class="title-count">({store.songs.length})</span></h2>
        <button type="button" class="btn btn-primary add-btn" onclick={() => store.openNewSong()}>+ Add</button>
    </header>

    <div class="songs-layout">
    <div class="filters">
        <div class="search-wrap">
            <Icon name="search" size={18} class="search-icon" />
            <input
                class="search-input input"
                type="search"
                placeholder="Search songs..."
                value={store.songSearch}
                oninput={(e) => (store.songSearch = e.currentTarget.value)}
            />
        </div>

        <div class="type-segmented segmented">
            {#each TYPE_FILTERS as filter}
                <button type="button"
                    class="seg-btn"
                    class:active={store.songFilter === filter.id}
                    onclick={() => (store.songFilter = filter.id)}
                >{filter.label}</button>
            {/each}
        </div>

        <!-- One row on phones (scrolls sideways) so filters don't push the
             list down; wraps into the side rail on desktop. -->
        <div class="chip-scroller">
            <div class="status-filters">
                {#each STATUS_FILTERS as sf}
                    {@const count = store[sf.countKey]}
                    {#if count > 0}
                        <button type="button"
                            class="status-chip"
                            class:active={store.songFilter === sf.id}
                            aria-pressed={store.songFilter === sf.id}
                            onclick={() => (store.songFilter = store.songFilter === sf.id ? "all" : sf.id)}
                        >{sf.label} <span class="status-count">{count}</span></button>
                    {/if}
                {/each}
            </div>

            {#if store.usedKeys.length > 0}
                <div class="key-filter-section">
                    <span class="key-filter-label">Key</span>
                    <div class="key-chips">
                        {#each store.usedKeys as key}
                            <ChipToggle
                                checked={store.songKeyFilters.has(key)}
                                onchange={() => store.toggleKeyFilter(key)}
                            >{key}</ChipToggle>
                        {/each}
                        {#if store.songKeyFilters.size > 0}
                            <button type="button" class="btn btn-sm btn-accent-ghost key-clear-btn" onclick={() => store.clearKeyFilters()}>
                                Clear
                            </button>
                        {/if}
                    </div>
                </div>
            {/if}
        </div>
    </div>

    <div class="songs-results">
    {#if store.emptyCatalog}
        <div class="empty-state">
            <p class="empty-title">Crickets...</p>
            <p class="empty-sub">Your song list is lonelier than a drummer's social life. Tap "+ Add" to fix that.</p>
        </div>
    {:else if store.visibleSongs.length === 0}
        <div class="empty-state">
            <p class="empty-title">Nope, nothing</p>
            <p class="empty-sub">Either your search is too picky or your catalog needs more songs.</p>
        </div>
    {:else}
        <ul class="song-list card">
            {#each store.visibleSongs as song (song.id)}
                {@const reasons = store.songIncompleteReasons(song)}
                {@const lineup = memberSummary(song)}
                <li>
                    <button type="button" class="song-row" onclick={() => store.openSong(song)}>
                        <div class="song-content">
                            <span class="song-name">{song.name || "Untitled"}</span>
                            <!-- Tags share the second line with the line-up, so a
                                 long title never strands a tag on its own row. -->
                            {#if song.unpracticed || store.isSongIncomplete(song) || song.cover || song.instrumental || lineup.length > 0}
                                <div class="song-sub">
                                    {#if song.unpracticed}
                                        <span class="pill warn badge badge-warn">unpracticed</span>
                                    {/if}
                                    {#if store.isSongIncomplete(song)}
                                        <span class="pill warn badge badge-warn" title={reasons.join(", ")}>incomplete</span>
                                    {/if}
                                    {#if song.cover}
                                        <span class="pill badge">cover</span>
                                    {/if}
                                    {#if song.instrumental}
                                        <span class="pill badge">instrumental</span>
                                    {/if}
                                    {#if lineup.length > 0}
                                        <span class="song-members">{#each lineup as phrase, i}<span class="lineup-phrase">{phrase}{i < lineup.length - 1 ? "," : ""}</span>{" "}{/each}</span>
                                    {/if}
                                </div>
                            {/if}
                            {#if reasons.length > 0}
                                <div class="incomplete-reasons">
                                    {#each reasons as reason}
                                        <span class="incomplete-reason">{reason}</span>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                        {#if song.key}
                            <span class="song-key key-badge" title="Key: {song.key}"><span class="sr-only">Key: </span>{song.key}</span>
                        {/if}
                        <Icon name="chevron-right" size={18} class="row-chevron" />
                    </button>
                </li>
            {/each}
        </ul>
    {/if}
    </div>
    </div>

    {#if store.editorSong}
        <SongEditor />
    {/if}
</div>

<style>
    .songs-screen {
        display: grid;
        gap: var(--space-4);
        max-width: 640px;
        margin: 0 auto;
    }

    .songs-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: var(--space-4);
    }

    .songs-results {
        min-width: 0;
    }

    /* Desktop: same two-column grid as the Roll screen — filters in the
       left rail, the catalogue in the wide column. */
    @media (min-width: 1000px) {
        .songs-screen {
            max-width: none;
            margin: 0;
        }

        .songs-layout {
            grid-template-columns: 340px minmax(0, 1fr);
            gap: var(--space-6);
            align-items: start;
        }

        .filters {
            position: sticky;
            top: 0;
            padding: var(--space-4);
            background: var(--surface);
            border: 1px solid var(--line);
            border-radius: var(--radius-lg);
        }
    }

    .screen-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
    }

    .title-count {
        font-weight: 500;
        color: var(--muted);
    }

    .add-btn {
        padding: 0 1.1rem;
    }

    .filters {
        display: grid;
        gap: var(--space-3);
    }

    .search-wrap {
        position: relative;
    }

    .search-wrap :global(.search-icon) {
        position: absolute;
        left: 0.8rem;
        top: 50%;
        transform: translateY(-50%);
        color: var(--muted);
        pointer-events: none;
    }

    .search-input {
        padding-left: 2.5rem;
    }

    .search-input::-webkit-search-cancel-button {
        cursor: pointer;
    }

    .type-segmented {
        display: flex;
    }

    .type-segmented .seg-btn {
        padding: 0 0.4rem;
    }

    .chip-scroller {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        margin: 0 calc(var(--space-4) * -1);
        padding: 2px var(--space-4);
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
    }

    .chip-scroller::-webkit-scrollbar {
        display: none;
    }

    .status-filters {
        display: flex;
        gap: 0.4rem;
        flex-shrink: 0;
    }

    .status-filters:empty {
        display: none;
    }

    @media (min-width: 1000px) {
        .chip-scroller {
            flex-direction: column;
            align-items: stretch;
            gap: var(--space-3);
            margin: 0;
            padding: 0;
            overflow: visible;
        }

        .status-filters,
        .key-chips {
            flex-wrap: wrap;
        }

    }

    /* Attention filters ("Incomplete", "Unpracticed") only appear when
       they'd match something, and carry their count. */
    .status-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        min-height: 38px;
        padding: 0 0.8rem;
        border-radius: var(--radius-full);
        border: 1px solid transparent;
        background: var(--warning-soft);
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--warning);
        white-space: nowrap;
        cursor: pointer;
        touch-action: manipulation;
        -webkit-tap-highlight-color: transparent;
    }

    .status-chip.active {
        border-color: var(--warning);
    }

    .status-count {
        min-width: 1.3rem;
        padding: 0 0.3rem;
        border-radius: var(--radius-full);
        background: var(--warning);
        color: var(--surface);
        font-size: 0.74rem;
        font-weight: 700;
        line-height: 1.3rem;
        text-align: center;
    }

    .key-filter-section {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-shrink: 0;
    }

    .key-filter-label {
        flex-shrink: 0;
        line-height: 38px;
        font-size: 0.86rem;
        font-weight: 600;
        color: var(--muted);
    }

    .key-chips {
        display: flex;
        gap: 0.4rem;
        align-items: center;
    }

    .key-chips :global(.chip-toggle) {
        min-width: 44px;
        justify-content: center;
        font-family: var(--font-display);
        font-weight: 600;
    }

    .song-list {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow: hidden;
    }

    .song-list li + li {
        border-top: 1px solid var(--line);
    }

    .song-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        width: 100%;
        min-height: 60px;
        padding: 0.7rem 0.75rem 0.7rem 1rem;
        border: none;
        background: transparent;
        text-align: left;
        cursor: pointer;
        touch-action: manipulation;
        font: inherit;
        color: inherit;
        -webkit-tap-highlight-color: transparent;
    }

    @media (hover: hover) {
    .song-row:hover {
        background: var(--hover);
    }
    }

    .song-row:active {
        background: var(--accent-soft);
    }

    .song-row:focus-visible {
        outline-offset: -2px;
    }

    .song-content {
        flex: 1;
        min-width: 0;
        display: grid;
        gap: 0.15rem;
    }

    .song-row :global(.row-chevron) {
        flex-shrink: 0;
        color: var(--faint);
    }

    /* Inline flow: tags lead, the line-up text continues on the same line
       and wraps like prose. */
    .song-sub {
        line-height: 1.45;
    }

    .lineup-phrase {
        white-space: nowrap;
    }

    .song-sub .pill {
        margin-right: 0.3rem;
        vertical-align: 0.08em;
    }

    .song-name {
        font-family: var(--font-display);
        font-weight: 600;
        font-size: 1.04rem;
        line-height: 1.3;
        letter-spacing: -0.01em;
        text-wrap: balance;
        overflow-wrap: break-word;
        word-break: break-word;
        min-width: 0;
        max-width: 100%;
    }

    .song-members {
        font-size: 0.88rem;
        color: var(--muted);
    }

    .incomplete-reasons {
        display: flex;
        flex-wrap: wrap;
        gap: 0.1rem 0.6rem;
    }

    .incomplete-reason {
        font-size: 0.84rem;
        color: var(--warning);
        font-weight: 500;
    }

    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }

    /* Desktop rail: label above its chips, left-aligned like the rest. */
    @media (min-width: 1000px) {
        .key-filter-section {
            flex-direction: column;
            align-items: flex-start;
            gap: var(--space-2);
        }

        .key-filter-label {
            line-height: 1.4;
        }
    }
</style>
