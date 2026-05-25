<script>
    import { getContext } from "svelte";
    import { ALL_KEYS, MAJOR_KEYS, MINOR_KEYS } from "../../keys.js";
    import ChipToggle from "../shared/ChipToggle.svelte";
    import NumberStepper from "../shared/NumberStepper.svelte";

    const store = getContext("app");
    let isNonCanonicalKey = $derived(store.editorSong?.key && !ALL_KEYS.includes(store.editorSong.key));

    let expandedMember = $state("");
    let confirmingDelete = $state(false);
    // Track instrument name drafts so we can show sections before committing
    let instrumentNameDrafts = $state({});

    function draftKey(memberName, index) {
        return `${memberName}::${index}`;
    }

    function getInstrumentDraft(memberName, index, currentName) {
        const key = draftKey(memberName, index);
        return key in instrumentNameDrafts ? instrumentNameDrafts[key] : currentName;
    }

    function setInstrumentDraft(memberName, index, value) {
        instrumentNameDrafts = { ...instrumentNameDrafts, [draftKey(memberName, index)]: value };
    }

    function commitInstrumentName(memberName, index) {
        const key = draftKey(memberName, index);
        const draft = (instrumentNameDrafts[key] || "").trim();
        if (draft) {
            store.updateInstrumentOption(memberName, index, "name", draft);
        }
        const { [key]: _, ...rest } = instrumentNameDrafts;
        instrumentNameDrafts = rest;
    }

    function toggleMember(name) {
        expandedMember = expandedMember === name ? "" : name;
    }

    function availableInstruments(memberName, option) {
        return Array.from(
            new Set(
                [
                    ...(store.memberInstrumentChoicesByMember?.[memberName] || []),
                    option?.name,
                ].filter(Boolean)
            )
        );
    }

    function availableTunings(memberName, option) {
        const instrumentName = option?.name || "";
        return Array.from(
            new Set([
                ...(store.memberTuningChoicesByMember?.[memberName]?.[instrumentName] || []),
                ...((option?.tuning) || []),
            ])
        );
    }

    function defaultTuning(memberName, instrumentName) {
        return store.defaultTuningByMemberInstrument?.[memberName]?.[instrumentName] || "";
    }

    function availableTechniques(memberName, option) {
        const instrumentName = option?.name || "";
        const memberConfig = store.bandMembers?.[memberName];
        const instConfig = (memberConfig?.instruments || []).find((i) => i.name === instrumentName);
        return instConfig?.techniques || [];
    }

    function toggleTuning(memberName, index, tuning) {
        const current =
            store.editorSong.members[memberName].instruments[index].tuning || [];
        const next = current.includes(tuning)
            ? current.filter((t) => t !== tuning)
            : current.concat(tuning);
        store.updateInstrumentOption(memberName, index, "tuning", next);
    }

    async function handleAddTuning(memberName, instrumentName, songInstrumentIndex) {
        const added = await store.addTuningChoice(memberName, instrumentName);
        if (added) {
            // Also select it for this song
            const current = store.editorSong.members[memberName].instruments[songInstrumentIndex].tuning || [];
            if (!current.includes(added)) {
                store.updateInstrumentOption(memberName, songInstrumentIndex, "tuning", current.concat(added));
            }
        }
    }

    function handleAddTuningKeydown(e, memberName, instrumentName, songInstrumentIndex) {
        if (e.key === "Enter") handleAddTuning(memberName, instrumentName, songInstrumentIndex);
    }

    async function handleAddTechnique(memberName, instrumentName, songInstrumentIndex) {
        const added = await store.addTechniqueChoice(memberName, instrumentName);
        if (added) {
            // Also select it for this song
            const current = (store.editorSong.members[memberName].instruments[songInstrumentIndex].picking || []).filter(t => t !== "none");
            if (!current.includes(added)) {
                store.updateInstrumentOption(memberName, songInstrumentIndex, "picking", current.concat(added));
            }
        }
    }

    function handleAddTechniqueKeydown(e, memberName, instrumentName, songInstrumentIndex) {
        if (e.key === "Enter") handleAddTechnique(memberName, instrumentName, songInstrumentIndex);
    }

    function hasDefaultTechnique(memberName, instrumentName) {
        const memberConfig = store.bandMembers?.[memberName];
        const instConfig = (memberConfig?.instruments || []).find((i) => i.name === instrumentName);
        return !!(instConfig?.defaultTechnique);
    }

    function _hasTechniques(memberName, instrumentName) {
        const memberConfig = store.bandMembers?.[memberName];
        const instConfig = (memberConfig?.instruments || []).find((i) => i.name === instrumentName);
        return (instConfig?.techniques || []).length > 0;
    }

    function hasDefaultTuning(memberName, instrumentName) {
        const memberConfig = store.bandMembers?.[memberName];
        const instConfig = (memberConfig?.instruments || []).find((i) => i.name === instrumentName);
        return !!(instConfig?.defaultTuning);
    }

    function _hasTunings(memberName, instrumentName) {
        return availableTunings(memberName, { name: instrumentName }).length > 0;
    }

    function openBandMemberEdit(memberName) {
        store.editingMemberName = memberName;
        store.bandSubView = "member-edit";
        store.navigate("band");
    }

    function bandMembersNotInSong() {
        const existing = Object.keys(store.editorSong?.members || {});
        return (store.bandMemberEntries || []).filter(([name]) => !existing.includes(name));
    }

    function handleSave() {
        store.saveSong();
    }

    function handleDelete() {
        if (confirmingDelete) {
            store.deleteSong(store.editorSong);
            confirmingDelete = false;
        } else {
            confirmingDelete = true;
        }
    }

    function cancelDelete() {
        confirmingDelete = false;
    }

    function memberIssues(memberName, memberSetup) {
        const instruments = memberSetup?.instruments || [];
        if (instruments.length === 0) return null; // no setups = member just listed, that's fine
        for (const inst of instruments) {
            if (!inst.name) return "Pick or type an instrument name";
            const bandMembers = store.bandMembers || {};
            const bandMember = bandMembers[memberName];
            if (bandMember) {
                const bandInst = (bandMember.instruments || []).find((i) => i.name === inst.name);
                if (bandInst && (bandInst.techniques || []).length > 0 && (!Array.isArray(inst.picking) || inst.picking.length === 0)) {
                    return `${inst.name}: pick a technique`;
                }
            }
        }
        return null;
    }
