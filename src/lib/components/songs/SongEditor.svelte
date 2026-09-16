<script>
    import { getContext } from "svelte";
    import { memberDefaultRig } from "../../defaults.js";
    import { ALL_KEYS, MAJOR_KEYS, MINOR_KEYS } from "../../keys.js";
    import ChipToggle from "../shared/ChipToggle.svelte";
    import NumberStepper from "../shared/NumberStepper.svelte";

    const store = getContext("app");
    let isNonCanonicalKey = $derived(store.editorSong?.key && !ALL_KEYS.includes(store.editorSong.key));

    // The component mounts fresh for every editor open ({#if store.editorSong}),
    // so this captures the pristine draft for dirty-tracking.
    const initialSnapshot = JSON.stringify(store.editorSong);
    const isNewSong = !store.selectedSongId;
    let isDirty = $derived(
        JSON.stringify(store.editorSong) !== initialSnapshot || Object.keys(store.editorVocabAdds).length > 0,
    );

    let expandedMember = $state("");
    // Per-instrument-row "New instrument" naming state, keyed member::index.
    let namingInstrument = $state({});
    // Local drafts for the tuning/technique quick-add inputs (staged into
    // the store's editorVocabAdds on Add — never persisted until Save).
    let tuningDrafts = $state({});
    let techniqueDrafts = $state({});

    // "Keep apart from" picker state.
    let showKeepApartPicker = $state(false);
    let keepApartSearch = $state("");
    let keepApartSongs = $derived.by(() => {
        const ids = store.editorSong?.keepApartFrom || [];
        const byId = new Map((store.songs || []).map((s) => [s.id, s]));
        return ids.map((id) => byId.get(id)).filter(Boolean);
    });
    let keepApartCandidates = $derived.by(() => {
        const selfId = store.editorSong?.id;
        const chosen = new Set(store.editorSong?.keepApartFrom || []);
        const q = keepApartSearch.trim().toLowerCase();
        return (store.songs || []).filter(
            (s) => s.id !== selfId && !chosen.has(s.id) && (!q || s.name.toLowerCase().includes(q)),
        );
    });

    function addKeepApart(id) {
        const current = store.editorSong?.keepApartFrom || [];
        if (!current.includes(id)) store.updateSongField("keepApartFrom", [...current, id]);
        showKeepApartPicker = false;
        keepApartSearch = "";
    }

    function removeKeepApart(id) {
        const current = store.editorSong?.keepApartFrom || [];
        store.updateSongField("keepApartFrom", current.filter((x) => x !== id));
    }

    let nameInput = $state();
    $effect(() => {
        if (isNewSong && nameInput) nameInput.focus();
    });

    function rowKey(memberName, index) {
        return `${memberName}::${index}`;
    }

    async function handleBack() {
        if (isDirty) {
            const confirmed = await store.requestConfirm({
                title: "Discard changes?",
                message: "Your edits to this song will be lost.",
                confirmLabel: "Discard",
                cancelLabel: "Keep editing",
            });
            if (!confirmed) return;
        }
        store.closeEditor();
    }

    // ---- members: usual-setup vs override ----

    function overrideFor(memberName) {
        return store.editorSong.members?.[memberName];
    }

    function usualSetupSummary(memberName) {
        const rig = memberDefaultRig(store.bandMembers?.[memberName]);
        if (!rig) return "";
        const inst = rig.instruments[0];
        return [inst.name, ...(inst.tuning || []), ...(inst.picking || [])].join(" · ");
    }

    function addOverride(memberName) {
        store.addMember(memberName);
        expandedMember = memberName;
    }

    function resetOverride(memberName) {
        store.removeMember(memberName);
        if (expandedMember === memberName) expandedMember = "";
    }

    function toggleMember(name) {
        expandedMember = expandedMember === name ? "" : name;
    }

    /** Band members plus any song-only (legacy) members, band order first. */
    function allMemberNames() {
        const bandNames = (store.bandMemberEntries || []).map(([name]) => name);
        const songOnly = Object.keys(store.editorSong.members || {}).filter((n) => !bandNames.includes(n));
        return [...bandNames, ...songOnly];
    }

    function isBandMember(name) {
        return !!store.bandMembers?.[name];
    }

    // ---- instrument choices ----

    function knownInstruments(memberName) {
        const fromBand = (store.bandMembers?.[memberName]?.instruments || []).map((i) => i.name);
        const staged = store.stagedInstrumentAdds(memberName);
        return Array.from(new Set([...fromBand, ...staged].filter(Boolean)));
    }

    function selectInstrument(memberName, index, value) {
        if (value === "__new__") {
            namingInstrument = { ...namingInstrument, [rowKey(memberName, index)]: "" };
            return;
        }
        store.updateInstrumentOption(memberName, index, "name", value);
    }

    function commitNewInstrument(memberName, index) {
        const key = rowKey(memberName, index);
        const clean = (namingInstrument[key] || "").trim();
        if (clean) {
            store.stageVocabAdd(memberName, clean, "instrument", clean);
            store.updateInstrumentOption(memberName, index, "name", clean);
        }
        const { [key]: _, ...rest } = namingInstrument;
        namingInstrument = rest;
    }

    function cancelNewInstrument(memberName, index) {
        const { [rowKey(memberName, index)]: _, ...rest } = namingInstrument;
        namingInstrument = rest;
    }

    // ---- tunings ----

    function availableTunings(memberName, option) {
        const instrumentName = option?.name || "";
        const fromBand =
            (store.bandMembers?.[memberName]?.instruments || []).find((i) => i.name === instrumentName)?.tunings || [];
        const staged = store.stagedTuningAdds(memberName, instrumentName);
        return Array.from(new Set([...fromBand, ...staged, ...(option?.tuning || [])].filter(Boolean)));
    }

    function toggleTuning(memberName, index, tuning) {
        const current = store.editorSong.members[memberName].instruments[index].tuning || [];
        const next = current.includes(tuning) ? current.filter((t) => t !== tuning) : current.concat(tuning);
        store.updateInstrumentOption(memberName, index, "tuning", next);
    }

    function addTuning(memberName, option, index) {
        const key = rowKey(memberName, index);
        const staged = store.stageVocabAdd(memberName, option.name, "tuning", tuningDrafts[key] || "");
        if (staged) {
            const current = store.editorSong.members[memberName].instruments[index].tuning || [];
            if (!current.includes(staged)) {
                store.updateInstrumentOption(memberName, index, "tuning", current.concat(staged));
            }
            tuningDrafts = { ...tuningDrafts, [key]: "" };
        }
    }

    // ---- techniques ----

    function availableTechniques(memberName, option) {
        const instrumentName = option?.name || "";
        const fromBand =
            (store.bandMembers?.[memberName]?.instruments || []).find((i) => i.name === instrumentName)?.techniques ||
            [];
        const staged = store.stagedTechniqueAdds(memberName, instrumentName);
        return Array.from(new Set([...fromBand, ...staged, ...(option?.picking || [])].filter(Boolean)));
    }

    function toggleTechnique(memberName, index, technique) {
        const current = store.editorSong.members[memberName].instruments[index].picking || [];
        const next = current.includes(technique) ? current.filter((t) => t !== technique) : current.concat(technique);
        store.updateInstrumentOption(memberName, index, "picking", next);
    }

    function addTechnique(memberName, option, index) {
        const key = rowKey(memberName, index);
        const staged = store.stageVocabAdd(memberName, option.name, "technique", techniqueDrafts[key] || "");
        if (staged) {
            const current = store.editorSong.members[memberName].instruments[index].picking || [];
            if (!current.includes(staged)) {
                store.updateInstrumentOption(memberName, index, "picking", current.concat(staged));
            }
            techniqueDrafts = { ...techniqueDrafts, [key]: "" };
        }
    }

    // ---- issues / actions ----

    function memberIssue(memberSetup) {
        for (const inst of memberSetup?.instruments || []) {
            if (!inst.name) return "Pick an instrument";
        }
        return null;
    }

    function overrideSummary(memberSetup) {
        return (memberSetup.instruments || [])
            .map((i) => [i.name, ...(i.tuning || [])].filter(Boolean).join(" "))
            .filter(Boolean)
            .join(", ");
    }

    function handleSave() {
        store.saveSong();
    }

    function handleDelete() {
        // store.deleteSong shows the app-wide destructive-confirm modal —
        // no inline second step needed here anymore.
        store.deleteSong(store.editorSong);
    }
