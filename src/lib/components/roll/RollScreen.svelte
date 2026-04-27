<script>
  import { getContext } from "svelte";
  import { anxietyLabel } from "../../anxiety.js";
  import { DEFAULT_DIE_COLOR, darkenHex, hexToRgb } from "../../utils.js";
  import ChipToggle from "../shared/ChipToggle.svelte";
  import NumberStepper from "../shared/NumberStepper.svelte";
  import SetlistSongCard from "./SetlistSongCard.svelte";

  const store = getContext("app");

  let showConfetti = $state(false);
  let diceValue = $state(6);
  let landed = $state(false);
  let showAddSongPicker = $state(false);
  let addSongSearch = $state("");
  let setlistSongIds = $derived(
    new Set((store.generatedSetlist?.songs || []).map((s) => s.id))
  );
  let filteredPickerSongs = $derived.by(() => {
    const eligible = store.songs?.filter((s) => !s.unpracticed) || [];
    if (!addSongSearch) return eligible;
    const q = addSongSearch.toLowerCase();
    return eligible.filter((s) => s.name.toLowerCase().includes(q));
  });

  // Watch for generation completing with a result
  let prevGenerating = false;
  $effect(() => {
    const generating = store.isGenerating;
    if (prevGenerating && !generating) {
      diceValue = Math.floor(Math.random() * 6) + 1;
      if (store.generatedSetlist) {
        landed = true;
        showConfetti = true;
        setTimeout(() => { showConfetti = false; landed = false; }, 1200);
      }
    }
    prevGenerating = generating;
  });

  // ---- Die color ----
  let pipColor = $derived(store.appConfig?.ui?.dieColor || DEFAULT_DIE_COLOR);
  let pipColorDark = $derived(darkenHex(pipColor, 0.78));
  let pipColorRgb = $derived(hexToRgb(pipColor));

  // Dice pip layouts: [x, y] positions on a 0-1 grid for each face value
  const PIP_LAYOUTS = {
    1: [[0.5, 0.5]],
    2: [[0.25, 0.25], [0.75, 0.75]],
    3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
    4: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
    5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
    6: [[0.25, 0.22], [0.75, 0.22], [0.25, 0.5], [0.75, 0.5], [0.25, 0.78], [0.75, 0.78]],
  };

  // New band detection — only songs are required to roll
  let hasSongs = $derived((store.songs || []).length > 0);
  let readyToRoll = $derived(hasSongs);

  const ROLL_NUDGES = [
    "The setlist isn't going to roll itself.",
    "That die up there? It's getting lonely.",
    "Tap Roll. Trust the dice.",
    "Your songs are ready. Are you?",
    "Fortune favors the bold. Hit Roll.",
    "No setlist survives first contact with the stage. Roll one anyway.",
  ];
  let nudgeText = ROLL_NUDGES[Math.floor(Math.random() * ROLL_NUDGES.length)];

  function handleRoll() {
    if (settingsEl) settingsEl.open = false;
    store.requestRoll();
  }

  function handleLock() {
    store.lockSetlist();
  }

  function handleSaveSetlist() {
    store.saveCurrentSetlist();
  }

  // Determine which members have multiple instrument/tuning options worth toggling
  function memberHasChoices(memberName) {
    const instruments = store.memberInstrumentChoicesByMember?.[memberName];
    if (instruments && instruments.length > 1) return true;
    const tunings = store.memberTuningChoicesByMember?.[memberName];
    if (tunings) {
      for (const inst of Object.keys(tunings)) {
        if (tunings[inst].length > 1) return true;
      }
    }
    return false;
  }

  function membersWithChoices() {
    return (store.availableMemberNames || []).filter(memberHasChoices);
  }

  function selectedInstrumentCount(memberName) {
    return (store.generationOptions.show?.members?.[memberName]?.allowedInstruments || []).length;
  }

  function selectedTuningCount(memberName, instName) {
    return (store.generationOptions.show?.members?.[memberName]?.allowedTunings?.[instName] || []).length;
  }

  // Variety slider: maps 0-100 to temperature 0.3-2.0
  function varietyToTemp(v) { return 0.3 + (v / 100) * 1.7; }
  function tempToVariety(t) { return Math.round(((t - 0.3) / 1.7) * 100); }
  let varietyValue = $derived(tempToVariety(store.generationOptions.randomness?.temperature ?? 0.85));

  let settingsTab = $state("constraints");
  let hasConstraints = $derived(membersWithChoices().length > 0);
  // anxietyLevel: pre-computed by the generator, label from anxiety lib
  let anxietyLevel = $derived.by(() => {
    const anxiety = store.generatedSetlist?.summary?.anxiety;
    if (!anxiety) return { scaled: 0, label: "" };
    return { scaled: anxiety.scaled, label: anxietyLabel(anxiety) };
  });
  let settingsEl = $state(null);

  // ---- drag-to-reorder ----
  function handleEditSong(songId) {
    const catalogSong = store.songs.find((s) => s.id === songId);
    if (catalogSong) {
      store.editReturnView = "roll";
      store.openSong(catalogSong);
      store.navigate("songs");
    }
  }

  let dragIndex = $state(null);
  let dragOverIndex = $state(null);
  let songListEl = $state(null);

  function handleDragStart(e, index) {
    e.preventDefault();
    dragIndex = index;
    dragOverIndex = index;

    const onMove = (me) => {
      if (dragIndex === null || !songListEl) return;
      const cards = Array.from(songListEl.children);
      const y = me.clientY;
      let closest = dragIndex;
      let minDist = Infinity;
      cards.forEach((card, i) => {
        const rect = card.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const dist = Math.abs(y - mid);
        if (dist < minDist) { minDist = dist; closest = i; }
      });
      dragOverIndex = closest;
    };

    const onUp = () => {
      if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
        store.reorderSetlistSong(dragIndex, dragOverIndex);
      }
      dragIndex = null;
      dragOverIndex = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
</script>

<div class="roll-screen">
  <!-- Hero area -->
  <div class="hero">
    <div class="hero-row">
      <div class="count-control">
        <span class="field-label">Songs</span>
        <NumberStepper
          value={store.generationOptions.count}
          min={1}
          max={30}
          label="Song count"
          onchange={(v) => store.updateGenerationField("count", v)}
        />
      </div>
      <button type="button" class="roll-btn" class:rolling={store.isGenerating} class:landed class:disabled={!readyToRoll} disabled={!readyToRoll} onclick={handleRoll} aria-label="Roll setlist" style="--btn-color: {pipColor}; --btn-color-dark: {pipColorDark}; --btn-rgb: {pipColorRgb};">
        <span class="dice-container" class:rolling={store.isGenerating}>
          <svg aria-hidden="true" class="dice-svg" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="3" width="50" height="50" rx="10" ry="10"
              fill="#fff" stroke="rgba(0,0,0,0.08)" stroke-width="1"/>
            {#each PIP_LAYOUTS[diceValue] as [px, py]}
              <circle cx={6 + px * 44} cy={6 + py * 44} r="4.5" fill={pipColor}/>
            {/each}
          </svg>
        </span>
        <span class="roll-label">{store.isGenerating ? "Rolling..." : "Roll"}</span>
        {#if showConfetti}
          <span class="confetti-burst">
            {#each Array(12) as _, i}
              <span class="confetti-dot" style="--i:{i}"></span>
            {/each}
          </span>
        {/if}
      </button>
    </div>

    <!-- Settings (inside hero) -->
    <details class="settings-drawer" bind:this={settingsEl}>
      <summary class="settings-toggle">
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <span>Settings</span>
    </summary>
    <div class="settings-body">
      {#if hasConstraints}
        <div class="settings-tabs">
          <button type="button" class="settings-tab" class:active={settingsTab === "constraints"} onclick={() => { settingsTab = "constraints"; }}>Demands</button>
          <button type="button" class="settings-tab" class:active={settingsTab === "chaos"} onclick={() => { settingsTab = "chaos"; }}>Tweak the Chaos</button>
        </div>
      {/if}

      {#if settingsTab === "chaos" || !hasConstraints}
        <div class="quick-row">
          <div class="adv-field">
            <span>Max covers</span>
            <input
              type="number"
              min="0"
              aria-label="Max covers"
              disabled={store.generationOptions.maxCovers < 0}
              value={store.generationOptions.maxCovers < 0 ? "" : store.generationOptions.maxCovers}
              oninput={(e) => store.updateGenerationField("maxCovers", Number(e.currentTarget.value))}
            />
            <label class="no-limit-toggle">
              <input
                type="checkbox"
                checked={store.generationOptions.maxCovers < 0}
                onchange={(e) => store.updateGenerationField("maxCovers", e.currentTarget.checked ? -1 : Math.max(0, store.appConfig?.general?.limits?.covers ?? 2))}
              />
              <span>No limit</span>
            </label>
          </div>
          <div class="adv-field">
            <span>Max instrumentals</span>
            <input
              type="number"
              min="0"
              aria-label="Max instrumentals"
              disabled={store.generationOptions.maxInstrumentals < 0}
              value={store.generationOptions.maxInstrumentals < 0 ? "" : store.generationOptions.maxInstrumentals}
              oninput={(e) => store.updateGenerationField("maxInstrumentals", Number(e.currentTarget.value))}
            />
            <label class="no-limit-toggle">
              <input
                type="checkbox"
                checked={store.generationOptions.maxInstrumentals < 0}
                onchange={(e) => store.updateGenerationField("maxInstrumentals", e.currentTarget.checked ? -1 : Math.max(0, store.appConfig?.general?.limits?.instrumentals ?? 2))}
              />
              <span>No limit</span>
            </label>
          </div>
        </div>

        <div class="variety-field">
          <div class="variety-header">
            <span class="variety-label">Variety</span>
            <span class="variety-hint">{varietyValue >= 100 ? "YOLO 🤘" : varietyValue < 30 ? "Safe pick" : varietyValue > 70 ? "Hold my beer" : "Feels right"}</span>
          </div>
          <input
            class="variety-slider"
            type="range"
            min="0"
            max="100"
            step="1"
            value={varietyValue}
            oninput={(e) => store.updateGenerationField("randomness.temperature", varietyToTemp(Number(e.currentTarget.value)))}
          />
          <div class="variety-labels">
            <span>Safe pick</span>
            <span>Hold my beer</span>
          </div>
        </div>

        <div class="toggle-row">
          <ChipToggle
            checked={store.generationOptions.keyFlow}
            onchange={(e) => store.updateGenerationField("keyFlow", e.currentTarget.checked)}
          >Smooth key flow</ChipToggle>
        </div>

        <label class="adv-field">
          <span>Seed <span class="field-hint">(leave 0 for random)</span></span>
          <input
            type="number"
            value={store.generationOptions.seed}
            oninput={(e) => store.updateGenerationField("seed", Number(e.currentTarget.value))}
          />
        </label>
      {/if}

      {#if settingsTab === "constraints" && hasConstraints}
        {#each membersWithChoices() as memberName}
          <div class="constraint-member">
            <span class="constraint-member-name">{memberName}</span>

            {#if (store.memberInstrumentChoicesByMember?.[memberName] || []).length > 1}
              <div class="chip-row">
                {#each store.memberInstrumentChoicesByMember[memberName] as instrument}
                  <ChipToggle
                    checked={(store.generationOptions.show?.members?.[memberName]?.allowedInstruments || []).includes(instrument)}
                    onchange={() => {
                      store.ensureMemberShowConfig(memberName);
                      store.toggleListValue(`show.members.${memberName}.allowedInstruments`, instrument);
                    }}
                  >
                    {instrument}
                  </ChipToggle>
                {/each}
              </div>
              {#if selectedInstrumentCount(memberName) >= 2}
                <div class="min-songs-row">
                  <span class="min-songs-label">Min songs each</span>
                  <NumberStepper
                    value={store.generationOptions.show?.members?.[memberName]?.minSongsPerInstrument ?? 2}
                    min={1}
                    max={5}
                    label="Min songs per instrument"
                    onchange={(v) => store.updateGenerationField(`show.members.${memberName}.minSongsPerInstrument`, v)}
                  />
                </div>
              {/if}
            {/if}

            {#if store.memberTuningChoicesByMember?.[memberName]}
              {#each Object.entries(store.memberTuningChoicesByMember[memberName]) as [instName, tunings]}
                {#if tunings.length > 1}
                  <div class="tuning-group">
                    <span class="tuning-label">{instName} tunings</span>
                    <div class="chip-row">
                      {#each tunings as tuning}
                        <ChipToggle
                          checked={(store.generationOptions.show?.members?.[memberName]?.allowedTunings?.[instName] || []).includes(tuning)}
                          onchange={() => {
                            store.ensureMemberShowConfig(memberName);
                            store.toggleListValue(`show.members.${memberName}.allowedTunings.${instName}`, tuning);
                          }}
                        >
                          {tuning}
                        </ChipToggle>
                      {/each}
                    </div>
                    {#if selectedTuningCount(memberName, instName) >= 2}
                      <div class="min-songs-row">
                        <span class="min-songs-label">Min songs each</span>
                        <NumberStepper
                          value={store.generationOptions.show?.members?.[memberName]?.minSongsPerTuning?.[instName] ?? 2}
                          min={1}
                          max={5}
                          label="Min songs per tuning"
                          onchange={(v) => store.updateGenerationField(`show.members.${memberName}.minSongsPerTuning.${instName}`, v)}
                        />
                      </div>
                    {/if}
                  </div>
                {/if}
              {/each}
            {/if}
          </div>
        {/each}
      {/if}

    </div>
  </details>
  </div>

  <!-- Sync-in-progress placeholder: avoid showing the empty/onboarding state
       while we're still pulling the user's data after a swap or first connect.
       Without this, a newly-switched account looks identical to a fresh one. -->
  {#if !readyToRoll && store.syncState === 'syncing'}
    <div class="sync-skeleton" role="status" aria-live="polite" aria-label="Syncing your songs">
      <div class="skeleton-headline"></div>
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
      <p class="sync-skeleton-note">Pulling your songs from remoteStorage…</p>
    </div>
  {/if}

  <!-- Getting Started -->
  {#if !readyToRoll && store.syncState !== 'syncing'}
    <div class="onboarding-card">
      <div class="onboarding-illustration">🎸🥁🎤</div>
      <h2 class="onboarding-title">Almost showtime!</h2>
      <p class="onboarding-desc">Add some songs to your catalog and Setlist Roller will build you a setlist.</p>
      <ol class="onboarding-steps">
        <li class:done={hasSongs}>
          <span class="step-icon">{hasSongs ? "✓" : "1"}</span>
          <span class="step-text">
            {#if hasSongs}
              Songs added
            {:else}
              <button type="button" class="step-link" onclick={() => { store.navigate("songs"); }}>Add some songs</button>
              <span class="step-hint">Your catalog of tunes. Covers, originals, whatever you play.</span>
            {/if}
          </span>
        </li>
      </ol>
      <p class="onboarding-tip">Got members who switch guitars, tunings, or capos between songs? Add them in each song and Setlist Roller will minimize gear changes.</p>
      <p class="onboarding-footer">Then come back here and hit Roll.</p>
      <button type="button" class="help-toggle" onclick={() => store.navigate("help")}>How does this work?</button>
    </div>
  {/if}

  <!-- Ready to roll but nothing rolled yet -->
  {#if readyToRoll && !store.generatedSetlist}
    <div class="idle-nudge">
      <div class="idle-die-face" style="--pip-rgb: {pipColorRgb};">
        {#each PIP_LAYOUTS[5] as [px, py]}
          <span class="idle-pip" style="left:{px * 100}%;top:{py * 100}%"></span>
        {/each}
      </div>
      <p class="idle-tagline">{nudgeText}</p>
    </div>
  {/if}

  <!-- Setlist result -->
  {#if store.generatedSetlist}
    <section class="result-section">
      <div class="song-list" bind:this={songListEl}>
        {#each store.generatedSetlist.songs as song, i (song.id)}
          <div class="song-list-item" class:drag-over={dragIndex !== null && dragOverIndex === i && dragIndex !== i}>
            <SetlistSongCard
              {song}
              index={i}
              prevSong={i > 0 ? store.generatedSetlist.songs[i - 1] : null}
              onDragStart={handleDragStart}
              onEdit={handleEditSong}
              onRemove={(idx) => store.removeSetlistSong(idx)}
            />
          </div>
        {/each}
      </div>

      <div class="roadie-score">
        <span class="roadie-label">Bass Player Anxiety</span>
        <span class="roadie-val">{anxietyLevel.scaled}/10</span>
        <p class="roadie-hint">{anxietyLevel.label}</p>
      </div>

      <div class="setlist-actions">
        <button type="button" class="save-set-btn add-song-btn" onclick={() => { showAddSongPicker = true; }}>+ Add song</button>
        {#if store.setlistLocked}
          <div class="locked-badge">🔒 Locked in</div>
          {#if store.setlistSaved}
            <div class="saved-badge">✓ Saved</div>
          {:else}
            <button type="button" class="save-set-btn secondary" onclick={handleSaveSetlist}>Save to Greatest Hits</button>
          {/if}
        {:else}
          <button type="button" class="save-set-btn" onclick={handleLock}>Lock it in 🔒</button>
        {/if}
      </div>
    </section>
  {/if}

  {#if store.pendingRollConfirm}
    <div class="confirm-overlay" onclick={store.cancelRoll}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="confirm-dialog" onclick={(e) => e.stopPropagation()}>
        <p class="confirm-title">This setlist is locked in.</p>
        <p class="confirm-desc">What do you want to do?</p>
        <div class="confirm-actions-stacked">
          <button type="button" class="confirm-btn optimize" onclick={store.confirmOptimizeOrder}>Optimize order</button>
          <button type="button" class="confirm-btn proceed" onclick={store.confirmFreshRoll}>Fresh roll</button>
          <button type="button" class="confirm-btn cancel" onclick={store.cancelRoll}>Keep it</button>
        </div>
      </div>
    </div>
  {/if}

  {#if showAddSongPicker}
    <div class="confirm-overlay" onclick={() => { showAddSongPicker = false; }}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="confirm-dialog add-song-dialog" onclick={(e) => e.stopPropagation()}>
        <p class="confirm-title">Add a song</p>
        <input
          class="add-song-search"
          type="text"
          placeholder="Search songs..."
          bind:value={addSongSearch}
        />
        <div class="add-song-list">
          {#each filteredPickerSongs as song}
            {@const inSetlist = setlistSongIds.has(song.id)}
            <button type="button"
              class="add-song-item"
              class:in-setlist={inSetlist}
              disabled={inSetlist}
              onclick={() => { store.addSetlistSong(song.id); showAddSongPicker = false; addSongSearch = ""; }}
            >
              {song.name}
              {#if inSetlist}<span class="in-setlist-tag">added</span>{/if}
            </button>
          {:else}
            <p class="add-song-empty">No songs available</p>
          {/each}
        </div>
        <button type="button" class="confirm-btn cancel" onclick={() => { showAddSongPicker = false; addSongSearch = ""; }}>Cancel</button>
      </div>
    </div>
  {/if}

</div>

<style>
  .roll-screen {
    display: grid;
    gap: 0.75rem;
    padding: 0.5rem;
    max-width: 540px;
    margin: 0 auto;
  }

  @media (min-width: 400px) {
    .roll-screen {
      gap: 1rem;
      padding: 0.75rem;
    }
  }

  /* Hero */
  .hero {
    position: sticky;
    top: var(--top-bar-height);
    z-index: 50;
    background: var(--paper, rgba(255, 255, 255, 0.96));
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-radius: var(--radius-lg, 16px);
    border: 1px solid var(--line);
    padding: 0.6rem;
    display: grid;
    gap: 0.5rem;
    max-height: calc(100vh - var(--top-bar-height) - var(--bottom-nav-height, 56px) - var(--safe-bottom, 0px) - 1rem);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  @media (min-width: 400px) {
    .hero {
      padding: 0.75rem;
      gap: 0.6rem;
    }
  }

  .hero-row {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
  }

  .count-control {
    display: grid;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .field-label {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted, #8a95a5);
  }

  /* ---- Roll button ---- */
  .roll-btn {
    flex: 1;
    min-width: 0;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    height: 2.8rem;
    margin-bottom: 1px;
    padding: 0 0.8rem;
    border: none;
    border-radius: 14px;
    background: linear-gradient(140deg, var(--btn-color) 0%, var(--btn-color-dark) 100%);
    color: var(--on-accent);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    box-shadow:
      0 4px 12px rgba(var(--btn-rgb), 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.18);
    transition: transform 120ms ease, box-shadow 120ms ease;
    overflow: hidden;
  }

  .roll-btn:hover {
    transform: translateY(-2px);
    box-shadow:
      0 8px 24px rgba(var(--btn-rgb), 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.18);
  }

  .roll-btn.disabled {
    opacity: 0.45;
    cursor: not-allowed;
    pointer-events: none;
    box-shadow: none;
  }

  .roll-btn:active:not(.rolling) {
    transform: scale(0.97);
    box-shadow:
      0 2px 6px rgba(var(--btn-rgb), 0.25),
      inset 0 1px 0 rgba(255, 255, 255, 0.1);
  }

  .roll-btn.rolling {
    pointer-events: none;
    background: linear-gradient(140deg, var(--btn-color-dark) 0%, var(--btn-color-dark) 100%);
  }

  .roll-btn.landed {
    animation: btn-land 300ms ease;
  }

  @keyframes btn-land {
    0%   { transform: scale(1); }
    40%  { transform: scale(1.04); }
    100% { transform: scale(1); }
  }

  /* ---- Dice graphic ---- */
  .dice-container {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.15));
    transition: transform 150ms ease;
  }

  @media (min-width: 400px) {
    .dice-container {
      width: 44px;
      height: 44px;
    }
  }

  .roll-btn:hover .dice-container:not(.rolling) {
    animation: dice-hover 500ms ease;
  }

  .dice-container.rolling {
    animation: dice-roll 0.5s cubic-bezier(0.25, 0.1, 0.25, 1) infinite;
  }

  .dice-svg {
    width: 100%;
    height: 100%;
  }

  .roll-label {
    font-size: 0.95rem;
    font-weight: 800;
    letter-spacing: 0.02em;
  }

  @media (min-width: 400px) {
    .roll-label {
      font-size: 1.1rem;
    }
  }

  @keyframes dice-hover {
    0%, 100% { transform: rotate(0deg); }
    20%  { transform: rotate(-12deg) scale(1.05); }
    60%  { transform: rotate(8deg) scale(1.05); }
    80%  { transform: rotate(-3deg); }
  }

  @keyframes dice-roll {
    0%   { transform: rotate(0deg) scale(1) translateY(0); }
    15%  { transform: rotate(50deg) scale(0.9) translateY(-3px); }
    30%  { transform: rotate(-30deg) scale(1.05) translateY(1px); }
    50%  { transform: rotate(180deg) scale(0.92) translateY(-4px); }
    65%  { transform: rotate(240deg) scale(1.02) translateY(0); }
    80%  { transform: rotate(310deg) scale(0.95) translateY(-2px); }
    100% { transform: rotate(360deg) scale(1) translateY(0); }
  }

  /* ---- Confetti burst ---- */
  .confetti-burst {
    position: absolute;
    top: 50%;
    left: 50%;
    pointer-events: none;
    z-index: 10;
  }

  .confetti-dot {
    position: absolute;
    width: 6px;
    height: 6px;
    opacity: 0;
    animation: confetti-fly 800ms ease-out forwards;
    /* Each dot gets a unique angle from --i */
    --angle: calc(var(--i) * 30deg);
    --dist: 55px;
  }

  /* Shapes: mix circles and squares */
  .confetti-dot:nth-child(odd) { border-radius: 50%; }
  .confetti-dot:nth-child(even) { border-radius: 1px; transform: rotate(45deg); }

  .confetti-dot:nth-child(1)  { background: #e15b37; --dist: 50px; }
  .confetti-dot:nth-child(2)  { background: #4c75f4; --dist: 60px; }
  .confetti-dot:nth-child(3)  { background: #f4c84c; --dist: 45px; }
  .confetti-dot:nth-child(4)  { background: #1f8f61; --dist: 65px; }
  .confetti-dot:nth-child(5)  { background: #e15b37; --dist: 55px; }
  .confetti-dot:nth-child(6)  { background: #9b59b6; --dist: 50px; }
  .confetti-dot:nth-child(7)  { background: #f4c84c; --dist: 60px; }
  .confetti-dot:nth-child(8)  { background: #4c75f4; --dist: 45px; }
  .confetti-dot:nth-child(9)  { background: #1f8f61; --dist: 65px; }
  .confetti-dot:nth-child(10) { background: #e15b37; --dist: 55px; }
  .confetti-dot:nth-child(11) { background: #9b59b6; --dist: 48px; }
  .confetti-dot:nth-child(12) { background: #f4c84c; --dist: 58px; }

  .confetti-dot:nth-child(2n)   { animation-delay: 40ms; }
  .confetti-dot:nth-child(3n)   { animation-delay: 80ms; width: 5px; height: 5px; }
  .confetti-dot:nth-child(4n+1) { animation-delay: 20ms; width: 7px; height: 7px; }

  @keyframes confetti-fly {
    0% {
      transform: translate(0, 0) scale(1) rotate(0deg);
      opacity: 1;
    }
    100% {
      transform:
        translate(
          calc(cos(var(--angle)) * var(--dist)),
          calc(sin(var(--angle)) * var(--dist) - 20px)
        )
        scale(0)
        rotate(180deg);
      opacity: 0;
    }
  }

  /* Fallback for browsers without CSS cos/sin — use fixed positions */
  @supports not (transform: translate(calc(cos(0deg) * 1px), 0)) {
    .confetti-dot:nth-child(1)  { --tx:  50px; --ty: -25px; }
    .confetti-dot:nth-child(2)  { --tx:  35px; --ty: -50px; }
    .confetti-dot:nth-child(3)  { --tx:   0px; --ty: -55px; }
    .confetti-dot:nth-child(4)  { --tx: -40px; --ty: -45px; }
    .confetti-dot:nth-child(5)  { --tx: -55px; --ty: -15px; }
    .confetti-dot:nth-child(6)  { --tx: -45px; --ty:  20px; }
    .confetti-dot:nth-child(7)  { --tx: -15px; --ty:  40px; }
    .confetti-dot:nth-child(8)  { --tx:  25px; --ty:  35px; }
    .confetti-dot:nth-child(9)  { --tx:  55px; --ty:  10px; }
    .confetti-dot:nth-child(10) { --tx:  45px; --ty: -40px; }
    .confetti-dot:nth-child(11) { --tx: -20px; --ty: -58px; }
    .confetti-dot:nth-child(12) { --tx:  10px; --ty:  45px; }

    @keyframes confetti-fly {
      0% {
        transform: translate(0, 0) scale(1) rotate(0deg);
        opacity: 1;
      }
      100% {
        transform: translate(var(--tx, 40px), var(--ty, -30px)) scale(0) rotate(180deg);
        opacity: 0;
      }
    }
  }

  /* Settings drawer — minimal, not card-like */
  .settings-drawer {
    border: none;
    background: none;
  }

  .settings-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--muted, #8a95a5);
    cursor: pointer;
    user-select: none;
    list-style: none;
    transition: color 140ms ease;
  }

  .settings-toggle::-webkit-details-marker {
    display: none;
  }

  .settings-toggle:hover,
  .settings-drawer[open] > .settings-toggle {
    color: var(--ink, #182230);
  }

  .settings-toggle svg {
    transition: transform 300ms ease;
  }

  .settings-drawer[open] > .settings-toggle svg {
    transform: rotate(90deg);
  }

  .settings-body {
    margin-top: 0.35rem;
    padding: 0.55rem 0.1rem 0.1rem;
    display: grid;
    gap: 0.75rem;
    border-top: 1px solid var(--line);
  }

  /* Constraints */
  .constraint-member {
    display: grid;
    gap: 0.4rem;
  }

  .constraint-member-name {
    font-weight: 700;
    font-size: 0.82rem;
    color: var(--accent, #e15b37);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .tuning-group {
    display: grid;
    gap: 0.25rem;
  }

  .tuning-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--muted, #8a95a5);
  }

  /* Min songs per constraint */
  .min-songs-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0;
  }

  .min-songs-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--muted, #8a95a5);
    white-space: nowrap;
  }

  /* Quick Settings */
  .quick-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.65rem;
  }

  .variety-field {
    display: grid;
    gap: 0.3rem;
  }

  .variety-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .variety-label {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--muted, #8a95a5);
  }

  .variety-hint {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--accent, #e15b37);
  }

  .variety-slider {
    width: 100%;
    height: 6px;
    -webkit-appearance: none;
    appearance: none;
    border-radius: 3px;
    background: var(--line);
    outline: none;
    cursor: pointer;
  }

  .variety-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--accent, #e15b37);
    border: 2px solid var(--paper-strong);
    box-shadow: var(--shadow-sm);
    cursor: pointer;
  }

  .variety-slider::-moz-range-thumb {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--accent, #e15b37);
    border: 2px solid var(--paper-strong);
    box-shadow: var(--shadow-sm);
    cursor: pointer;
  }

  .variety-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--muted, #8a95a5);
  }

  .field-hint {
    font-weight: 500;
    color: var(--muted, #8a95a5);
    font-size: 0.72rem;
  }

  .adv-field {
    display: grid;
    gap: 0.25rem;
  }

  .adv-field span {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--muted, #8a95a5);
  }

  .adv-field input {
    min-height: 2.2rem;
    padding: 0 0.5rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-md, 12px);
    background: var(--surface);
    /* iOS zooms inputs <16px on focus — keep at 16px to prevent zoom. */
    font-size: 16px;
    font-weight: 600;
    -moz-appearance: textfield;
  }

  .adv-field input[type="number"]:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .no-limit-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
  }

  .no-limit-toggle input[type="checkbox"] {
    min-height: auto;
    width: auto;
    margin: 0;
    cursor: pointer;
  }

  .no-limit-toggle span {
    font-size: 0.7rem;
    font-weight: 600;
  }

  .adv-field input::-webkit-inner-spin-button,
  .adv-field input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  /* Result */
  .result-section {
    display: grid;
    gap: 0.65rem;
    animation: pop-in 250ms ease;
  }

  @keyframes pop-in {
    0% { transform: scale(0.92); opacity: 0; }
    70% { transform: scale(1.02); }
    100% { transform: scale(1); opacity: 1; }
  }

  /* Settings tabs */
  .settings-tabs {
    display: flex;
    gap: 0;
    border-radius: var(--radius-md, 12px);
    overflow: hidden;
    border: 1px solid var(--line);
  }

  .settings-tab {
    flex: 1;
    padding: 0.45rem 0.5rem;
    border: none;
    background: var(--hover);
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--muted, #8a95a5);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition: background 120ms ease, color 120ms ease;
  }

  .settings-tab + .settings-tab {
    border-left: 1px solid var(--line);
  }

  .settings-tab.active {
    background: var(--accent, #e15b37);
    color: var(--on-accent);
  }

  /* Bass Player Anxiety score */
  .roadie-score {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.35rem;
    padding: 0.5rem 0.65rem;
    border-radius: var(--radius-md, 12px);
    background: var(--hover);
    border: 1px solid var(--line);
  }

  .roadie-label {
    font-size: 0.90rem;
    font-weight: 700;
    color: var(--muted, #575d67);
  }

  .roadie-val {
    font-size: 0.90rem;
    font-weight: 800;
    color: var(--ink, #182230);
  }

  .roadie-hint {
    flex-basis: 100%;
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.35;
    color: var(--muted, #575d67);
  }

  .song-list {
    display: grid;
    gap: 0.4rem;
  }

  .song-list-item {
    transition: transform 150ms ease;
  }

  .drag-over {
    outline: 2px solid var(--accent, #e15b37);
    outline-offset: -1px;
    border-radius: var(--radius-md, 12px);
  }

  .setlist-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .save-set-btn {
    flex: 1;
    min-height: 2.6rem;
    border: 2px solid var(--accent, #e15b37);
    border-radius: var(--radius-md, 12px);
    background: transparent;
    color: var(--accent, #e15b37);
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition: background 140ms ease;
  }

  .save-set-btn:hover,
  .save-set-btn:active {
    background: var(--accent-soft);
  }

  .save-set-btn.secondary {
    flex: 1;
    border-color: var(--line-strong);
    background: var(--hover);
    color: var(--ink);
    font-weight: 700;
    font-size: 0.85rem;
  }

  .save-set-btn.secondary:hover,
  .save-set-btn.secondary:active {
    background: var(--line);
  }

  .save-set-btn.secondary:active {
    transform: scale(0.96);
  }

  .saved-badge {
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--success);
    white-space: nowrap;
    padding: 0.4rem 0.75rem;
    border: 1.5px solid color-mix(in srgb, var(--success) 25%, transparent);
    border-radius: var(--radius-md, 12px);
    background: color-mix(in srgb, var(--success) 8%, transparent);
  }

  .locked-badge {
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--success);
    white-space: nowrap;
    padding: 0.4rem 0.75rem;
    border: 1.5px solid color-mix(in srgb, var(--success) 25%, transparent);
    border-radius: var(--radius-md, 12px);
    background: color-mix(in srgb, var(--success) 8%, transparent);
  }

  /* Confirm dialog */
  .confirm-overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    backdrop-filter: blur(4px);
    display: grid;
    place-items: center;
    z-index: 60;
    padding: 1rem;
    animation: fade-in 150ms ease;
  }

  .confirm-dialog {
    width: min(100%, 320px);
    padding: 1.5rem;
    background: var(--paper-strong, #fff);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl, 16px);
    box-shadow: var(--shadow);
    display: grid;
    gap: 0.75rem;
    animation: pop-in 200ms ease;
  }

  .confirm-title {
    font-size: 1rem;
    font-weight: 700;
    color: var(--ink);
    margin: 0;
  }

  .confirm-desc {
    font-size: 0.88rem;
    color: var(--muted);
    margin: 0;
  }

  .confirm-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .confirm-btn {
    flex: 1;
    min-height: 2.4rem;
    border: none;
    border-radius: var(--radius-md, 12px);
    font-size: 0.88rem;
    font-weight: 700;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .confirm-btn.cancel {
    background: var(--line);
    color: var(--ink);
  }

  .confirm-btn.proceed {
    background: var(--accent, #e15b37);
    color: var(--on-accent);
  }

  .confirm-btn.optimize {
    background: var(--ink, #182230);
    color: var(--on-ink);
  }

  .confirm-actions-stacked {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.25rem;
  }

  .add-song-btn {
    background: var(--line, rgba(27, 49, 80, 0.08));
    color: var(--ink, #182230);
    border: 1px dashed var(--line-strong);
  }

  .add-song-dialog {
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .add-song-search {
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
    border-radius: var(--radius-md, 12px);
    /* iOS zooms inputs <16px on focus — keep at 16px to prevent zoom. */
    font-size: 16px;
    outline: none;
    box-sizing: border-box;
  }

  .add-song-search:focus {
    border-color: var(--accent, #e15b37);
  }

  .add-song-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    overflow-y: auto;
    max-height: 40vh;
  }

  .add-song-item {
    text-align: left;
    padding: 0.55rem 0.75rem;
    border: 1px solid var(--line, rgba(27, 49, 80, 0.08));
    border-radius: var(--radius-md, 12px);
    background: var(--surface);
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--ink, #182230);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .add-song-item:active:not(:disabled) {
    background: var(--accent-soft);
  }

  .add-song-item.in-setlist {
    opacity: 0.45;
    cursor: default;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .in-setlist-tag {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--muted, #8a95a5);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .add-song-empty {
    font-size: 0.85rem;
    color: var(--muted, #8a95a5);
    text-align: center;
    padding: 1rem;
    margin: 0;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* ---- Onboarding card ---- */
  .onboarding-card {
    border: 1px solid var(--line);
    border-radius: var(--radius-lg, 16px);
    background: var(--paper);
    padding: 1.25rem 1rem;
    display: grid;
    gap: 0.65rem;
    text-align: center;
    animation: pop-in 300ms ease;
  }

  .onboarding-illustration {
    font-size: 2.2rem;
    line-height: 1;
    letter-spacing: 0.1em;
  }

  .onboarding-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 800;
    color: var(--ink, #182230);
  }

  .onboarding-desc {
    margin: 0;
    font-size: 0.85rem;
    color: var(--muted, #8a95a5);
    line-height: 1.4;
  }

  .onboarding-steps {
    list-style: none;
    padding: 0;
    margin: 0.25rem 0 0;
    display: grid;
    gap: 0.6rem;
    text-align: left;
  }

  .onboarding-steps li {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius-md, 12px);
    background: var(--hover);
    border: 1px solid var(--line);
  }

  .onboarding-steps li.done {
    background: rgba(31, 143, 97, 0.06);
    border-color: rgba(31, 143, 97, 0.15);
  }

  .step-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--accent, #e15b37);
    color: var(--on-accent);
    font-size: 0.75rem;
    font-weight: 800;
  }

  .onboarding-steps li.done .step-icon {
    background: var(--success);
  }

  .step-text {
    display: grid;
    gap: 0.15rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--ink, #182230);
    padding-top: 0.15rem;
  }

  .step-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-weight: 700;
    color: var(--accent, #e15b37);
    cursor: pointer;
    text-align: left;
    text-decoration: underline;
    text-decoration-thickness: 1.5px;
    text-underline-offset: 2px;
  }

  .step-link:hover {
    color: var(--accent-strong);
  }

  .step-hint {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--muted, #8a95a5);
  }

  .onboarding-tip {
    margin: 0;
    font-size: 0.8rem;
    color: var(--muted, #8a95a5);
    line-height: 1.4;
    padding: 0.5rem 0.7rem;
    background: var(--hover);
    border-radius: var(--radius-md, 12px);
    border-left: 3px solid var(--accent, #e15b37);
  }

  .onboarding-footer {
    margin: 0;
    font-size: 0.82rem;
    color: var(--muted, #8a95a5);
    line-height: 1.4;
  }

  .help-toggle {
    background: none;
    border: none;
    padding: 0.25rem 0;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--accent, #e15b37);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }

  .help-toggle:hover {
    color: var(--accent-strong);
  }

  /* ---- Sync-in-progress skeleton ---- */
  .sync-skeleton {
    display: grid;
    gap: 12px;
    padding: 24px 16px;
    max-width: 560px;
    margin: 16px auto 0;
  }

  .skeleton-headline,
  .skeleton-card {
    background: linear-gradient(
      90deg,
      var(--line) 0%,
      color-mix(in srgb, var(--line) 60%, var(--paper-strong)) 50%,
      var(--line) 100%
    );
    background-size: 200% 100%;
    border-radius: var(--radius-md);
    animation: skeleton-shimmer 1.4s ease-in-out infinite;
  }

  .skeleton-headline {
    height: 18px;
    width: 60%;
    margin-bottom: 4px;
  }

  .skeleton-card {
    height: 72px;
  }

  .sync-skeleton-note {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
    text-align: center;
  }

  @keyframes skeleton-shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-headline,
    .skeleton-card { animation: none; }
  }

  /* ---- Idle nudge (ready but nothing rolled) ---- */
  .idle-nudge {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-8) 0 var(--space-6);
    text-align: center;
  }

  .idle-die-face {
    position: relative;
    width: 100px;
    height: 100px;
    border-radius: 18px;
    background: rgba(var(--pip-rgb), 0.06);
    border: 2px solid rgba(var(--pip-rgb), 0.10);
    animation: idle-float 3s ease-in-out infinite;
  }

  .idle-pip {
    position: absolute;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: rgba(var(--pip-rgb), 0.15);
    transform: translate(-50%, -50%);
  }

  .idle-tagline {
    color: var(--muted);
    font-size: 1rem;
    font-weight: 600;
    font-style: italic;
    max-width: 280px;
    line-height: 1.5;
  }

  @keyframes idle-float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-8px); }
  }


</style>