</script>

<div class="editor-overlay">
    <header class="editor-header">
        <button type="button" class="back-btn" onclick={() => store.closeEditor()} aria-label="Back">
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
        </button>
        <span class="editor-title">{store.editorSong.name || "New Song"}</span>
        <button type="button" class="save-btn" onclick={handleSave}>Save</button>
    </header>

    <div class="editor-body">
        <!-- Section 1: Basics -->
        <section class="section-card">
            <h3 class="section-heading">Basics</h3>

            <label class="field">
                <span class="field-label">Song name</span>
                <input
                    class="field-input"
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

            <div class="toggle-row">
                <ChipToggle
                    checked={store.editorSong.unpracticed}
                    onchange={(e) => store.updateSongField("unpracticed", e.currentTarget.checked)}
                >Unpracticed</ChipToggle>
            </div>
        </section>

        <!-- Section 2: Members -->
        <section class="section-card">
            <h3 class="section-heading">Members</h3>

            {#each Object.entries(store.editorSong.members || {}) as [memberName, memberSetup]}
                {@const issue = memberIssues(memberName, memberSetup)}
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
                            <span class="member-instrument-summary">
                                {(memberSetup.instruments || []).map((i) => i.name).filter(Boolean).join(", ")}
                            </span>
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
                            <label class="field">
                                <span class="field-label">Member name</span>
                                <input
                                    class="field-input"
                                    value={memberName}
                                    onchange={(e) => store.renameMember(memberName, e.currentTarget.value)}
                                />
                            </label>

                            {#each memberSetup.instruments as option, index}
                                {@const knownInstruments = availableInstruments(memberName, option).filter(Boolean)}
                                {@const instDraft = getInstrumentDraft(memberName, index, option.name)}
                                <div class="instrument-card">
                                    <div class="instrument-top">
                                        <label class="field flex-1">
                                            <span class="field-label">Instrument</span>
                                            <div class="inline-add">
                                                <input
                                                    class="field-input"
                                                    list={`inst-${memberName}-${index}`}
                                                    value={instDraft}
                                                    placeholder="e.g. Guitar, Bass, Keys"
                                                    oninput={(e) => setInstrumentDraft(memberName, index, e.currentTarget.value)}
                                                    onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitInstrumentName(memberName, index); } }}
                                                    onblur={() => commitInstrumentName(memberName, index)}
                                                />
                                                {#if instDraft && instDraft !== option.name}
                                                    <button type="button" class="add-sm-btn" onclick={() => commitInstrumentName(memberName, index)}>Set</button>
                                                {/if}
                                            </div>
                                            {#if knownInstruments.length > 0}
                                                <datalist id={`inst-${memberName}-${index}`}>
                                                    {#each knownInstruments as instrument}
                                                        <option value={instrument} />
                                                    {/each}
                                                </datalist>
                                            {/if}
                                        </label>

                                        <button type="button"
                                            class="remove-setup-btn"
                                            onclick={() => store.removeInstrumentOption(memberName, index)}
                                        >Remove</button>
                                    </div>

                                    {#if option.name || instDraft}
                                        <div class="tuning-section">
                                            <span class="field-label">Tunings</span>
                                            {#if defaultTuning(memberName, option.name)}
                                                <small class="default-note">Default: {defaultTuning(memberName, option.name)}</small>
                                            {/if}
                                            {#if availableTunings(memberName, option).length > 0}
                                                <div class="chip-row">
                                                    {#each availableTunings(memberName, option) as tuning}
                                                        <ChipToggle
                                                            checked={(option.tuning || []).includes(tuning)}
                                                            onchange={() => toggleTuning(memberName, index, tuning)}
                                                        >{tuning}</ChipToggle>
                                                    {/each}
                                                </div>
                                                {#if !hasDefaultTuning(memberName, option.name)}
                                                    <button type="button" class="defaults-hint" onclick={() => openBandMemberEdit(memberName)}>No default tuning — set one in {memberName}'s config</button>
                                                {/if}
                                            {/if}
                                            <div class="inline-add">
                                                <input
                                                    class="field-input small"
                                                    type="text"
                                                    placeholder="Add tuning..."
                                                    value={store.newTuningByInstrument?.[store.tuningDraftKey(memberName, option.name)] || ""}
                                                    oninput={(e) => { store.newTuningByInstrument = { ...store.newTuningByInstrument, [store.tuningDraftKey(memberName, option.name)]: e.currentTarget.value }; }}
                                                    onkeydown={(e) => handleAddTuningKeydown(e, memberName, option.name, index)}
                                                />
                                                <button type="button" class="add-sm-btn" onclick={() => handleAddTuning(memberName, option.name, index)}>Add</button>
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
                                            <span class="field-label">Techniques</span>
                                            {#if availableTechniques(memberName, option).length > 0}
                                                <div class="chip-row">
                                                    <ChipToggle
                                                        checked={(option.picking || []).includes("none")}
                                                        onchange={() => store.updateInstrumentOption(memberName, index, "picking", (option.picking || []).includes("none") ? [] : ["none"])}
                                                    >None</ChipToggle>
                                                    {#each availableTechniques(memberName, option) as technique}
                                                        {@const active = (option.picking || []).includes(technique)}
                                                        <ChipToggle
                                                            checked={active}
                                                            onchange={() => store.updateInstrumentOption(memberName, index, "picking", active ? (option.picking || []).filter(t => t !== technique) : [...(option.picking || []).filter(t => t !== "none"), technique])}
                                                        >{technique}</ChipToggle>
                                                    {/each}
                                                </div>
                                                {#if !hasDefaultTechnique(memberName, option.name)}
                                                    <button type="button" class="defaults-hint" onclick={() => openBandMemberEdit(memberName)}>No default technique set — set one in {memberName}'s config so new songs auto-pick it</button>
                                                {/if}
                                            {/if}
                                            <div class="inline-add">
                                                <input
                                                    class="field-input small"
                                                    type="text"
                                                    placeholder="Add technique..."
                                                    value={store.newTechniqueByInstrument?.[store.techniqueDraftKey(memberName, option.name)] || ""}
                                                    oninput={(e) => { store.newTechniqueByInstrument = { ...store.newTechniqueByInstrument, [store.techniqueDraftKey(memberName, option.name)]: e.currentTarget.value }; }}
                                                    onkeydown={(e) => handleAddTechniqueKeydown(e, memberName, option.name, index)}
                                                />
                                                <button type="button" class="add-sm-btn" onclick={() => handleAddTechnique(memberName, option.name, index)}>Add</button>
                                            </div>
                                        </div>
                                    {/if}
                                </div>
                            {/each}

                            <button type="button"
                                class="secondary-btn"
                                onclick={() => store.addInstrumentOption(memberName)}
                            >+ Add another setup</button>

                            <button type="button"
                                class="danger-text-btn"
                                onclick={() => store.removeMember(memberName)}
                            >Remove {memberName}</button>
                        </div>
                    {/if}
                </div>
            {/each}

            {#if bandMembersNotInSong().length > 0}
                <div class="add-member-row">
                    {#each bandMembersNotInSong() as [name]}
                        <button type="button" class="add-member-btn" onclick={() => store.addMember(name)}>+ {name}</button>
                    {/each}
                </div>
            {/if}
            <button type="button" class="secondary-btn" onclick={() => store.addMember()}>+ New member</button>
        </section>

        <!-- Bottom actions -->
        <div class="bottom-actions">
            <button type="button" class="secondary-btn full-width" onclick={() => store.duplicateSong(store.editorSong)}>Duplicate song</button>

            {#if confirmingDelete}
                <div class="delete-confirm">
                    <span class="delete-warn">Are you sure? This cannot be undone.</span>
                    <div class="delete-confirm-btns">
                        <button type="button" class="danger-btn" onclick={handleDelete}>Yes, delete</button>
                        <button type="button" class="secondary-btn" onclick={cancelDelete}>Cancel</button>
                    </div>
                </div>
            {:else}
                <button type="button" class="danger-text-btn full-width" onclick={handleDelete}>Delete song</button>
            {/if}
        </div>
    </div>
</div>

<style>
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

    .field {
        display: grid;
        gap: 0.35rem;
    }

    .field-label {
        font-size: 0.82rem;
        font-weight: 700;
        color: var(--ink, #182230);
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

    /* Member cards */
    .member-card {
        border-radius: var(--radius-md, 12px);
        border: 1px solid var(--line);
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

    .default-note {
        color: var(--muted, #6b7a8d);
        font-size: 0.78rem;
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

    .defaults-hint {
        background: none;
        border: none;
        padding: 0;
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--accent, #e15b37);
        cursor: pointer;
        text-align: left;
        text-decoration: underline;
        text-decoration-thickness: 1px;
        text-underline-offset: 2px;
    }

    .defaults-hint:hover {
        color: var(--accent-strong);
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

    /* Add member row */
    .add-member-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
    }

    .add-member-btn {
        padding: 0.45rem 0.85rem;
        border-radius: var(--radius-md, 12px);
        border: 1.5px solid var(--accent, #e15b37);
        background: var(--accent-soft);
        color: var(--accent, #e15b37);
        font-weight: 700;
        font-size: 0.82rem;
        cursor: pointer;
        touch-action: manipulation;
    }

    .add-member-btn:active {
        background: var(--accent-line);
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

    .danger-btn {
        min-height: 2.8rem;
        padding: 0.55rem 1rem;
        border: none;
        border-radius: var(--radius-md, 12px);
        background: var(--danger, #d33);
        color: var(--on-accent);
        font-weight: 700;
        font-size: 0.88rem;
        cursor: pointer;
        touch-action: manipulation;
    }

    .danger-btn:active {
        opacity: 0.85;
    }

    .full-width {
        width: 100%;
    }

    .bottom-actions {
        display: grid;
        gap: 0.6rem;
        padding-top: 0.5rem;
    }

    .delete-confirm {
        display: grid;
        gap: 0.5rem;
        padding: 1rem;
        border-radius: var(--radius-md, 12px);
        background: rgba(200, 40, 40, 0.05);
        border: 1px solid rgba(200, 40, 40, 0.15);
    }

    .delete-warn {
        font-weight: 600;
        font-size: 0.88rem;
        color: var(--danger, #d33);
    }

    .delete-confirm-btns {
        display: flex;
        gap: 0.5rem;
    }
</style>
