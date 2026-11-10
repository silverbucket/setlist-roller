<script>
  import { getContext, tick } from "svelte";
  import { anxietyLabel } from "../../anxiety.js";
  import { songChangeLines } from "../../transitions.js";
  import Icon from "../shared/Icon.svelte";

  const store = getContext("app");

  let viewingId = $state(null);
  let viewingSet = $derived(
    viewingId ? (store.displayedSavedSetlists?.find(s => s.id === viewingId) ?? null) : null
  );
  let editingId = $state(null);
  let editName = $state("");
  let editDate = $state("");
  let editVenue = $state("");
  let activeList = $state("drafts");
  let markingPerformedId = $state(null);
  let performedDate = $state("");
  let performedVenue = $state("");
  let confirmingHistoryDeleteId = $state(null);
  let confirmDialogEl = $state(null);
  let confirmationReturnFocus = null;
  let draftSetlists = $derived(store.displayedSavedSetlists?.filter((setlist) => !setlist.performedAt) ?? []);
  let performedSetlists = $derived(
    [...(store.displayedSavedSetlists?.filter((setlist) => setlist.performedAt) ?? [])]
      .sort((a, b) => b.performedAt.localeCompare(a.performedAt))
  );
  let visibleSetlists = $derived(activeList === "drafts" ? draftSetlists : performedSetlists);

  function handleView(saved) {
    if (editingId) return;
    viewingId = saved.id;
  }

  function startEdit(e, saved) {
    e.stopPropagation();
    editingId = saved.id;
    editName = saved.name || "";
    // Convert ISO to YYYY-MM-DD for date input
    const date = saved.performedAt || saved.savedAt;
    editDate = date ? dateInputValue(date) : "";
    editVenue = saved.venue || "";
  }

  function saveEdit(e) {
    if (e) e.stopPropagation();
    if (!editingId) return;
    const saved = store.displayedSavedSetlists?.find((setlist) => setlist.id === editingId);
    const dateField = saved?.performedAt ? "performedAt" : "savedAt";
    const editedDate = editDate
      ? (saved?.performedAt ? editDate : new Date(`${editDate}T12:00:00`).toISOString())
      : saved?.[dateField];
    store.updateSavedSetlist(editingId, {
      name: editName.trim() || "Untitled Set",
      [dateField]: editedDate,
      venue: editVenue.trim() || null,
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
    const saved = store.displayedSavedSetlists?.find((setlist) => setlist.id === id);
    if (saved?.performedAt) {
      confirmationReturnFocus = e.currentTarget;
      confirmingHistoryDeleteId = id;
      return;
    }
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

  function startMarkPerformed(e, saved) {
    e.stopPropagation();
    confirmationReturnFocus = e.currentTarget;
    markingPerformedId = saved.id;
    performedDate = dateInputValue(new Date());
    performedVenue = saved.venue || "";
  }

  async function confirmMarkPerformed() {
    if (!markingPerformedId || !performedDate) return;
    const saved = await store.markSetlistPerformed(
      markingPerformedId,
      performedDate,
      performedVenue.trim() || null,
    );
    if (!saved) return;
    markingPerformedId = null;
    performedVenue = "";
    activeList = "performed";
  }

  function cancelMarkPerformed() {
    markingPerformedId = null;
    performedVenue = "";
  }

  async function confirmHistoryDelete() {
    if (!confirmingHistoryDeleteId) return;
    const removed = await store.removeSavedSetlist(confirmingHistoryDeleteId);
    if (removed) confirmingHistoryDeleteId = null;
  }

  async function moveToDrafts(e, saved) {
    e.stopPropagation();
    const updated = await store.moveSetlistToDrafts(saved.id);
    if (!updated) return;
    activeList = "drafts";
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
  .print-change-detail { font-weight: 500; display: inline-flex; flex-wrap: wrap; gap: 4px; }
  .print-chip { display: inline-block; padding: 0 6px; border: 1px solid #bbb; border-radius: 999px; white-space: nowrap; }
  .print-chip-kind { font-size: 0.85em; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
  .print-chip.tuning { background: #000; border-color: #000; color: #fff; font-weight: 700; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .print-chip.instrument { border: 2px solid #000; font-weight: 700; }
  .print-chip.capo { border-style: dashed; border-color: #888; color: #333; }
  .print-chip.technique { border-color: transparent; background: #eee; color: #333; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .print-chip-icon { vertical-align: -1px; }
  .print-change.setup .print-chip { border-color: #ccc; color: #666; }
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
    const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function dateInputValue(value) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function closeConfirmation() {
    if (markingPerformedId) cancelMarkPerformed();
    else confirmingHistoryDeleteId = null;
  }

  function confirmationKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeConfirmation();
      return;
    }
    if (e.key !== "Tab" || !confirmDialogEl) return;
    const focusable = [...confirmDialogEl.querySelectorAll('button:not([disabled]), input:not([disabled])')];
    if (!focusable.length) {
      e.preventDefault();
      confirmDialogEl.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!confirmDialogEl.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    if (!markingPerformedId && !confirmingHistoryDeleteId) return;
    const returnFocus = confirmationReturnFocus || document.activeElement;
    window.addEventListener("keydown", confirmationKeydown);
    tick().then(() => confirmDialogEl?.querySelector("input, button")?.focus());
    return () => {
      window.removeEventListener("keydown", confirmationKeydown);
      if (returnFocus && document.body.contains(returnFocus)) returnFocus.focus();
      confirmationReturnFocus = null;
    };
  });

  // Transition notes — shared with SetlistSongCard via transitions.js
  const CHANGE_PREFIX = { tuning: "Tune", instrument: "Swap" };
</script>

<div class="saved-screen">
  <h2 class="screen-title">Setlists</h2>

  <div class="list-tabs segmented" aria-label="Setlist status">
    <button type="button" aria-pressed={activeList === "drafts"} class:active={activeList === "drafts"} onclick={() => activeList = "drafts"}>Drafts <span>{draftSetlists.length}</span></button>
    <button type="button" aria-pressed={activeList === "performed"} class:active={activeList === "performed"} onclick={() => activeList = "performed"}>Performed <span>{performedSetlists.length}</span></button>
  </div>

  {#if !visibleSetlists.length}
    <div class="empty-state">
      <p class="empty-title">{activeList === "drafts" ? "No drafts" : "No performed setlists"}</p>
      <p class="empty-sub">{activeList === "drafts" ? "Save a setlist to keep working on it with the band." : "Mark a draft as performed after you use it at a show."}</p>
    </div>
  {:else}
    <div class="saved-list">
      {#each visibleSetlists as saved}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="saved-card" onclick={() => handleView(saved)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') handleView(saved); }}>
          {#if editingId === saved.id}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="edit-form" onclick={(e) => e.stopPropagation()}>
              <input class="edit-input input" type="text" aria-label="Setlist name" bind:value={editName} placeholder="Setlist name" onkeydown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }} />
              <input class="edit-input input date" type="date" aria-label="Date" bind:value={editDate} />
              {#if saved.performedAt}
                <input class="edit-input input" type="text" aria-label="Venue" bind:value={editVenue} placeholder="Venue (optional)" />
              {/if}
              <div class="edit-actions">
                <button type="button" class="btn btn-sm btn-primary card-btn save" onclick={saveEdit}>Save</button>
                <button type="button" class="btn btn-sm btn-ghost card-btn cancel" onclick={cancelEdit}>Cancel</button>
              </div>
            </div>
          {:else}
            <div class="saved-top">
              <span class="saved-name">{saved.name || `Set #${saved.songs?.length || "?"}`}</span>
              <span class="saved-date">{formatDate(saved.performedAt || saved.savedAt)}</span>
            </div>
            <div class="saved-meta">
              <span>{saved.songs?.length || 0} songs</span>
              {#if saved.venue}<span class="saved-venue">{saved.venue}</span>{/if}
            </div>
            <div class="saved-card-actions">
              <button type="button" class="btn btn-sm btn-primary card-btn load" onclick={(e) => handleLoad(e, saved.id)}>{saved.performedAt ? "Use as draft" : "Open"}</button>
              {#if saved.performedAt}
                <button type="button" class="btn btn-sm card-btn status" onclick={(e) => moveToDrafts(e, saved)}>Move to drafts</button>
              {:else}
                <button type="button" class="btn btn-sm card-btn status" onclick={(e) => startMarkPerformed(e, saved)}>Mark performed</button>
              {/if}
              <span class="action-spacer"></span>
              <button type="button" class="icon-btn card-btn edit" onclick={(e) => startEdit(e, saved)} aria-label="Edit" title="Rename or change date"><Icon name="pencil" size={17} /></button>
              {#if confirmingRemoveId === saved.id}
                <button type="button" class="btn btn-sm btn-danger card-btn confirm-delete" onclick={(e) => handleRemove(e, saved.id)}>Delete?</button>
                <button type="button" class="btn btn-sm btn-ghost card-btn cancel-delete" onclick={cancelRemove}>No</button>
              {:else}
                <button type="button" class="icon-btn card-btn remove" onclick={(e) => handleRemove(e, saved.id)} aria-label="Remove"><Icon name="trash" size={17} /></button>
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
            <button type="button" class="icon-btn modal-close no-print" onclick={handleClose} aria-label="Close"><Icon name="x" size={20} /></button>
            <!-- On screen the setlist's own name leads; the printed sheet
                 keeps the band name as its masthead (print-only pair below). -->
            <h2 class="viewer-title no-print">{viewingSet.name || "Setlist"}</h2>
            <p class="viewer-subtitle no-print">
                <span>{store.appTitle.replace(/ — Setlist Roller$/, "")}</span>
                <span>{viewingSet.performedAt ? `Performed ${formatDate(viewingSet.performedAt)}${viewingSet.venue ? ` at ${viewingSet.venue}` : ""}` : `Draft, updated ${formatDate(viewingSet.savedAt)}`}</span>
            </p>
            <h2 class="print-band print-only">{store.appTitle.replace(/ — Setlist Roller$/, "")}</h2>
            <p class="print-subtitle print-only">{viewingSet.name || "Setlist"} &middot; {viewingSet.performedAt ? `Performed ${formatDate(viewingSet.performedAt)}${viewingSet.venue ? ` at ${viewingSet.venue}` : ""}` : `Draft updated ${formatDate(viewingSet.savedAt)}`}</p>
          </div>

          <div class="print-songs">
            {#each viewingSet.songs as song, i}
              {@const prevSong = i > 0 ? viewingSet.songs[i - 1] : null}
              {@const changes = songChangeLines(song, prevSong)}
              <div class="print-song">
                <div class="print-song-row">
                  <span class="print-num">{i + 1}</span>
                  <span class="print-song-name">{song.name || song.title || "Untitled"}</span>
                  {#if song.key}
                    <span class="print-song-key">{song.key}</span>
                  {/if}
                </div>
                {#if changes.length > 0}
                  <div class="print-changes">
                    {#each changes as line}
                      <div class="print-change" class:setup={line.isSetup}>
                        <span class="print-change-member">{line.member}</span>
                        <span class="print-change-detail">
                          {#each line.changes as change}
                            <span class="print-chip {change.kind}">{#if !line.isSetup && change.kind === "tuning"}<svg class="print-chip-icon" aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v7a4 4 0 0 0 8 0V3"/><path d="M12 14v7"/></svg> {/if}{#if !line.isSetup && CHANGE_PREFIX[change.kind]}<span class="print-chip-kind">{CHANGE_PREFIX[change.kind]}</span> {/if}{change.label}</span>
                          {/each}
                        </span>
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
              <span class="print-anxiety-title">Bass player anxiety:</span>
              <span class="print-anxiety-score">{anxiety.scaled}/10</span>
              <span class="print-anxiety-label">{anxietyLabel(anxiety)}</span>
            </div>
          {/if}
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn modal-btn" onclick={handlePrint}><Icon name="printer" size={17} /> Print / Export PDF</button>
        <button type="button" class="btn btn-primary modal-btn primary" onclick={(e) => { handleLoad(e, viewingSet.id); viewingId = null; }}>{viewingSet.performedAt ? "Use as new draft" : "Edit setlist"}</button>
      </div>
    </div>
  </div>
{/if}

{#if markingPerformedId}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="dialog-backdrop confirmation-backdrop" role="presentation" onclick={cancelMarkPerformed}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="confirm-sheet dialog" bind:this={confirmDialogEl} role="dialog" aria-modal="true" aria-labelledby="performed-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <h2 id="performed-title" class="dialog-title">Mark as performed?</h2>
      <p class="dialog-desc">This preserves the setlist as a record of the show.</p>
      <div class="field">
        <label class="field-label" for="performed-date">Show date</label>
        <input class="input" id="performed-date" type="date" bind:value={performedDate} />
      </div>
      <div class="field">
        <label class="field-label" for="performed-venue">Venue <span class="optional">(optional)</span></label>
        <input class="input" id="performed-venue" type="text" bind:value={performedVenue} placeholder="Venue name" />
      </div>
      <div class="confirm-actions dialog-actions">
        <button type="button" class="btn modal-btn" onclick={cancelMarkPerformed}>Cancel</button>
        <button type="button" class="btn btn-primary modal-btn primary" onclick={confirmMarkPerformed}>Mark as performed</button>
      </div>
    </div>
  </div>
{/if}

{#if confirmingHistoryDeleteId}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="dialog-backdrop confirmation-backdrop" role="presentation" onclick={() => confirmingHistoryDeleteId = null}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="confirm-sheet dialog" bind:this={confirmDialogEl} role="alertdialog" aria-modal="true" aria-labelledby="history-delete-title" tabindex="-1" onclick={(e) => e.stopPropagation()}>
      <h2 id="history-delete-title" class="dialog-title">Delete performed setlist?</h2>
      <p class="dialog-desc">This setlist is part of your show history. Deleting it permanently removes that record.</p>
      <div class="confirm-actions dialog-actions">
        <button type="button" class="btn modal-btn" onclick={() => confirmingHistoryDeleteId = null}>Keep history</button>
        <button type="button" class="btn btn-danger modal-btn danger" onclick={confirmHistoryDelete}>Delete permanently</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .saved-screen {
    display: grid;
    gap: var(--space-4);
    max-width: 640px;
    margin: 0 auto;
  }

  @media (min-width: 900px) {
    .saved-screen {
      max-width: none;
      margin: 0;
    }
  }

  .list-tabs {
    display: flex;
    justify-self: start;
    width: min(100%, 360px);
  }

  .list-tabs button {
    flex: 1;
    min-height: 40px;
  }

  .list-tabs span {
    margin-left: 0.3rem;
    font-weight: 500;
    color: var(--muted);
  }

  .saved-list {
    display: grid;
    gap: var(--space-3);
  }

  @media (min-width: 900px) {
    .saved-list {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-4);
    }
  }

  .saved-card {
    border-radius: var(--radius-lg);
    background: var(--surface);
    border: 1px solid var(--line);
    padding: var(--space-4);
    display: grid;
    align-content: start;
    gap: 0.25rem;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }

  .saved-card:hover {
    border-color: var(--line-strong);
    box-shadow: var(--shadow-sm);
  }

  .saved-top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3);
  }

  .saved-name {
    font-family: var(--font-display);
    font-size: 1.12rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.3;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .saved-date {
    flex-shrink: 0;
    font-size: 0.86rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .saved-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.35rem;
    font-size: 0.9rem;
    color: var(--muted);
  }

  .saved-venue::before {
    content: "at ";
  }

  .saved-card-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin-top: var(--space-3);
  }

  .action-spacer {
    flex: 1;
  }

  .card-btn.edit,
  .card-btn.remove {
    width: 36px;
    height: 36px;
    color: var(--muted);
  }

  .card-btn.remove:hover {
    color: var(--danger);
    background: var(--danger-soft);
  }

  .edit-form {
    display: grid;
    gap: var(--space-2);
  }

  .edit-actions {
    display: flex;
    gap: 0.4rem;
    margin-top: var(--space-1);
  }

  .confirm-sheet .optional {
    color: var(--muted);
    font-weight: 400;
  }

  .confirmation-backdrop {
    z-index: 700;
  }

  /* ---- Setlist viewer ---- */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--overlay);
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
    animation: ui-fade-in 150ms ease;
  }

  .modal-sheet {
    width: min(100%, 560px);
    /* Match the backdrop padding so the sheet never extends behind the
       status bar / home indicator even when its content is tall. */
    max-height: calc(100dvh - max(1rem, var(--safe-top, 0px)) - max(1rem, var(--safe-bottom, 0px)));
    background: var(--paper-strong);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow);
    /* flex column lets the inner .modal-content take the remaining space and
       scroll, while .modal-actions stays pinned as a sticky-style footer. */
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: ui-pop-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
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
    top: 0.6rem;
    right: 0.6rem;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--hover);
    z-index: 1;
  }

  /* The viewer is the stage sheet: the band name as a masthead, then the
     running order in type big enough to read at arm's length.
     The class names start with "print-" for historical reasons (the same DOM
     is cloned into a popup window for printing). The print popup injects its
     own black-on-white CSS in handlePrint(), so these rules only style the
     on-screen viewer and are free to follow the theme. */
  .print-setlist {
    padding: var(--space-5) var(--space-5) var(--space-4);
    display: grid;
    gap: 0;
    color: var(--ink);
    position: relative;
  }

  .print-top {
    padding: 0 2.5rem var(--space-3) 0;
    border-bottom: 2px solid var(--ink);
  }

  /* Print-only masthead: hidden here, shown by the print popup's own CSS. */
  .print-only {
    display: none;
  }

  .viewer-title {
    font-size: 1.6rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--ink);
    margin: 0;
    line-height: 1.15;
  }

  .viewer-subtitle {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5rem;
    font-size: 0.9rem;
    color: var(--muted);
    margin: 0.3rem 0 0;
  }

  .viewer-subtitle span:first-child {
    font-weight: 600;
    color: var(--ink-2);
  }

  .viewer-subtitle span {
    white-space: nowrap;
  }

  .print-songs {
    display: grid;
    gap: 0;
  }

  .print-song {
    padding: 0.65rem 0;
    border-bottom: 1px solid var(--line);
  }

  .print-song-row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }

  .print-num {
    font-family: var(--font-display);
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--muted);
    min-width: 1.5rem;
    text-align: right;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .print-song-name {
    font-family: var(--font-display);
    font-size: 1.15rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.3;
    color: var(--ink);
    flex: 1;
  }

  .print-song-key {
    font-family: var(--font-display);
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--ink-2);
    flex-shrink: 0;
    min-width: 2.1rem;
    text-align: center;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
  }

  .print-changes {
    padding-left: 2.1rem;
    padding-top: 0.3rem;
    display: grid;
    gap: 0.25rem;
  }

  .print-change {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.84rem;
    color: var(--ink-2);
  }

  .print-change.setup {
    color: var(--muted);
  }

  .print-change-member {
    font-weight: 600;
    flex-shrink: 0;
  }

  .print-change-detail {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .print-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.05rem 0.45rem;
    border-radius: 6px;
    border: 1px solid var(--line-strong);
    font-size: 0.8rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .print-chip-kind {
    font-weight: 700;
  }

  .print-chip.tuning {
    background: var(--accent-fill);
    border-color: var(--accent-fill);
    color: var(--on-accent);
  }

  .print-chip.instrument {
    background: var(--accent-soft);
    border-color: var(--accent-line);
    color: var(--accent-text);
  }

  .print-chip.capo {
    background: var(--warning-soft);
    border-color: transparent;
    color: var(--warning);
  }

  .print-chip.technique {
    background: var(--hover-strong);
    border-color: transparent;
    color: var(--ink-2);
  }

  .print-chip-icon {
    flex-shrink: 0;
  }

  .print-change.setup .print-chip {
    background: transparent;
    border-color: var(--line-strong);
    color: var(--muted);
    font-weight: 500;
  }

  .print-notes {
    padding-left: 2.1rem;
    padding-top: 0.3rem;
    font-size: 0.88rem;
    color: var(--muted);
    line-height: 1.45;
    white-space: pre-line;
  }

  .print-anxiety {
    margin-top: -1px;
    padding-top: var(--space-3);
    border-top: 2px solid var(--ink);
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.1rem 0.4rem;
    font-size: 0.9rem;
    color: var(--ink);
  }

  .print-anxiety-title { font-weight: 600; }
  .print-anxiety-score { font-family: var(--font-display); font-weight: 700; }
  .print-anxiety-label { color: var(--muted); }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
    padding: var(--space-3) var(--space-4) var(--space-4);
    border-top: 1px solid var(--line);
    /* Pinned footer: stays in place while .modal-content scrolls. */
    flex-shrink: 0;
    background: var(--paper-strong);
  }

  .modal-actions .modal-btn {
    flex: 1;
    padding: 0 0.6rem;
  }

  /* Phones: the viewer docks to the bottom edge and covers the tab bar,
     like every other dialog. The top inset stays (status bar / notch). */
  @media (max-width: 599px) {
    .modal-backdrop {
      align-items: end;
      padding-right: 0;
      padding-bottom: 0;
      padding-left: 0;
    }

    .modal-backdrop .modal-sheet {
      width: 100%;
      max-height: calc(100dvh - max(1rem, var(--safe-top, 0px)));
      border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    }

    .modal-backdrop .modal-actions {
      padding-bottom: calc(var(--space-4) + var(--safe-bottom, 0px));
    }
  }
</style>
