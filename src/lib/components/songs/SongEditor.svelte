<script>
    import { getContext } from "svelte";
    import { memberDefaultRig } from "../../defaults.js";
    import { ALL_KEYS, MAJOR_KEYS, MINOR_KEYS } from "../../keys.js";
    import ChipToggle from "../shared/ChipToggle.svelte";
    import Icon from "../shared/Icon.svelte";
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
        return [inst.name, ...(inst.tuning || []), ...(inst.picking || [])].join(", ");
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

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="editor-backdrop" onclick={handleBack}></div>
<div class="editor-overlay">
    <header class="editor-header">
        <button type="button" class="icon-btn back-btn" onclick={handleBack} aria-label="Back">
            <Icon name="chevron-left" size={24} stroke={2.2} />
        </button>
        <span class="editor-title">{store.editorSong.name || "New Song"}</span>
        <button
            type="button"
            class="btn btn-primary save-btn"
            class:dirty={isDirty}
            onclick={handleSave}
            disabled={!store.editorSong.name?.trim()}
        >Save</button>
    </header>

    <div class="editor-body">
        <!-- Section 1: Basics -->
        <section class="card section-card">
            <h3 class="section-title section-heading">Basics</h3>

            <label class="field">
                <span class="field-label">Song name</span>
                <input
                    class="input field-input"
                    bind:this={nameInput}
                    value={store.editorSong.name}
                    placeholder="Song title"
                    oninput={(e) => store.updateSongField("name", e.currentTarget.value)}
                />
            </label>

            <label class="field">
                <span class="field-label">Key</span>
                <select
                    class="input field-input"
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
                    class="input field-input notes-input"
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
        </section>

        <!-- Section 2: how the roller should treat this song -->
        <section class="card section-card">
            <h3 class="section-title section-heading">In the set</h3>

            <div class="song-programming-grid">
                <label class="field">
                    <span class="field-label">Play priority</span>
                    <select
                        class="input field-input"
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
                        class="input field-input"
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
                        class="input field-input"
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

            <div class="toggle-row">
                <ChipToggle
                    checked={store.editorSong.notGoodOpener}
                    onchange={(e) => store.updateSongField("notGoodOpener", e.currentTarget.checked)}
                >Not a good opener</ChipToggle>
                <ChipToggle
                    checked={store.editorSong.notGoodCloser}
                    onchange={(e) => store.updateSongField("notGoodCloser", e.currentTarget.checked)}
                >Not a good closer</ChipToggle>
                <ChipToggle
                    checked={store.editorSong.unpracticed}
                    onchange={(e) => store.updateSongField("unpracticed", e.currentTarget.checked)}
                >Unpracticed</ChipToggle>
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
                            ><Icon name="x" size={14} stroke={2.4} /></button>
                        </span>
                    {/each}
                    <button
                        type="button"
                        class="btn btn-sm keep-apart-add"
                        onclick={() => { showKeepApartPicker = true; }}
                    >+ Add song</button>
                </div>
                <span class="field-hint">These songs will never be placed next to this one.</span>
            </div>
        </section>

        <!-- Section 3: Members -->
        <section class="card section-card">
            <h3 class="section-title section-heading">Members</h3>
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
                            <button type="button" class="btn btn-sm override-btn" onclick={() => addOverride(memberName)}>
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
                                                            class="input field-input"
                                                            placeholder="Name the new instrument"
                                                            value={namingInstrument[rowKey(memberName, index)] || ""}
                                                            oninput={(e) => { namingInstrument = { ...namingInstrument, [rowKey(memberName, index)]: e.currentTarget.value }; }}
                                                            onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitNewInstrument(memberName, index); } }}
                                                        />
                                                        <button type="button" class="btn btn-ink add-sm-btn" onclick={() => commitNewInstrument(memberName, index)}>Add</button>
                                                        <button type="button" class="btn btn-ghost cancel-sm-btn" onclick={() => cancelNewInstrument(memberName, index)}>Cancel</button>
                                                    </div>
                                                {:else}
                                                    <select
                                                        class="input field-input"
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
                                                    class="btn btn-danger-ghost remove-setup-btn"
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
                                                        class="input field-input small"
                                                        type="text"
                                                        placeholder="Add tuning..."
                                                        value={tuningDrafts[rowKey(memberName, index)] || ""}
                                                        oninput={(e) => { tuningDrafts = { ...tuningDrafts, [rowKey(memberName, index)]: e.currentTarget.value }; }}
                                                        onkeydown={(e) => { if (e.key === "Enter") addTuning(memberName, option, index); }}
                                                    />
                                                    <button type="button" class="btn btn-ink add-sm-btn" onclick={() => addTuning(memberName, option, index)}>Add</button>
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
                                                        class="input field-input small"
                                                        type="text"
                                                        placeholder="Add technique..."
                                                        value={techniqueDrafts[rowKey(memberName, index)] || ""}
                                                        oninput={(e) => { techniqueDrafts = { ...techniqueDrafts, [rowKey(memberName, index)]: e.currentTarget.value }; }}
                                                        onkeydown={(e) => { if (e.key === "Enter") addTechnique(memberName, option, index); }}
                                                    />
                                                    <button type="button" class="btn btn-ink add-sm-btn" onclick={() => addTechnique(memberName, option, index)}>Add</button>
                                                </div>
                                            </div>
                                        {/if}
                                    </div>
                                {/each}

                                <button type="button"
                                    class="btn secondary-btn"
                                    onclick={() => store.addInstrumentOption(memberName)}
                                >+ Add another setup option</button>

                                {#if isBandMember(memberName)}
                                    <button type="button"
                                        class="btn btn-ghost reset-override-btn"
                                        onclick={() => resetOverride(memberName)}
                                    >Reset to usual setup</button>
                                {:else}
                                    <p class="members-hint">Not in the band config — this setup lives only on this song.</p>
                                    <button type="button"
                                        class="btn btn-danger-ghost danger-text-btn"
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
            <button type="button" class="btn btn-block secondary-btn" onclick={() => store.duplicateSong(store.editorSong)}>Duplicate song</button>

            {#if !isNewSong}
                <button type="button" class="btn btn-block btn-danger-ghost danger-text-btn" onclick={handleDelete}>Delete song</button>
            {/if}
        </div>
    </div>
</div>

{#if showKeepApartPicker}
    <div class="picker-overlay dialog-backdrop" onclick={() => { showKeepApartPicker = false; keepApartSearch = ""; }}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="picker-dialog dialog" onclick={(e) => e.stopPropagation()}>
            <p class="picker-title dialog-title">Keep apart from…</p>
            <input
                class="picker-search input"
                type="text"
                placeholder="Search songs..."
                bind:value={keepApartSearch}
            />
            <div class="picker-list pick-list">
                {#each keepApartCandidates as song (song.id)}
                    <button type="button" class="picker-item pick-item" onclick={() => addKeepApart(song.id)}>
                        {song.name}
                    </button>
                {:else}
                    <p class="picker-empty pick-empty">No other songs to choose from</p>
                {/each}
            </div>
            <button
                type="button"
                class="btn btn-ghost picker-cancel"
                onclick={() => { showKeepApartPicker = false; keepApartSearch = ""; }}
            >Cancel</button>
        </div>
    </div>
{/if}

<style>
    /* Phone: the editor takes over the whole screen. Desktop: it slides in
       as a right-hand panel so the song list stays visible behind it. */
    .editor-backdrop {
        display: none;
    }

    .editor-overlay {
        position: fixed;
        inset: 0;
        z-index: 300;
        background: var(--bg);
        display: grid;
        grid-template-rows: auto 1fr;
        overflow: hidden;
    }

    @media (min-width: 900px) {
        .editor-backdrop {
            display: block;
            position: fixed;
            inset: 0;
            z-index: 299;
            background: var(--overlay);
            animation: ui-fade-in 160ms ease;
        }

        .editor-overlay {
            left: auto;
            width: min(600px, 100%);
            border-left: 1px solid var(--line);
            box-shadow: var(--shadow);
            animation: panel-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }
    }

    @keyframes panel-in {
        from { transform: translateX(32px); opacity: 0; }
        to { transform: none; opacity: 1; }
    }

    .editor-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem 0.5rem 0.35rem;
        padding-top: calc(env(safe-area-inset-top, 0px) + 0.5rem);
        background: var(--surface);
        border-bottom: 1px solid var(--line);
        min-height: 60px;
        flex-shrink: 0;
        /* The overlay uses display:grid with no explicit column template, so
           grid items default to min-width:auto (= max-content of their flex
           children).  A very long song title would expand this grid item past
           the viewport, pushing the Save button off-screen.  Setting
           min-width:0 lets the grid item shrink to the grid container's width
           so the flex layout can do its job and the title truncates properly. */
        min-width: 0;
    }

    .editor-title {
        flex: 1;
        min-width: 0;
        font-family: var(--font-display);
        font-weight: 700;
        font-size: 1.15rem;
        letter-spacing: -0.015em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* Save is quiet until there is something to save. */
    .save-btn {
        min-width: 76px;
        flex-shrink: 0;
        opacity: 0.55;
    }

    .save-btn.dirty {
        opacity: 1;
    }

    .save-btn:disabled {
        opacity: 0.35;
    }

    .editor-body {
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        padding: var(--space-4);
        display: grid;
        align-content: start;
        gap: var(--space-4);
        max-width: 640px;
        margin: 0 auto;
        width: 100%;
        box-sizing: border-box;
        padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 3rem);
    }

    @media (min-width: 900px) {
        .editor-body {
            padding: var(--space-5) var(--space-6) 3rem;
        }
    }

    .section-card {
        display: grid;
        gap: var(--space-4);
        padding: var(--space-4);
    }

    .members-hint {
        margin: -0.5rem 0 0;
        font-size: 0.9rem;
        color: var(--muted);
        line-height: 1.45;
    }

    .member-body .members-hint {
        margin: 0;
    }

    .field-label-soft {
        font-weight: 400;
        color: var(--muted);
    }

    .notes-input {
        min-height: 6.5rem;
        font-family: inherit;
    }

    .flex-1 {
        flex: 1 1 0;
    }

    .toggle-row,
    .chip-row {
        display: flex;
        gap: 0.4rem;
        flex-wrap: wrap;
    }

    .song-programming-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--space-3);
    }

    @media (max-width: 520px) {
        .song-programming-grid {
            grid-template-columns: 1fr;
        }
    }

    /* Keep apart */
    .keep-apart-row {
        align-items: center;
    }

    .keep-apart-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.15rem;
        min-height: 36px;
        padding: 0 0.25rem 0 0.8rem;
        border-radius: var(--radius-full);
        background: var(--accent-soft);
        border: 1px solid var(--accent-line);
        color: var(--accent-text);
        font-size: 0.9rem;
        font-weight: 600;
    }

    .keep-apart-remove {
        display: inline-grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        touch-action: manipulation;
    }

    .keep-apart-remove:hover {
        background: var(--hover-strong);
    }

    .keep-apart-add {
        border-style: dashed;
        border-radius: var(--radius-full);
    }

    .picker-overlay {
        z-index: 600;
    }

    .picker-dialog {
        max-width: 480px;
        height: min(640px, 100%);
    }

    .picker-list {
        flex: 1;
    }

    /* Usual-setup rows (members with no song override) */
    .member-default-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.65rem 0.75rem 0.65rem 1rem;
        border-radius: var(--radius-md);
        border: 1px solid var(--line);
        background: var(--surface-2);
    }

    .member-default-info {
        flex: 1;
        min-width: 0;
        display: grid;
        gap: 0.05rem;
    }

    .member-default-summary {
        font-size: 0.88rem;
        color: var(--muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .override-btn {
        flex-shrink: 0;
    }

    /* Member override cards */
    .member-card {
        border-radius: var(--radius-md);
        border: 1px solid var(--accent-line);
        background: var(--surface);
        overflow: hidden;
    }

    .member-header {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        width: 100%;
        padding: 0.75rem 1rem;
        border: none;
        background: var(--accent-soft);
        cursor: pointer;
        touch-action: manipulation;
        font: inherit;
        color: inherit;
        text-align: left;
        min-height: 52px;
    }

    .member-header:focus-visible {
        outline-offset: -2px;
    }

    .member-name {
        font-weight: 600;
        font-size: 1rem;
    }

    .member-instrument-summary {
        flex: 1;
        font-size: 0.88rem;
        color: var(--muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .member-header.has-issue {
        background: var(--warning-soft);
    }

    .member-issue {
        flex: 1;
        font-size: 0.88rem;
        font-weight: 600;
        color: var(--warning);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .chevron {
        flex-shrink: 0;
        color: var(--muted);
        transition: transform 200ms ease;
    }

    .chevron.open {
        transform: rotate(180deg);
    }

    .member-body {
        display: grid;
        gap: var(--space-3);
        padding: var(--space-4);
    }

    .instrument-card {
        display: grid;
        gap: var(--space-4);
    }

    .instrument-card + .instrument-card {
        padding-top: var(--space-4);
        border-top: 1px solid var(--line);
    }

    .instrument-top {
        display: flex;
        gap: 0.5rem;
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
        gap: 0.45rem;
    }

    .inline-add {
        display: flex;
        gap: 0.4rem;
        align-items: center;
    }

    .inline-add .input {
        flex: 1;
        min-width: 0;
    }

    .add-sm-btn,
    .cancel-sm-btn,
    .remove-setup-btn {
        flex-shrink: 0;
    }

    .bottom-actions {
        display: grid;
        gap: var(--space-2);
    }
</style>
