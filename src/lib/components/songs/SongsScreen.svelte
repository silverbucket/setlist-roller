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
        return Object.entries(song.members || {})
            .map(([name, setup]) => {
                const instruments = (setup.instruments || [])
                    .map((i) => i.name)
                    .filter(Boolean)
                    .join(", ");
                return instruments ? `${name} on ${instruments}` : name;
            })
            .join(", ");
    }
</script>

<div class="songs-screen">
    <header class="screen-header">
        <h2 class="screen-title">Songs <span class="title-count">({store.songs.length})</span></h2>
        <button type="button" class="btn btn-primary add-btn" onclick={() => store.openNewSong()}>+ Add</button>
    </header>

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

        <div class="filter-row">
            <div class="type-segmented segmented">
                {#each TYPE_FILTERS as filter}
                    <button type="button"
                        class="seg-btn"
                        class:active={store.songFilter === filter.id}
                        onclick={() => (store.songFilter = filter.id)}
                    >{filter.label}</button>
                {/each}
            </div>
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
                <li>
                    <button type="button" class="song-row" onclick={() => store.openSong(song)}>
                        <div class="song-content">
                            <div class="song-top">
                                <span class="song-name">{song.name || "Untitled"}</span>
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
                            </div>
                            {#if memberSummary(song)}
                                <div class="song-members">{memberSummary(song)}</div>
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

    {#if store.editorSong}
        <SongEditor />
    {/if}
</div>

<style>
    .songs-screen {
        display: grid;
        gap: var(--space-4);
        max-width: 760px;
        margin: 0 auto;
    }

    @media (min-width: 900px) {
        .songs-screen {
            margin: 0;
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

    .filter-row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-3);
        align-items: center;
    }

    .type-segmented {
        display: flex;
        flex: 1 1 100%;
    }

    .seg-btn {
        padding: 0 0.5rem !important;
    }

    @media (min-width: 560px) {
        .type-segmented {
            display: inline-flex;
            flex: 0 0 auto;
        }

        .seg-btn {
            padding: 0 0.9rem !important;
        }
    }

    .status-filters {
        display: flex;
        gap: 0.4rem;
        flex-wrap: wrap;
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
        align-items: flex-start;
        gap: var(--space-3);
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
        flex-wrap: wrap;
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

    .song-row:hover {
        background: var(--hover);
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

    .song-top {
        display: flex;
        align-items: center;
        gap: 0.2rem 0.45rem;
        flex-wrap: wrap;
    }

    .song-name {
        font-family: var(--font-display);
        font-weight: 600;
        font-size: 1.04rem;
        line-height: 1.3;
        letter-spacing: -0.01em;
        overflow-wrap: break-word;
        word-break: break-word;
        min-width: 0;
        max-width: 100%;
    }

    .song-members {
        font-size: 0.88rem;
        color: var(--muted);
        line-height: 1.35;
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
</style>