</script>

<div class="editor-overlay">
    <header class="editor-header">
        <button type="button" class="back-btn" onclick={handleBack} aria-label="Back">
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
        </button>
        <span class="editor-title">{store.editorSong.name || "New Song"}</span>
        <button
            type="button"
            class="save-btn"
            class:dirty={isDirty}
            onclick={handleSave}
            disabled={!store.editorSong.name?.trim()}
        >Save</button>
    </header>

    <div class="editor-body">
        <!-- Section 1: Basics -->
        <section class="section-card">
            <h3 class="section-heading">Basics</h3>

            <label class="field">
                <span class="field-label">Song name</span>
                <input
                    class="field-input"
                    bind:this={nameInput}
                    value={store.editorSong.name}
                    placeholder="Song title"
                    oninput={(e) => store.updateSongField("name", e.currentTarget.value)}
                />
            </label>

            <label class="field">
                <span class="field-label">Key</span>
                <select
                    class="field-input"
                    value={store.editorSong.key}
                    onchange={(e) => store.updateSongField("key", e.currentTarget.value)}
                >
                    <option value="">None</option>
                    {#if isNonCanonicalKey}
                        <option value={store.editorSong.key}>{store.editorSong.key} (custom)</option>
                    {/if}
                    <optgroup label="Major">
                        {#each MAJOR_KEYS as k}
                            <option value={k}>{k}</option>
                        {/each}
                    </optgroup>
                    <optgroup label="Minor">
                        {#each MINOR_KEYS as k}
                            <option value={k}>{k}</option>
                        {/each}
                    </optgroup>
                </select>
            </label>

            <label class="field">
                <span class="field-label">Notes</span>
                <textarea
                    class="field-input notes-input"
                    value={store.editorSong.notes || ""}
                    placeholder="Anything to remember on stage..."
                    oninput={(e) => store.updateSongField("notes", e.currentTarget.value)}
                ></textarea>
            </label>

            <div class="toggle-row">
                <ChipToggle
                    checked={store.editorSong.cover}
                    onchange={(e) => store.updateSongField("cover", e.currentTarget.checked)}
                >Cover</ChipToggle>
                <ChipToggle
                    checked={store.editorSong.instrumental}
                    onchange={(e) => store.updateSongField("instrumental", e.currentTarget.checked)}
                >Instrumental</ChipToggle>
            </div>

            <div class="toggle-row">
                <ChipToggle
                    checked={store.editorSong.notGoodOpener}
                    onchange={(e) => store.updateSongField("notGoodOpener", e.currentTarget.checked)}
                >Not a good opener</ChipToggle>
                <ChipToggle
                    checked={store.editorSong.notGoodCloser}
                    onchange={(e) => store.updateSongField("notGoodCloser", e.currentTarget.checked)}
                >Not a good closer</ChipToggle>
            </div>

            <div class="field">
                <span class="field-label">Keep apart from</span>
                <div class="chip-row keep-apart-row">
                    {#each keepApartSongs as other (other.id)}
                        <span class="keep-apart-chip">
                            {other.name}
                            <button
                                type="button"
                                class="keep-apart-remove"
                                aria-label={`Stop keeping apart from ${other.name}`}
                                onclick={() => removeKeepApart(other.id)}
                            >×</button>
                        </span>
                    {/each}
                    <button
                        type="button"
                        class="keep-apart-add"
                        onclick={() => { showKeepApartPicker = true; }}
                    >+ Add song</button>
                </div>
                <span class="field-hint">These songs will never be placed next to this one.</span>
            </div>

            <div class="toggle-row">
                <ChipToggle
                    checked={store.editorSong.unpracticed}
                    onchange={(e) => store.updateSongField("unpracticed", e.currentTarget.checked)}
                >Unpracticed</ChipToggle>
            </div>

            <div class="song-programming-grid">
                <label class="field">
                    <span class="field-label">Play priority</span>
                    <select
                        class="field-input"
                        value={store.editorSong.playPriority || "normal"}
                        onchange={(e) => store.updateSongField("playPriority", e.currentTarget.value)}
                    >
                        <option value="must">Must play</option>
                        <option value="prefer">Prefer</option>
                        <option value="normal">Normal</option>
                        <option value="rest">Rest</option>
                    </select>
                </label>

                <label class="field">
                    <span class="field-label">Energy</span>
                    <select
                        class="field-input"
                        value={store.editorSong.energy || 3}
                        onchange={(e) => store.updateSongField("energy", Number(e.currentTarget.value))}
                    >
                        <option value={1}>1 · Very low</option>
                        <option value={2}>2 · Low</option>
                        <option value={3}>3 · Medium</option>
                        <option value={4}>4 · High</option>
                        <option value={5}>5 · Peak</option>
                    </select>
                </label>

                <label class="field">
                    <span class="field-label">Best position</span>
                    <select
                        class="field-input"
                        value={store.editorSong.positionPreference || "anywhere"}
                        onchange={(e) => store.updateSongField("positionPreference", e.currentTarget.value)}
                    >
                        <option value="anywhere">Anywhere</option>
                        <option value="opener">Opener</option>
                        <option value="early">Early</option>
                        <option value="middle">Middle</option>
                        <option value="late">Late</option>
                        <option value="closer">Closer</option>
                    </select>
                </label>
            </div>
        </section>

        <!-- Section 2: Members -->
        <section class="section-card">
            <h3 class="section-heading">Members</h3>
            {#if allMemberNames().length === 0}
                <p class="members-hint">
                    No band members configured. Songs only need member setups when someone
                    deviates from their usual gear — manage members on the Band screen.
                </p>
            {:else}
                <p class="members-hint">
                    Everyone plays their usual setup unless you change it for this song.
                </p>
            {/if}

            {#each allMemberNames() as memberName (memberName)}
                {@const override = overrideFor(memberName)}
                {#if !override}
                    <!-- Usual-setup row: nothing stored on the song. -->
                    <div class="member-default-row">
                        <div class="member-default-info">
                            <span class="member-name">{memberName}</span>
                            <span class="member-default-summary">
                                {usualSetupSummary(memberName) || "No instruments configured"}
                            </span>
                        </div>
                        {#if usualSetupSummary(memberName)}
                            <button type="button" class="override-btn" onclick={() => addOverride(memberName)}>
                                Change for this song
                            </button>
                        {/if}
                    </div>
                {:else}
                    {@const issue = memberIssue(override)}
                    <div class="member-card">
                        <button type="button"
                            class="member-header"
                            class:has-issue={issue}
                            onclick={() => toggleMember(memberName)}
                            aria-expanded={expandedMember === memberName}
                        >
                            <span class="member-name">{memberName}</span>
                            {#if issue}
                                <span class="member-issue">{issue}</span>
                            {:else}
                                <span class="member-instrument-summary">{overrideSummary(override)}</span>
                            {/if}
                            <svg
                                aria-hidden="true"
                                class="chevron"
                                class:open={expandedMember === memberName}
                                width="20" height="20" viewBox="0 0 24 24"
                                fill="none" stroke="currentColor" stroke-width="2.5"
                                stroke-linecap="round" stroke-linejoin="round"
                            >
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </button>

                        {#if expandedMember === memberName}
                            <div class="member-body">
                                {#each override.instruments as option, index}
                                    {@const naming = rowKey(memberName, index) in namingInstrument}
                                    <div class="instrument-card">
                                        <div class="instrument-top">
                                            <label class="field flex-1">
                                                <span class="field-label">Instrument</span>
                                                {#if naming}
                                                    <div class="inline-add">
                                                        <input
                                                            class="field-input"
                                                            placeholder="Name the new instrument"
                                                            value={namingInstrument[rowKey(memberName, index)] || ""}
                                                            oninput={(e) => { namingInstrument = { ...namingInstrument, [rowKey(memberName, index)]: e.currentTarget.value }; }}
                                                            onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitNewInstrument(memberName, index); } }}
                                                        />
                                                        <button type="button" class="add-sm-btn" onclick={() => commitNewInstrument(memberName, index)}>Add</button>
                                                        <button type="button" class="cancel-sm-btn" onclick={() => cancelNewInstrument(memberName, index)}>Cancel</button>
                                                    </div>
                                                {:else}
                                                    <select
                                                        class="field-input"
                                                        value={option.name || ""}
                                                        onchange={(e) => selectInstrument(memberName, index, e.currentTarget.value)}
                                                    >
                                                        {#if !option.name}
                                                            <option value="" disabled>Pick an instrument...</option>
                                                        {/if}
                                                        {#each knownInstruments(memberName) as instrument}
                                                            <option value={instrument}>{instrument}</option>
                                                        {/each}
                                                        {#if option.name && !knownInstruments(memberName).includes(option.name)}
                                                            <option value={option.name}>{option.name}</option>
                                                        {/if}
                                                        <option value="__new__">+ New instrument…</option>
                                                    </select>
                                                {/if}
                                            </label>

                                            {#if override.instruments.length > 1}
                                                <button type="button"
                                                    class="remove-setup-btn"
                                                    onclick={() => store.removeInstrumentOption(memberName, index)}
                                                >Remove</button>
                                            {/if}
                                        </div>

                                        {#if option.name}
                                            <div class="tuning-section">
                                                <span class="field-label">Tunings</span>
                                                {#if availableTunings(memberName, option).length > 0}
                                                    <div class="chip-row">
                                                        {#each availableTunings(memberName, option) as tuning}
                                                            <ChipToggle
                                                                checked={(option.tuning || []).includes(tuning)}
                                                                onchange={() => toggleTuning(memberName, index, tuning)}
                                                            >{tuning}</ChipToggle>
                                                        {/each}
                                                    </div>
                                                {/if}
                                                <div class="inline-add">
                                                    <input
                                                        class="field-input small"
                                                        type="text"
                                                        placeholder="Add tuning..."
                                                        value={tuningDrafts[rowKey(memberName, index)] || ""}
                                                        oninput={(e) => { tuningDrafts = { ...tuningDrafts, [rowKey(memberName, index)]: e.currentTarget.value }; }}
                                                        onkeydown={(e) => { if (e.key === "Enter") addTuning(memberName, option, index); }}
                                                    />
                                                    <button type="button" class="add-sm-btn" onclick={() => addTuning(memberName, option, index)}>Add</button>
                                                </div>
                                            </div>

                                            <div class="instrument-options-row">
                                                <div class="field">
                                                    <span class="field-label">Capo</span>
                                                    <NumberStepper
                                                        value={option.capo || 0}
                                                        min={0}
                                                        max={12}
                                                        label="Capo"
                                                        onchange={(v) => store.updateInstrumentOption(memberName, index, "capo", v)}
                                                    />
                                                </div>
                                            </div>

                                            <div class="tuning-section">
                                                <span class="field-label">Techniques <span class="field-label-soft">(optional)</span></span>
                                                {#if availableTechniques(memberName, option).length > 0}
                                                    <div class="chip-row">
                                                        {#each availableTechniques(memberName, option) as technique}
                                                            <ChipToggle
                                                                checked={(option.picking || []).includes(technique)}
                                                                onchange={() => toggleTechnique(memberName, index, technique)}
                                                            >{technique}</ChipToggle>
                                                        {/each}
                                                    </div>
                                                {/if}
                                                <div class="inline-add">
                                                    <input
                                                        class="field-input small"
                                                        type="text"
                                                        placeholder="Add technique..."
                                                        value={techniqueDrafts[rowKey(memberName, index)] || ""}
                                                        oninput={(e) => { techniqueDrafts = { ...techniqueDrafts, [rowKey(memberName, index)]: e.currentTarget.value }; }}
                                                        onkeydown={(e) => { if (e.key === "Enter") addTechnique(memberName, option, index); }}
                                                    />
                                                    <button type="button" class="add-sm-btn" onclick={() => addTechnique(memberName, option, index)}>Add</button>
                                                </div>
                                            </div>
                                        {/if}
                                    </div>
                                {/each}

                                <button type="button"
                                    class="secondary-btn"
                                    onclick={() => store.addInstrumentOption(memberName)}
                                >+ Add another setup option</button>

                                {#if isBandMember(memberName)}
                                    <button type="button"
                                        class="reset-override-btn"
                                        onclick={() => resetOverride(memberName)}
                                    >Reset to usual setup</button>
                                {:else}
                                    <p class="members-hint">Not in the band config — this setup lives only on this song.</p>
                                    <button type="button"
                                        class="danger-text-btn"
                                        onclick={() => resetOverride(memberName)}
                                    >Remove {memberName} from this song</button>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/if}
            {/each}
        </section>

        <!-- Bottom actions -->
        <div class="bottom-actions">
            <button type="button" class="secondary-btn full-width" onclick={() => store.duplicateSong(store.editorSong)}>Duplicate song</button>

            {#if !isNewSong}
                <button type="button" class="danger-text-btn full-width" onclick={handleDelete}>Delete song</button>
            {/if}
        </div>
    </div>
</div>

{#if showKeepApartPicker}
    <div class="picker-overlay" onclick={() => { showKeepApartPicker = false; keepApartSearch = ""; }}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="picker-dialog" onclick={(e) => e.stopPropagation()}>
            <p class="picker-title">Keep apart from…</p>
            <input
                class="picker-search"
                type="text"
                placeholder="Search songs..."
                bind:value={keepApartSearch}
            />
            <div class="picker-list">
                {#each keepApartCandidates as song (song.id)}
                    <button type="button" class="picker-item" onclick={() => addKeepApart(song.id)}>
                        {song.name}
                    </button>
                {:else}
                    <p class="picker-empty">No other songs to choose from</p>
                {/each}
            </div>
            <button
                type="button"
                class="picker-cancel"
                onclick={() => { showKeepApartPicker = false; keepApartSearch = ""; }}
            >Cancel</button>
        </div>
    </div>
{/if}

<style>
    .field-hint {
        font-size: 0.78rem;
        color: var(--muted, #6b7a8d);
    }

    .keep-apart-row {
        align-items: center;
    }

    .keep-apart-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        min-height: 2.4rem;
        padding: 0.3rem 0.4rem 0.3rem 0.75rem;
        border-radius: 999px;
        background: var(--accent-soft, rgba(225, 91, 55, 0.12));
        border: 1px solid var(--accent-line, rgba(225, 91, 55, 0.24));
        color: var(--accent-strong, #c64724);
        font-size: 0.85rem;
        font-weight: 600;
    }

    .keep-apart-remove {
        display: inline-grid;
        place-items: center;
        width: 1.5rem;
        height: 1.5rem;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: inherit;
        font-size: 1rem;
        line-height: 1;
        cursor: pointer;
        touch-action: manipulation;
    }

    .keep-apart-remove:active {
        background: var(--hover-strong, rgba(0, 0, 0, 0.08));
    }

    .keep-apart-add {
        min-height: 2.4rem;
        padding: 0.4rem 0.75rem;
        border-radius: 999px;
        border: 1px dashed var(--line-strong, rgba(27, 49, 80, 0.2));
        background: transparent;
        color: var(--ink, #182230);
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        touch-action: manipulation;
    }

    .keep-apart-add:active {
        background: var(--hover, rgba(0, 0, 0, 0.04));
    }

    .picker-overlay {
        position: fixed;
        inset: 0;
        background: var(--overlay);
        backdrop-filter: blur(4px);
        display: grid;
        place-items: center;
        z-index: 600;
        padding: 1rem;
    }

    .picker-dialog {
        width: min(100%, 320px);
        max-height: 70vh;
        padding: 1.5rem;
        background: var(--paper-strong, #fff);
        border: 1px solid var(--line);
        border-radius: var(--radius-xl, 16px);
        box-shadow: var(--shadow);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .picker-title {
        margin: 0;
        font-size: 1rem;
        font-weight: 700;
        color: var(--ink, #182230);
    }

    .picker-search {
        width: 100%;
        padding: 0.5rem 0.75rem;
        border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        border-radius: var(--radius-md, 12px);
        /* iOS zooms inputs <16px on focus — keep at 16px to prevent zoom. See app.css. */
        font-size: 16px;
        outline: none;
        box-sizing: border-box;
        background: var(--surface);
        color: var(--ink, #182230);
    }

    .picker-search:focus {
        border-color: var(--accent, #e15b37);
    }

    .picker-list {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        overflow-y: auto;
        max-height: 40vh;
    }

    .picker-item {
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

    .picker-item:active {
        background: var(--accent-soft);
    }

    .picker-empty {
        font-size: 0.85rem;
        color: var(--muted, #8a95a5);
        text-align: center;
        padding: 1rem;
        margin: 0;
    }

    .picker-cancel {
        min-height: 2.6rem;
        border: none;
        border-radius: var(--radius-md, 12px);
        background: transparent;
        color: var(--muted, #6b7a8d);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
    }

    .editor-overlay {
        position: fixed;
        inset: 0;
        z-index: 300;
        background: var(--bg, #f0f2f5);
        display: grid;
        grid-template-rows: auto 1fr;
        overflow: hidden;
    }

    .editor-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.6rem 0.75rem;
        padding-top: calc(env(safe-area-inset-top, 0px) + 0.6rem);
        background: var(--paper-strong);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border-bottom: 1px solid var(--line);
        min-height: 48px;
        flex-shrink: 0;
        /* The overlay uses display:grid with no explicit column template, so
           grid items default to min-width:auto (= max-content of their flex
           children).  A very long song title would expand this grid item past
           the viewport, pushing the Save button off-screen.  Setting
           min-width:0 lets the grid item shrink to the grid container's width
           so the flex layout can do its job and the title truncates properly. */
        min-width: 0;
    }

    .back-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 44px;
        min-height: 44px;
        border: none;
        border-radius: var(--radius-md, 12px);
        background: transparent;
        cursor: pointer;
        color: var(--ink, #182230);
        padding: 0;
        flex-shrink: 0;
        touch-action: manipulation;
    }

    .back-btn:active {
        background: var(--hover-strong);
    }

    .editor-title {
        flex: 1;
        min-width: 0;
        text-align: center;
        font-weight: 700;
        font-size: 1rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .save-btn {
        min-width: 64px;
        min-height: 44px;
        padding: 0.4rem 1rem;
        border-radius: 999px;
        border: none;
        background: var(--accent, #e15b37);
        color: var(--on-accent);
        font-weight: 700;
        font-size: 0.88rem;
        cursor: pointer;
        touch-action: manipulation;
        flex-shrink: 0;
        opacity: 0.6;
    }

    .save-btn.dirty {
        opacity: 1;
    }

    .save-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
    }

    .save-btn:active {
        opacity: 0.85;
    }

    .editor-body {
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        padding: 1rem;
        display: grid;
        gap: 1rem;
        max-width: 640px;
        margin: 0 auto;
        width: 100%;
        box-sizing: border-box;
        padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 4rem);
    }

    .section-card {
        display: grid;
        gap: 0.85rem;
        padding: 1rem;
        border-radius: var(--radius-lg, 16px);
        background: var(--paper);
        border: 1px solid var(--line);
    }

    .section-heading {
        font-size: 1rem;
        font-weight: 800;
        margin: 0;
    }

    .members-hint {
        margin: 0;
        font-size: 0.8rem;
        color: var(--muted, #6b7a8d);
        line-height: 1.4;
    }

    .field {
        display: grid;
        gap: 0.35rem;
    }

    .field-label {
        font-size: 0.82rem;
        font-weight: 700;
        color: var(--ink, #182230);
    }

    .field-label-soft {
        font-weight: 500;
        color: var(--muted, #6b7a8d);
    }

    .field-input {
        min-height: 2.8rem;
        padding: 0.55rem 0.75rem;
        border-radius: var(--radius-md, 12px);
        border: 1px solid var(--line);
        background: var(--surface);
        font: inherit;
        /* iOS zooms inputs <16px on focus — keep at 16px (not rem) to prevent zoom. See app.css. */
        font-size: 16px;
        box-sizing: border-box;
        width: 100%;
    }

    .notes-input {
        min-height: 4rem;
        resize: vertical;
        line-height: 1.45;
        font-family: inherit;
    }

    .flex-1 {
        flex: 1 1 0;
    }

    .toggle-row {
        display: flex;
        gap: 0.6rem;
        flex-wrap: wrap;
    }

    .song-programming-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.75rem;
    }

    @media (max-width: 620px) {
        .song-programming-grid {
            grid-template-columns: 1fr;
        }
    }

    /* Usual-setup rows (members with no song override) */
    .member-default-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.7rem 1rem;
        border-radius: var(--radius-md, 12px);
        border: 1px dashed var(--line);
        background: transparent;
    }

    .member-default-info {
        flex: 1;
        min-width: 0;
        display: grid;
        gap: 0.1rem;
    }

    .member-default-summary {
        font-size: 0.8rem;
        color: var(--muted, #6b7a8d);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .override-btn {
        flex-shrink: 0;
        min-height: 2.2rem;
        padding: 0.35rem 0.7rem;
        border-radius: var(--radius-full, 999px);
        border: 1px solid var(--accent-line);
        background: var(--accent-soft);
        color: var(--accent-strong, #c64724);
        font-size: 0.78rem;
        font-weight: 700;
        cursor: pointer;
        touch-action: manipulation;
    }

    .override-btn:active {
        background: var(--accent-line);
    }

    /* Member override cards */
    .member-card {
        border-radius: var(--radius-md, 12px);
        border: 1px solid var(--accent-line);
        background: var(--paper-soft);
        overflow: hidden;
    }

    .member-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.85rem 1rem;
        border: none;
        background: transparent;
        cursor: pointer;
        touch-action: manipulation;
        font: inherit;
        color: inherit;
        text-align: left;
        min-height: 3rem;
    }

    .member-header:active {
        background: var(--hover);
    }

    .member-name {
        font-weight: 700;
        font-size: 0.95rem;
    }

    .member-instrument-summary {
        flex: 1;
        font-size: 0.8rem;
        color: var(--muted, #6b7a8d);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .member-header.has-issue {
        background: var(--warning-soft);
    }

    .member-issue {
        flex: 1;
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .chevron {
        flex-shrink: 0;
        transition: transform 200ms ease;
    }

    .chevron.open {
        transform: rotate(180deg);
    }

    .member-body {
        display: grid;
        gap: 0.75rem;
        padding: 0 1rem 1rem;
    }

    .instrument-card {
        display: grid;
        gap: 0.65rem;
        padding: 0.85rem;
        border-radius: var(--radius-md, 12px);
        background: var(--surface);
        border: 1px solid var(--line);
    }

    .instrument-top {
        display: flex;
        gap: 0.6rem;
        align-items: flex-end;
    }

    .instrument-options-row {
        display: flex;
        gap: 1rem;
        align-items: flex-end;
        flex-wrap: wrap;
    }

    .tuning-section {
        display: grid;
        gap: 0.35rem;
    }

    .chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
    }

    .inline-add {
        display: flex;
        gap: 0.4rem;
        align-items: center;
    }

    .inline-add .field-input {
        flex: 1;
    }

    .field-input.small {
        min-height: 2.4rem;
        padding: 0.4rem 0.7rem;
        /* iOS zooms inputs <16px on focus — keep at 16px (not rem) to prevent zoom. See app.css. */
        font-size: 16px;
    }

    .add-sm-btn {
        min-height: 2.4rem;
        padding: 0.4rem 0.75rem;
        border-radius: var(--radius-md, 12px);
        border: none;
        background: var(--ink, #182230);
        color: var(--on-ink);
        font-size: 0.78rem;
        font-weight: 700;
        cursor: pointer;
        touch-action: manipulation;
        flex-shrink: 0;
    }

    .add-sm-btn:active {
        opacity: 0.85;
    }

    .cancel-sm-btn {
        min-height: 2.4rem;
        padding: 0.4rem 0.6rem;
        border: none;
        border-radius: var(--radius-md, 12px);
        background: transparent;
        color: var(--muted, #6b7a8d);
        font-size: 0.78rem;
        font-weight: 600;
        cursor: pointer;
        touch-action: manipulation;
        flex-shrink: 0;
    }

    .remove-setup-btn {
        min-height: 2.4rem;
        padding: 0.4rem 0.7rem;
        border: none;
        border-radius: var(--radius-md, 12px);
        background: transparent;
        color: var(--danger, #d33);
        font-weight: 600;
        font-size: 0.82rem;
        cursor: pointer;
        touch-action: manipulation;
        white-space: nowrap;
        align-self: flex-end;
    }

    .remove-setup-btn:active {
        background: rgba(200, 40, 40, 0.06);
    }

    .reset-override-btn {
        min-height: 2.8rem;
        padding: 0.55rem 1rem;
        border-radius: var(--radius-md, 12px);
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--ink, #182230);
        font-weight: 600;
        font-size: 0.88rem;
        cursor: pointer;
        touch-action: manipulation;
    }

    .reset-override-btn:active {
        background: var(--hover);
    }

    /* Buttons */
    .secondary-btn {
        min-height: 2.8rem;
        padding: 0.55rem 1rem;
        border-radius: var(--radius-md, 12px);
        border: 1px solid var(--line);
        background: var(--surface);
        font-weight: 600;
        font-size: 0.88rem;
        cursor: pointer;
        touch-action: manipulation;
        color: var(--ink, #182230);
    }

    .secondary-btn:active {
        background: var(--hover);
    }

    .danger-text-btn {
        min-height: 2.8rem;
        padding: 0.55rem 1rem;
        border: none;
        border-radius: var(--radius-md, 12px);
        background: transparent;
        color: var(--danger, #d33);
        font-weight: 600;
        font-size: 0.88rem;
        cursor: pointer;
        touch-action: manipulation;
    }

    .danger-text-btn:active {
        background: rgba(200, 40, 40, 0.06);
    }

    .full-width {
        width: 100%;
    }

    .bottom-actions {
        display: grid;
        gap: 0.6rem;
        padding-top: 0.5rem;
    }
</style>
