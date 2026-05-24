<script>
  import { getContext } from "svelte";
  import { anxietyLabel } from "../../anxiety.js";

  const store = getContext("app");

  let viewingId = $state(null);
  let viewingSet = $derived(
    viewingId ? (store.displayedSavedSetlists?.find(s => s.id === viewingId) ?? null) : null
  );
  let editingId = $state(null);
  let editName = $state("");
  let editDate = $state("");

  function handleView(saved) {
    if (editingId) return;
    viewingId = saved.id;
  }

  function startEdit(e, saved) {
    e.stopPropagation();
    editingId = saved.id;
    editName = saved.name || "";
    // Convert ISO to YYYY-MM-DD for date input
    editDate = saved.savedAt ? saved.savedAt.slice(0, 10) : "";
  }

  function saveEdit(e) {
    if (e) e.stopPropagation();
    if (!editingId) return;
    store.updateSavedSetlist(editingId, {
      name: editName.trim() || "Untitled Set",
      savedAt: editDate ? new Date(`${editDate}T12:00:00`).toISOString() : new Date().toISOString(),
    });
    editingId = null;
  }

  function cancelEdit(e) {
    if (e) e.stopPropagation();
    editingId = null;
  }

  function handleClose() {
    viewingId = null;
  }

  function handleLoad(e, id) {
    e.stopPropagation();
    store.loadSavedSetlist(id);
    store.navigate("roll");
  }

  let confirmingRemoveId = $state(null);

  function handleRemove(e, id) {
    e.stopPropagation();
    if (confirmingRemoveId === id) {
      store.removeSavedSetlist(id);
      confirmingRemoveId = null;
    } else {
      confirmingRemoveId = id;
    }
  }

  function cancelRemove(e) {
    e.stopPropagation();
    confirmingRemoveId = null;
  }

  let printEl = $state(null);

  function handlePrint() {
    if (!printEl) return;
    const clone = printEl.cloneNode(true);
    for (const el of clone.querySelectorAll(".no-print")) el.remove();
    const content = clone.innerHTML;
    const appUrl = window.location.origin;
    const bandName = (store.appTitle || "").replace(/ — Setlist Roller$/, "");
    const setName = viewingSet?.name || "Setlist";
    const pdfTitle = `${bandName} - ${setName}`;
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const win = window.open("", "_blank", "width=800,height=600");
    if (!win) { store.toastWarn("Popup blocked — please allow popups to print."); return; }
    win.document.write(`<!DOCTYPE html>
<html><head><title>${esc(pdfTitle)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { margin: 0; }
  body {
    font-family: "Avenir Next", "Helvetica Neue", "Segoe UI", sans-serif;
    color: #000;
    padding: 1.5cm;
  }
  .print-top { padding-bottom: 8px; border-bottom: 2px solid #000; margin-bottom: 6px; }
  .print-band { font-size: 22pt; font-weight: 800; line-height: 1.2; }
  .print-subtitle { font-size: 11pt; font-weight: 400; color: #555; margin-top: 2px; }
  .print-songs { list-style: none; }
  .print-song { padding: 9px 0; border-bottom: 1px solid #ddd; break-inside: avoid; }
  .print-song-row { display: flex; align-items: baseline; gap: 8px; }
  .print-num { font-size: 14pt; font-weight: 700; color: #666; min-width: 2rem; text-align: right; flex-shrink: 0; }
  .print-song-name { font-size: 17pt; font-weight: 600; flex: 1; }
  .print-song-key { font-size: 13pt; font-weight: 700; color: #444; padding: 1px 6px; border: 1px solid #ccc; border-radius: 3px; flex-shrink: 0; }
  .print-changes { padding-left: 2.5rem; padding-top: 3px; }
  .print-change { display: flex; align-items: baseline; gap: 5px; font-size: 12pt; color: #333; }
  .print-change.setup { color: #666; }
  .print-change-member { font-weight: 700; }
  .print-change-detail { font-weight: 500; }
  .print-notes { padding-left: 2.5rem; padding-top: 2px; font-size: 12pt; font-weight: 500; font-style: italic; color: #666; line-height: 1.45; white-space: pre-line; }
  .print-anxiety { margin-top: 8px; padding-top: 8px; border-top: 2px solid #000; display: flex; align-items: baseline; gap: 5px; font-size: 11pt; }
  .print-anxiety-title { font-weight: 700; }
  .print-anxiety-score { font-weight: 800; }
  .print-anxiety-label { font-weight: 400; color: #555; }
  .print-footer { position: fixed; bottom: 1cm; right: 1.5cm; font-size: 8pt; color: #999; }
</style></head><body>${content}<div class="print-footer">${appUrl}</div></body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); win.close(); }, 150);
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function normalizeTechniqueValue(value) {
    if (!Array.isArray(value)) return String(value || "");
    return value.filter((technique) => technique && technique !== "none").slice().sort().join(",");
  }

  function techniqueDisplay(value) {
    if (!Array.isArray(value)) return value || null;
    const normalized = value.filter((technique) => technique && technique !== "none").slice().sort();
    return normalized.length ? normalized.join(", ") : null;
  }

  // Transition notes — same logic as SetlistSongCard
  function getChanges(song, prevSong, memberName) {
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

  function allChanges(song, prevSong) {
    if (!song.performance) return [];
    const lines = [];
    for (const [memberName] of Object.entries(song.performance)) {
      if (prevSong) {
        const changes = getChanges(song, prevSong, memberName);
        if (changes.length > 0) lines.push({ member: memberName, changes });
      } else {
        // First song: show initial setup
        const perf = song.performance[memberName];
        const techStr = techniqueDisplay(perf.picking);
        const parts = [perf.instrument, perf.tuning, perf.capo ? `capo ${perf.capo}` : null, techStr].filter(Boolean);
        if (parts.length > 0) lines.push({ member: memberName, changes: parts, isSetup: true });
      }
    }
    return lines;
  }
</script>

<div class="saved-screen">
  <h2 class="screen-title">Greatest Hits</h2>

  {#if !store.displayedSavedSetlists?.length}
    <div class="empty-state">
      <p class="empty-title">Nothing saved yet</p>
      <p class="empty-sub">Roll a setlist you love, lock it in, then save it here for safekeeping.</p>
    </div>
  {:else}
    <div class="saved-list">
      {#each store.displayedSavedSetlists as saved}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="saved-card" onclick={() => handleView(saved)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') handleView(saved); }}>
          {#if editingId === saved.id}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="edit-form" onclick={(e) => e.stopPropagation()}>
              <input class="edit-input" type="text" bind:value={editName} placeholder="Setlist name" onkeydown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }} />
              <input class="edit-input date" type="date" bind:value={editDate} />
              <div class="edit-actions">
                <button type="button" class="card-btn save" onclick={saveEdit}>Save</button>
                <button type="button" class="card-btn cancel" onclick={cancelEdit}>Cancel</button>
              </div>
            </div>
          {:else}
            <div class="saved-top">
              <span class="saved-name">{saved.name || `Set #${saved.songs?.length || "?"}`}</span>
              <span class="saved-date">{formatDate(saved.savedAt)}</span>
            </div>
            <div class="saved-meta">
              <span>{saved.songs?.length || 0} songs</span>
            </div>
            <div class="saved-card-actions">
              <button type="button" class="card-btn edit" onclick={(e) => startEdit(e, saved)}>Edit</button>
              <button type="button" class="card-btn load" onclick={(e) => handleLoad(e, saved.id)}>Load</button>
              <span class="action-spacer"></span>
              {#if confirmingRemoveId === saved.id}
                <button type="button" class="card-btn confirm-delete" onclick={(e) => handleRemove(e, saved.id)}>Delete?</button>
                <button type="button" class="card-btn cancel-delete" onclick={cancelRemove}>No</button>
              {:else}
                <button type="button" class="card-btn remove" onclick={(e) => handleRemove(e, saved.id)} aria-label="Remove">&times;</button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if viewingSet}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={handleClose}>
    <div class="modal-sheet" onclick={(e) => e.stopPropagation()}>
      <div class="modal-content">
        <div class="print-setlist" bind:this={printEl}>
          <div class="print-top">
            <button type="button" class="modal-close no-print" onclick={handleClose} aria-label="Close">&times;</button>
            <h2 class="print-band">{store.appTitle.replace(/ — Setlist Roller$/, "")}</h2>
            <p class="print-subtitle">{viewingSet.name || "Setlist"} &middot; {formatDate(viewingSet.savedAt)}</p>
          </div>

          <div class="print-songs">
            {#each viewingSet.songs as song, i}
              {@const prevSong = i > 0 ? viewingSet.songs[i - 1] : null}
              {@const changes = allChanges(song, prevSong)}
              <div class="print-song">
                <div class="print-song-row">
                  <span class="print-num">{i + 1}.</span>
                  <span class="print-song-name">{song.name || song.title || "Untitled"}</span>
                  {#if song.key}
                    <span class="print-song-key">{song.key}</span>
                  {/if}
                </div>
                {#if changes.length > 0}
                  <div class="print-changes">
                    {#each changes as line}
                      <div class="print-change" class:setup={line.isSetup}>
                        <span class="print-change-member">{line.member}:</span>
                        <span class="print-change-detail">{line.changes.join(", ")}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
                {#if song.notes?.trim()}
                  <div class="print-notes">{song.notes}</div>
                {/if}
              </div>
            {/each}
          </div>

          {#if viewingSet.summary?.anxiety}
            {@const anxiety = viewingSet.summary.anxiety}
            <div class="print-anxiety">
              <span class="print-anxiety-title">Bass Player Anxiety:</span>
              <span class="print-anxiety-score">{anxiety.scaled}/10</span>
              <span class="print-anxiety-label">{anxietyLabel(anxiety)}</span>
            </div>
          {/if}
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="modal-btn" onclick={handlePrint}>Print / Export PDF</button>
        <button type="button" class="modal-btn primary" onclick={(e) => { handleLoad(e, viewingSet.id); viewingId = null; }}>Load to Roll</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .saved-screen {
    display: grid;
    gap: 1rem;
    padding: 0.75rem;
    max-width: 540px;
    margin: 0 auto;
  }

  .screen-title {
    font-size: 1.1rem;
    font-weight: 800;
    color: var(--ink, #182230);
  }

  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
  }

  .empty-title {
    font-size: 1rem;
    font-weight: 700;
    color: var(--ink, #182230);
    margin-bottom: 0.35rem;
  }

  .empty-sub {
    font-size: 0.85rem;
    color: var(--muted, #8a95a5);
    line-height: 1.5;
  }

  .saved-list {
    display: grid;
    gap: 0.5rem;
  }

  .saved-card {
    border-radius: var(--radius-lg, 16px);
    background: var(--surface);
    border: 1px solid var(--line);
    padding: 0.75rem;
    display: grid;
    gap: 0.4rem;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }

  .saved-card:hover {
    border-color: var(--accent);
    box-shadow: 0 2px 8px var(--accent-soft);
  }

  .saved-card:active {
    background: var(--accent-soft);
  }

  .saved-top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .saved-name {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--ink, #182230);
  }

  .saved-date {
    font-size: 0.72rem;
    color: var(--muted, #8a95a5);
    font-weight: 600;
  }

  .saved-meta {
    display: flex;
    gap: 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--muted, #8a95a5);
  }

  .saved-card-actions {
    display: flex;
    gap: 0.35rem;
    margin-top: 0.15rem;
  }

  .card-btn {
    border: none;
    border-radius: var(--radius-md, 12px);
    font-size: 0.78rem;
    font-weight: 700;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    padding: 0.35rem 0.7rem;
    min-height: 1.8rem;
    transition: background 120ms ease, transform 80ms ease;
  }

  .card-btn:active {
    transform: scale(0.96);
  }

  .card-btn.load {
    background: linear-gradient(140deg, var(--accent) 0%, var(--accent-strong) 100%);
    color: var(--on-accent);
  }

  .action-spacer {
    flex: 1;
  }

  .card-btn.remove {
    background: none;
    color: var(--muted, #8a95a5);
    font-size: 1.1rem;
    padding: 0.2rem 0.4rem;
  }

  .card-btn.remove:hover,
  .card-btn.remove:active {
    color: var(--accent, #e15b37);
  }

  .card-btn.confirm-delete {
    background: var(--danger, #b91c1c);
    color: var(--on-accent);
    font-size: 0.72rem;
  }

  .card-btn.cancel-delete {
    background: var(--hover);
    color: var(--muted, #8a95a5);
    font-size: 0.72rem;
  }

  .card-btn.edit {
    background: var(--hover);
    color: var(--ink, #182230);
    border: 1px solid var(--line);
  }

  .card-btn.save {
    background: #1f8f61;
    color: var(--on-accent);
  }

  .card-btn.cancel {
    background: var(--hover);
    color: var(--muted, #8a95a5);
    border: 1px solid var(--line);
  }

  .edit-form {
    display: grid;
    gap: 0.4rem;
  }

  .edit-input {
    width: 100%;
    min-height: 2.2rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md, 12px);
    background: var(--paper-strong);
    /* iOS zooms inputs <16px on focus — keep at 16px to prevent zoom. */
    font-size: 16px;
    font-weight: 600;
    color: var(--ink, #182230);
  }

  .edit-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .edit-input.date {
    color: var(--muted, #617086);
  }

  .edit-actions {
    display: flex;
    gap: 0.35rem;
  }

  /* ---- Modal ---- */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(30, 38, 52, 0.35);
    backdrop-filter: blur(4px);
    display: grid;
    place-items: center;
    z-index: 300;
    /* Inset the centered sheet from the iOS status bar / home indicator.
       Without this, on notched iPhones the modal-close (X) button at the
       top-right of the sheet sits under the translucent status bar. The
       max() keeps the existing 1rem gutter on devices without insets. */
    padding-top: max(1rem, var(--safe-top, 0px));
    padding-right: 1rem;
    padding-bottom: max(1rem, var(--safe-bottom, 0px));
    padding-left: 1rem;
    animation: fade-in 150ms ease;
  }

  .modal-sheet {
    width: min(100%, 420px);
    /* Match the backdrop padding so the sheet never extends behind the
       status bar / home indicator even when its content is tall. */
    max-height: calc(100dvh - max(1rem, var(--safe-top, 0px)) - max(1rem, var(--safe-bottom, 0px)));
    background: var(--paper-strong);
    border-radius: var(--radius-xl, 20px);
    box-shadow: var(--shadow);
    /* flex column lets the inner .modal-content take the remaining space and
       scroll, while .modal-actions stays pinned as a sticky-style footer. */
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: pop-in 200ms ease;
  }

  .modal-content {
    /* The actual scroll container — songs scroll here, action buttons stay
       pinned outside this element. min-height: 0 is required so flex children
       respect overflow on iOS Safari. */
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }

  .modal-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    border: none;
    background: var(--hover);
    font-size: 1.3rem;
    color: var(--muted);
    cursor: pointer;
    line-height: 1;
    padding: 0;
    width: 1.8rem;
    height: 1.8rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    z-index: 1;
  }

  .modal-close:active {
    background: var(--hover-strong);
  }

  /* ---- Setlist viewer (theme-aware on screen) ----
     The class names start with "print-" for historical reasons (the same DOM
     was originally cloned into a popup window for printing). The actual print
     popup now injects its own black-on-white CSS in handlePrint(), so these
     rules only style the on-screen viewer and are free to follow the theme. */
  .print-setlist {
    padding: 0.75rem;
    display: grid;
    gap: 0;
    color: var(--ink);
    position: relative;
  }

  .print-top {
    padding-bottom: 0.5rem;
    border-bottom: 2px solid var(--ink);
    margin-bottom: 0.35rem;
  }

  .print-band {
    font-size: 1.15rem;
    font-weight: 800;
    color: var(--ink);
    margin: 0;
    line-height: 1.2;
  }

  .print-subtitle {
    font-size: 0.78rem;
    font-weight: 400;
    color: var(--muted);
    margin: 0.1rem 0 0;
  }

  .print-songs {
    display: grid;
    gap: 0;
  }

  .print-song {
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--line);
  }

  .print-song-row {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }

  .print-num {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--muted);
    min-width: 1.6rem;
    text-align: right;
    flex-shrink: 0;
  }

  .print-song-name {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--ink);
    flex: 1;
  }

  .print-song-key {
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--ink);
    flex-shrink: 0;
    padding: 0.05rem 0.35rem;
    border: 1px solid var(--line-strong);
    border-radius: 4px;
  }

  .print-changes {
    padding-left: 2rem;
    padding-top: 0.15rem;
    display: grid;
    gap: 0.05rem;
  }

  .print-change {
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
    font-size: 0.72rem;
    color: var(--ink);
  }

  .print-change.setup {
    color: var(--muted);
  }

  .print-change-member {
    font-weight: 700;
    flex-shrink: 0;
  }

  .print-change-detail {
    font-weight: 500;
  }

  .print-notes {
    padding-left: 2rem;
    padding-top: 0.15rem;
    font-size: 0.72rem;
    font-style: italic;
    color: var(--muted);
    line-height: 1.45;
    white-space: pre-line;
    font-weight: 500;
  }

  .print-anxiety {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 2px solid var(--ink);
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.82rem;
    color: var(--ink);
  }

  .print-anxiety-title { font-weight: 700; }
  .print-anxiety-score { font-weight: 800; }
  .print-anxiety-label { font-weight: 400; color: var(--muted); }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem 0.75rem;
    border-top: 1px solid var(--line);
    /* Pinned footer: stays in place while .modal-content scrolls. */
    flex-shrink: 0;
    background: var(--paper-strong);
  }

  .modal-btn {
    flex: 1;
    min-height: 2.4rem;
    border: 1.5px solid var(--line);
    border-radius: var(--radius-md, 12px);
    background: transparent;
    color: var(--ink, #182230);
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: background 120ms ease, transform 80ms ease;
  }

  .modal-btn:active {
    transform: scale(0.97);
  }

  .modal-btn.primary {
    background: linear-gradient(140deg, var(--accent) 0%, var(--accent-strong) 100%);
    color: var(--on-accent);
    border-color: transparent;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes pop-in {
    0% { transform: scale(0.92); opacity: 0; }
    70% { transform: scale(1.02); }
    100% { transform: scale(1); opacity: 1; }
  }

</style>
