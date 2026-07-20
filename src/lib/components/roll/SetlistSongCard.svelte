<script>
  import { normalizeTechniqueValue, techniqueDisplay } from "../../technique-utils.js";

  const { song, index, prevSong, onDragStart, onEdit, onRemove, onTogglePin, arming = false, dragging = false } = $props();

  let expanded = $state(false);

  function toggleExpand() {
    expanded = !expanded;
  }

  function getChanges(memberName) {
    const curr = song.performance?.[memberName];
    if (!curr) return [];
    const prev = prevSong?.performance?.[memberName];
    const changes = [];
    if (!prev || curr.instrument !== prev.instrument) {
      if (prev && curr.instrument) changes.push(curr.instrument);
    }
    if (!prev || curr.tuning !== prev.tuning) {
      if (curr.tuning) changes.push(curr.tuning);
    }
    if (!prev || curr.capo !== prev.capo) {
      if (curr.capo) changes.push(`capo ${curr.capo}`);
      else if (prev?.capo) changes.push("capo off");
    }
    const currTech = normalizeTechniqueValue(curr.picking);
    const prevTech = prev ? normalizeTechniqueValue(prev.picking) : "";
    if (currTech !== prevTech && currTech) {
      const tech = techniqueDisplay(curr.picking);
      if (tech) changes.push(tech);
    }
    return changes;
  }

  function allChanges() {
    if (!song.performance) return [];
    const lines = [];
    for (const [memberName, _perf] of Object.entries(song.performance)) {
      const changes = getChanges(memberName);
      if (changes.length > 0) {
        lines.push({ member: memberName, changes });
      }
    }
    return lines;
  }
</script>

