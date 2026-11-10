<script>
  import { needsTuningChange, songChangeLines } from "../../transitions.js";
  import Icon from "../shared/Icon.svelte";

  const { song, index, prevSong, onDragStart, onEdit, onSwap, onRemove, onTogglePin, arming = false, dragging = false } = $props();

  let expanded = $state(false);

  const changeLines = $derived(songChangeLines(song, prevSong));
  const tuningChange = $derived(needsTuningChange(song, prevSong));

  const KIND_LABELS = {
    tuning: "Tuning",
    instrument: "Gear",
    capo: "Capo",
    technique: "Technique",
  };

  function toggleExpand() {
    expanded = !expanded;
  }
</script>

<div class="song-card" class:expanded class:dragging class:pinned={song.pinned} class:tuning-change={tuningChange}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="card-main" onclick={toggleExpand} onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleExpand(); } }} role="button" tabindex="0" aria-expanded={expanded}>
    <span class="position">{song.position}</span>

    <div class="card-body">
      <div class="title-row">
        <span class="song-name">{song.name}</span>
        {#if song.keepApartConflict}
          <span
            class="conflict-badge badge badge-warn"
            title="Next to a song it should be kept apart from"
            aria-label="Next to a song it should be kept apart from"
          ><Icon name="alert" size={12} stroke={2.4} /> apart</span>
        {/if}
      </div>

      {#if changeLines.length > 0}
        <div class="change-lines" class:first-song={!prevSong}>
          {#each changeLines as line}
            <div class="change-line">
              <span class="change-member">{line.member}</span>
              <span class="change-chips">
                {#each line.changes as change}
                  <span class="change-chip {change.kind}" title={`${KIND_LABELS[change.kind]}: ${change.label}`}>
                    {#if change.kind === "tuning"}
                      <Icon name="tune" size={12} stroke={3} class="chip-icon" />
                      <span class="chip-kind">Tune</span>
                    {:else if change.kind === "instrument"}
                      <Icon name="swap" size={12} stroke={3} class="chip-icon" />
                      <span class="chip-kind">Swap</span>
                    {/if}
                    <span class="chip-label">{change.label}</span>
                  </span>
                {/each}
              </span>
            </div>
          {/each}
        </div>
      {/if}

      {#if song.notes?.trim()}
        <div class="song-notes">{song.notes}</div>
      {/if}
    </div>

    <div class="card-aside">
      {#if song.key}
        <span class="key-badge">{song.key}</span>
      {/if}
      <button
        type="button"
        class="pin-btn"
        class:pinned={song.pinned}
        aria-label={song.pinned ? `Unpin ${song.name}` : `Pin ${song.name}`}
        aria-pressed={song.pinned}
        title={song.pinned ? "Unpin song" : "Keep this song and position on reroll"}
        onclick={(e) => { e.stopPropagation(); onTogglePin?.(song.id); }}
      ><Icon name="pin" size={17} /></button>
      <span
        class="drag-handle"
        class:arming
        class:dragging
        aria-label="Press and hold to reorder"
        title="Press and hold to reorder"
        onpointerdown={(e) => { e.stopPropagation(); if (onDragStart) onDragStart(e, index); }}
        onclick={(e) => e.stopPropagation()}
      >
        <svg class="grip-icon" width="14" height="22" viewBox="0 0 14 22" aria-hidden="true">
          <circle cx="3.5" cy="4" r="1.5"/>
          <circle cx="10.5" cy="4" r="1.5"/>
          <circle cx="3.5" cy="11" r="1.5"/>
          <circle cx="10.5" cy="11" r="1.5"/>
          <circle cx="3.5" cy="18" r="1.5"/>
          <circle cx="10.5" cy="18" r="1.5"/>
        </svg>
      </span>
    </div>
  </div>

  {#if expanded}
    <div class="expanded-actions">
      <button type="button" class="btn btn-sm edit-btn" onclick={(e) => { e.stopPropagation(); if (onEdit) onEdit(song.id); expanded = false; }}>
        <Icon name="pencil" size={15} />
        Edit song
      </button>
      <button type="button" class="btn btn-sm edit-btn" onclick={(e) => { e.stopPropagation(); onSwap?.(index); expanded = false; }}>
        <Icon name="swap" size={15} />
        Swap
      </button>
      <button type="button" class="btn btn-sm btn-ghost edit-btn remove-btn" onclick={(e) => { e.stopPropagation(); if (onRemove) onRemove(index); expanded = false; }}>
        <Icon name="x" size={15} />
        Remove
      </button>
    </div>
  {/if}
</div>

<style>
  /* One row of the setlist sheet. RollScreen draws the rules between rows
     and rounds the first/last corners. */
  .song-card {
    position: relative;
    background: var(--surface);
    transition: box-shadow 180ms ease, background 180ms ease;
  }

  .song-card.pinned {
    background: color-mix(in srgb, var(--accent) 6%, var(--surface));
  }

  /* A retune is the slowest change to make on stage and the easiest to miss
     while scanning the list, so rows that need one get a solid edge stripe. */
  .song-card.tuning-change::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--accent);
  }

  /* While dragging, the row lifts off the sheet so it is obvious which one
     is held. The wrapper handles the follow-the-finger transform. */
  .song-card.dragging {
    background: var(--paper-strong);
    box-shadow: var(--shadow-soft), 0 0 0 2px var(--accent);
  }

  .card-main {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.7rem 0.4rem 0.7rem 0.85rem;
    cursor: pointer;
    border-radius: inherit;
    -webkit-tap-highlight-color: transparent;
  }

  .card-main:focus-visible {
    outline-offset: -2px;
  }

  @media (hover: hover) {
    .song-card:not(.dragging) .card-main:hover {
      background: var(--hover);
    }
  }

  /* Running order: big tabular numerals, the thing you find first when
     glancing down from a mic. */
  .position {
    flex-shrink: 0;
    width: 1.6rem;
    padding-top: 0.05rem;
    font-family: var(--font-display);
    font-size: 1.15rem;
    font-weight: 700;
    line-height: 1.5rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }

  .card-body {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 0.3rem;
    padding-top: 0.05rem;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    min-height: 1.5rem;
  }

  .song-name {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 1.06rem;
    line-height: 1.3;
    letter-spacing: -0.01em;
    color: var(--ink);
    overflow-wrap: break-word;
    word-break: break-word;
    min-width: 0;
    max-width: 100%;
  }

  .card-aside {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    height: 36px;
    margin-top: -0.3rem;
  }

  .card-aside .key-badge {
    margin-right: 0.25rem;
  }

  .pin-btn {
    flex-shrink: 0;
    display: inline-grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--faint);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: color 140ms ease, background 140ms ease;
  }

  .pin-btn:hover {
    color: var(--ink-2);
    background: var(--hover-strong);
  }

  .pin-btn.pinned {
    color: var(--accent-text);
  }

  .pin-btn.pinned :global(svg) {
    fill: currentColor;
  }

  /* Drag handle: slim visual, generous touch target.
     - touch-action: pan-y lets the user scroll vertically over the handle by
       default. Drag mode is opt-in via long-press in RollScreen, so brushing
       past the handle while scrolling no longer hijacks the gesture.
     - The .arming and .dragging classes are toggled by the parent to show
       the press-hold progress and the active drag state. */
  .drag-handle {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    /* WCAG 2.5.5 / iOS HIG recommend ≥44px tappable height. */
    height: 44px;
    color: var(--faint);
    cursor: grab;
    touch-action: pan-y;
    user-select: none;
    -webkit-user-select: none;
    border-radius: var(--radius-sm);
    transition:
      background 160ms ease,
      color 160ms ease,
      transform 160ms ease,
      box-shadow 160ms ease;
  }

  .drag-handle:hover {
    color: var(--ink-2);
    background: var(--hover-strong);
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  /* Arming: shown for the ~350ms long-press window before drag activates.
     A pulsing accent ring + filled background telegraphs "keep holding".
     Combined with the haptic tap when the timer fires, the user understands
     they have entered drag mode. */
  .drag-handle.arming {
    color: var(--accent-text);
    background: var(--accent-soft);
    transform: scale(1.08);
    animation: handle-arm 350ms ease-out;
  }

  /* Dragging: the handle becomes a solid accent badge so the user can clearly
     see which row their finger is currently anchored to. */
  .drag-handle.dragging {
    color: var(--on-accent);
    background: var(--accent);
    cursor: grabbing;
  }

  .grip-icon {
    fill: currentColor;
    pointer-events: none;
  }

  @keyframes handle-arm {
    0% {
      transform: scale(1);
      box-shadow: 0 0 0 0 var(--accent-line);
    }
    100% {
      transform: scale(1.08);
      box-shadow: 0 0 0 10px transparent;
    }
  }

  .change-lines {
    display: grid;
    gap: 0.3rem;
  }

  .change-line {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    font-size: 0.86rem;
  }

  .change-member {
    font-weight: 600;
    color: var(--ink-2);
    flex-shrink: 0;
  }

  .change-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    min-width: 0;
  }

  /* Each kind of change gets its own chip treatment so a glance tells you
     whether it is a retune, a guitar swap, a capo move, or just technique. */
  .change-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.08rem 0.5rem;
    border-radius: 6px;
    border: 1px solid transparent;
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1.4;
    white-space: nowrap;
  }

  .change-chip :global(.chip-icon) {
    flex-shrink: 0;
    align-self: center;
  }

  .chip-kind {
    font-weight: 700;
  }

  /* Tuning: loudest — solid accent fill. */
  .change-chip.tuning {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }

  /* Instrument swap: accent outline. Related to tuning but visibly lighter. */
  .change-chip.instrument {
    background: var(--accent-soft);
    border-color: var(--accent-line);
    color: var(--accent-text);
  }

  /* Capo: quick to do — warm but muted. */
  .change-chip.capo {
    background: var(--warning-soft);
    color: var(--warning);
  }

  /* Technique: informational only. */
  .change-chip.technique {
    background: var(--hover-strong);
    color: var(--ink-2);
    font-weight: 500;
  }

  /* The opening song shows starting setup, not a change, so it stays quiet. */
  .first-song .change-member {
    color: var(--muted);
  }

  .first-song .change-chip {
    background: transparent;
    border-color: var(--line-strong);
    color: var(--muted);
    font-weight: 500;
  }

  .first-song .chip-kind,
  .first-song .change-chip :global(.chip-icon) {
    display: none;
  }

  /* Notes are often a whole chord chart. Collapsed rows show the first two
     lines so the running order stays scannable; tap the row for the rest. */
  .song-notes {
    font-size: 0.88rem;
    color: var(--muted);
    line-height: 1.45;
    white-space: pre-line;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }

  .song-card.expanded .song-notes {
    display: block;
    overflow: visible;
  }

  .expanded-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.1rem 0.85rem 0.8rem;
  }

  .remove-btn {
    margin-left: auto;
  }
</style>