<div class="song-card" class:expanded class:dragging class:pinned={song.pinned}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="card-main" onclick={toggleExpand} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(); } }} role="button" tabindex="0">
    <span
      class="drag-handle"
      class:arming
      class:dragging
      aria-label="Press and hold to reorder"
      title="Press and hold to reorder"
      onpointerdown={(e) => { e.stopPropagation(); if (onDragStart) onDragStart(e, index); }}
    >
      <svg class="grip-icon" width="14" height="22" viewBox="0 0 14 22" aria-hidden="true">
        <circle cx="3.5" cy="4" r="1.6"/>
        <circle cx="10.5" cy="4" r="1.6"/>
        <circle cx="3.5" cy="11" r="1.6"/>
        <circle cx="10.5" cy="11" r="1.6"/>
        <circle cx="3.5" cy="18" r="1.6"/>
        <circle cx="10.5" cy="18" r="1.6"/>
      </svg>
    </span>

    <div class="card-body">
      <div class="title-row">
        <span class="position">{song.position}.</span>
        <span class="song-name">{song.name}</span>
        <button
          type="button"
          class="pin-btn"
          class:pinned={song.pinned}
          aria-label={song.pinned ? `Unpin ${song.name}` : `Pin ${song.name}`}
          title={song.pinned ? "Unpin song" : "Keep this song and position on reroll"}
          onclick={(e) => { e.stopPropagation(); onTogglePin?.(song.id); }}
        >{song.pinned ? "📌" : "○"}</button>
        {#if song.key}
          <span class="key-badge">{song.key}</span>
        {/if}
      </div>

      {#if prevSong}
        {@const changes = allChanges()}
        {#if changes.length > 0}
          <div class="change-lines">
            {#each changes as line}
              <div class="change-line">
                <span class="change-member">{line.member}</span>
                <span class="change-detail">{line.changes.join(", ")}</span>
              </div>
            {/each}
          </div>
        {/if}
      {:else if song.performance}
        <div class="change-lines">
          {#each Object.entries(song.performance) as [memberName, perf]}
            {@const techStr = techniqueDisplay(perf.picking)}
            {@const parts = [perf.instrument, perf.tuning, perf.capo ? `capo ${perf.capo}` : null, techStr].filter(Boolean)}
            {#if parts.length > 0}
              <div class="change-line first-song">
                <span class="change-member">{memberName}</span>
                <span class="change-detail">{parts.join(", ")}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      {#if song.notes?.trim()}
        <div class="song-notes">{song.notes}</div>
      {/if}
    </div>
  </div>

  {#if expanded}
    <div class="expanded-actions">
      <button type="button" class="edit-btn" onclick={(e) => { e.stopPropagation(); if (onEdit) onEdit(song.id); expanded = false; }}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Edit song
      </button>
      <button type="button" class="edit-btn remove-btn" onclick={(e) => { e.stopPropagation(); if (onRemove) onRemove(index); expanded = false; }}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
        Remove
      </button>
    </div>
  {/if}
</div>

<style>
  .song-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md, 12px);
    padding: 0.65rem 0.75rem;
    transition:
      border-color 150ms ease,
      box-shadow 180ms ease,
      background 180ms ease;
  }

  .song-card.expanded {
    border-color: var(--accent-line);
  }

  .song-card.pinned {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  /* When the parent wrapper marks this card as dragging, lift it visually so
     the user can clearly see which card they are holding. The wrapper handles
     the translateY follow-the-finger transform; the card itself only changes
     elevation, border colour, and a subtle tilt. */
  .song-card.dragging {
    border-color: var(--accent, #e15b37);
    border-width: 2px;
    padding: calc(0.65rem - 1px) calc(0.75rem - 1px);
    background: var(--paper-strong);
    box-shadow:
      0 18px 40px rgba(27, 39, 58, 0.22),
      0 4px 12px rgba(225, 91, 55, 0.18);
  }

  .card-main {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  /* Drag handle: bigger touch target, clearer visual.
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
    /* WCAG 2.5.5 / iOS HIG recommend ≥44px tappable height. We get there
       via padding + the SVG, so the visual column stays slim while the
       touch target stays generous. */
    width: 30px;
    min-height: 44px;
    /* Pull the handle slightly into the card's left padding so the visible
       icon hugs the edge — the touch target still extends inward. */
    margin-left: -0.4rem;
    padding: 0.3rem 0.4rem;
    color: var(--muted, #8a95a5);
    cursor: grab;
    touch-action: pan-y;
    user-select: none;
    -webkit-user-select: none;
    border-radius: 8px;
    transition:
      background 160ms ease,
      color 160ms ease,
      transform 160ms ease,
      box-shadow 160ms ease;
  }

  .drag-handle:hover {
    color: var(--ink, #182230);
    background: var(--hover);
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  /* Arming: shown for the ~350ms long-press window before drag activates.
     A pulsing accent ring + filled background telegraphs "keep holding".
     Combined with the haptic tap when the timer fires, the user understands
     they have entered drag mode. */
  .drag-handle.arming {
    color: var(--accent, #e15b37);
    background: var(--accent-soft);
    transform: scale(1.08);
    animation: handle-arm 350ms ease-out;
  }

  /* Dragging: the handle becomes a solid accent badge so the user can clearly
     see which card their finger is currently anchored to. */
  .drag-handle.dragging {
    color: var(--on-accent);
    background: var(--accent, #e15b37);
    transform: scale(1.12);
    box-shadow: 0 4px 10px rgba(225, 91, 55, 0.35);
    cursor: grabbing;
  }

  .grip-icon {
    fill: currentColor;
    pointer-events: none;
  }

  @keyframes handle-arm {
    0% {
      transform: scale(1);
      box-shadow: 0 0 0 0 rgba(225, 91, 55, 0.45);
    }
    100% {
      transform: scale(1.08);
      box-shadow: 0 0 0 10px rgba(225, 91, 55, 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .drag-handle.arming {
      animation: none;
    }
  }

  .card-body {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 0.25rem;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .position {
    font-weight: 800;
    font-size: 0.82rem;
    color: var(--muted, #8a95a5);
    min-width: 1.4rem;
  }

  .song-name {
    font-weight: 700;
    font-size: 0.92rem;
    color: var(--ink, #182230);
    overflow-wrap: break-word;
    word-break: break-word;
    min-width: 0;
    max-width: 100%;
  }

  .pin-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    min-height: 32px;
    margin-left: auto;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
    font-size: 16px;
    cursor: pointer;
  }

  .pin-btn.pinned {
    border-color: var(--accent-line);
    background: var(--paper-strong);
    color: var(--accent);
  }

  .key-badge {
    margin-left: auto;
    flex-shrink: 0;
    font-size: 0.72rem;
    font-weight: 700;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--line);
    color: var(--ink, #182230);
  }

  .pin-btn + .key-badge {
    margin-left: 0;
  }

  .change-lines {
    display: grid;
    gap: 0.1rem;
    padding-left: 1.4rem;
  }

  .change-line {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    font-size: 0.85rem;
  }

  .change-member {
    font-weight: 700;
    color: var(--accent, #e15b37);
    flex-shrink: 0;
  }

  .change-detail {
    color: var(--accent, #e15b37);
    font-weight: 600;
  }

  .first-song .change-member {
    color: var(--muted, #8a95a5);
  }

  .first-song .change-detail {
    color: var(--muted, #8a95a5);
    font-weight: 500;
  }

  .song-notes {
    padding-left: 1.4rem;
    font-size: 0.85rem;
    font-style: italic;
    color: var(--muted, #8a95a5);
    line-height: 1.45;
    white-space: pre-line;
    font-weight: 500;
  }

  .expanded-actions {
    display: flex;
    gap: 0.5rem;
    padding-top: 0.5rem;
    margin-top: 0.5rem;
    border-top: 1px solid var(--line);
    padding-left: 1.4rem;
  }

  .edit-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 2rem;
    padding: 0.3rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-md, 12px);
    background: var(--surface);
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--ink, #182230);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  .edit-btn:active {
    background: var(--hover);
  }

  .remove-btn {
    color: var(--muted, #8a95a5);
    border-color: var(--line);
  }

  .remove-btn:active {
    background: var(--accent-soft);
    color: var(--accent, #e15b37);
  }
</style>
