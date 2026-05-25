<script>
    import { getContext } from "svelte";
    import { DEFAULT_DIE_COLOR } from "../../utils.js";

    const store = getContext("app");

    let bandNameDraft = $state(store.appConfig?.bandName ?? "");
    let renameDraft = $state("");

    function _saveBandName() {
        store.updateConfigField("bandName", bandNameDraft);
        store.saveConfig();
    }

    function handleBandNameKeydown(e) {
        if (e.key === "Enter") {
            e.currentTarget.blur();
        }
    }

    function openMemberEdit(memberName) {
        store.editingMemberName = memberName;
        store.bandSubView = "member-edit";
    }

    function handleBackToMain() {
        store.bandSubView = "main";
    }

    function handleRenameMember(e) {
        const newName = e.currentTarget.value.trim();
        if (newName && newName !== store.editingMemberName) {
            store.renameBandMember(store.editingMemberName, newName);
            store.editingMemberName = newName;
        }
    }

    function handleAddMember() {
        if (store.newMemberName?.trim()) {
            store.addBandMember();
        }
    }

    function handleAddMemberKeydown(e) {
        if (e.key === "Enter") handleAddMember();
    }

    function handleAddInstrument(memberName) {
        if (store.newInstrumentByMember?.[memberName]?.trim()) {
            store.addBandMemberInstrument(memberName);
        }
    }

    function handleAddInstrumentKeydown(e, memberName) {
        if (e.key === "Enter") handleAddInstrument(memberName);
    }

    function handleAddTuning(memberName, instrumentName) {
        const key = store.tuningDraftKey(memberName, instrumentName);
        if (store.newTuningByInstrument?.[key]?.trim()) {
            store.addTuningChoice(memberName, instrumentName);
        }
    }

    function handleAddTuningKeydown(e, memberName, instrumentName) {
        if (e.key === "Enter") handleAddTuning(memberName, instrumentName);
    }

    function handleAddTechnique(memberName, instrumentName) {
        const key = store.techniqueDraftKey(memberName, instrumentName);
        if (store.newTechniqueByInstrument?.[key]?.trim()) {
            store.addTechniqueChoice(memberName, instrumentName);
        }
    }

    function handleAddTechniqueKeydown(e, memberName, instrumentName) {
        if (e.key === "Enter") handleAddTechnique(memberName, instrumentName);
    }

    function instrumentSummary(memberConfig) {
        return (memberConfig.instruments || []).map((i) => i.name).filter(Boolean).join(", ");
    }

    const PIP_COLOR_OPTIONS = [
        DEFAULT_DIE_COLOR, "#ef4444", "#d94f7a", "#ec4899",
        "#a855f7", "#8b5cf6", "#6366f1", "#3b82f6",
        "#0ea5e9", "#14b8a6", "#10b981", "#22c55e",
        "#84cc16", "#eab308", "#f59e0b", "#f97316",
        "#78716c", "#64748b", "#1a1a1a",
    ];
    let persistedDieColor = $derived(store.appConfig?.ui?.dieColor ?? null);

    function setDieColor(color) {
        store.updateConfigField("ui.dieColor", color);
        store.saveConfig();
    }

    function _renderConfigField(field) {
        return field;
    }
</script>

<div class="band-screen">
    {#if store.bandSubView === "member-edit"}
        <!-- MEMBER EDIT SUB-VIEW -->
        <div class="sub-header">
            <button type="button" class="back-btn" onclick={handleBackToMain}>&larr; Back</button>
            <h2 class="sub-title">Edit Member</h2>
        </div>

        {#each store.bandMemberEntries.filter(([name]) => name === store.editingMemberName) as [memberName, memberConfig]}
            <div class="card">
                <label class="field-group">
                    <span class="field-label">Member name</span>
                    <input
                        class="text-input"
                        type="text"
                        value={memberName}
                        onblur={handleRenameMember}
                        onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    />
                </label>

                {#if (memberConfig.instruments || []).length > 0}
                    <label class="field-group">
                        <span class="field-label">Default instrument</span>
                        <select
                            class="select-input"
                            value={memberConfig.defaultInstrument || ""}
                            onchange={(e) => store.setMemberDefaultInstrument(memberName, e.currentTarget.value)}
                        >
                            <option value="" disabled>Select...</option>
                            {#each memberConfig.instruments as inst}
                                <option value={inst.name}>{inst.name}</option>
                            {/each}
                        </select>
                    </label>
                {/if}

                <button type="button"
                    class="danger-btn"
                    onclick={() => { store.removeBandMember(memberName); handleBackToMain(); }}
                >Remove member</button>
            </div>

            <div class="section-block">
                <h3 class="section-label">Instruments</h3>

                {#each memberConfig.instruments || [] as instrument, idx}
                    <details class="card instrument-card">
                        <summary class="instrument-summary">
                            <span class="instrument-name">{instrument.name}</span>
                            {#if instrument.defaultTuning}
                                <span class="pill">{instrument.defaultTuning}</span>
                            {/if}
                            {#if store.songsUsingInstrument(memberName, instrument.name).length > 0}
                                <span class="ref-count">{store.songsUsingInstrument(memberName, instrument.name).length}</span>
                            {/if}
                            <svg aria-hidden="true" class="chevron-down" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                        </summary>

                        <div class="instrument-body">
                            <label class="field-group">
                                <span class="field-label">Default tuning</span>
                                <select
                                    class="select-input"
                                    value={instrument.defaultTuning || ""}
                                    onchange={(e) => store.setInstrumentDefaultTuning(memberName, instrument.name, e.currentTarget.value)}
                                >
                                    <option value="" disabled>Select...</option>
                                    {#each instrument.tunings || [] as tuning}
                                        <option value={tuning}>{tuning}</option>
                                    {/each}
                                </select>
                            </label>

                            <div class="field-group">
                                <span class="field-label">Tunings</span>
                                <div class="chip-list">
                                    {#each instrument.tunings || [] as tuning}
                                        <span class="removable-chip">
                                            {tuning}
                                            {#if store.songsUsingTuning(memberName, instrument.name, tuning).length > 0}
                                                <span class="chip-ref-count">{store.songsUsingTuning(memberName, instrument.name, tuning).length}</span>
                                            {/if}
                                            <button type="button"
                                                class="chip-remove"
                                                onclick={() => store.removeTuningChoice(memberName, instrument.name, tuning)}
                                                aria-label="Remove {tuning}"
                                            >&times;</button>
                                        </span>
                                    {/each}
                                </div>
                                <div class="inline-add">
                                    <input
                                        class="text-input small"
                                        type="text"
                                        placeholder="New tuning..."
                                        value={store.newTuningByInstrument?.[store.tuningDraftKey(memberName, instrument.name)] || ""}
                                        oninput={(e) => { store.newTuningByInstrument = { ...store.newTuningByInstrument, [store.tuningDraftKey(memberName, instrument.name)]: e.currentTarget.value }; }}
                                        onkeydown={(e) => handleAddTuningKeydown(e, memberName, instrument.name)}
                                    />
                                    <button type="button" class="add-sm-btn" onclick={() => handleAddTuning(memberName, instrument.name)}>Add</button>
                                </div>
                            </div>

                            <div class="field-group">
                                <span class="field-label">Techniques</span>
                                {#if (instrument.techniques || []).length > 0}
                                    <label class="field-group" style="margin-bottom: 0.5rem">
                                        <span class="field-label" style="font-size: 0.75rem">Default technique</span>
                                        <select
                                            class="select-input"
                                            value={instrument.defaultTechnique || ""}
                                            onchange={(e) => store.setInstrumentDefaultTechnique(memberName, instrument.name, e.currentTarget.value)}
                                        >
                                            <option value="">None</option>
                                            {#each instrument.techniques as technique}
                                                <option value={technique}>{technique}</option>
                                            {/each}
                                        </select>
                                    </label>
                                    <div class="chip-list">
                                        {#each instrument.techniques as technique}
                                            <span class="removable-chip">
                                                {technique}
                                                {#if store.songsUsingTechnique(memberName, instrument.name, technique).length > 0}
                                                    <span class="chip-ref-count">{store.songsUsingTechnique(memberName, instrument.name, technique).length}</span>
                                                {/if}
                                                <button type="button"
                                                    class="chip-remove"
                                                    onclick={() => store.removeTechniqueChoice(memberName, instrument.name, technique)}
                                                    aria-label="Remove {technique}"
                                                >&times;</button>
                                            </span>
                                        {/each}
                                    </div>
                                {/if}
                                <div class="inline-add">
                                    <input
                                        class="text-input small"
                                        type="text"
                                        placeholder="New technique..."
                                        value={store.newTechniqueByInstrument?.[store.techniqueDraftKey(memberName, instrument.name)] || ""}
                                        oninput={(e) => { store.newTechniqueByInstrument = { ...store.newTechniqueByInstrument, [store.techniqueDraftKey(memberName, instrument.name)]: e.currentTarget.value }; }}
                                        onkeydown={(e) => handleAddTechniqueKeydown(e, memberName, instrument.name)}
                                    />
                                    <button type="button" class="add-sm-btn" onclick={() => handleAddTechnique(memberName, instrument.name)}>Add</button>
                                </div>
                            </div>

                            <button type="button"
                                class="danger-btn small"
                                onclick={() => store.removeBandMemberInstrument(memberName, instrument.name)}
                            >Remove instrument</button>
                        </div>
                    </details>
                {/each}

                <div class="inline-add">
                    <input
                        class="text-input"
                        type="text"
                        placeholder="New instrument..."
                        value={store.newInstrumentByMember?.[memberName] || ""}
                        oninput={(e) => { store.newInstrumentByMember = { ...store.newInstrumentByMember, [memberName]: e.currentTarget.value }; }}
                        onkeydown={(e) => handleAddInstrumentKeydown(e, memberName)}
                    />
                    <button type="button" class="add-sm-btn" onclick={() => handleAddInstrument(memberName)}>Add</button>
                </div>
            </div>
        {/each}

    {:else if store.bandSubView === "advanced"}
        <!-- ADVANCED CONFIG SUB-VIEW -->
        <div class="sub-header">
            <button type="button" class="back-btn" onclick={handleBackToMain}>&larr; Back</button>
            <h2 class="sub-title">Advanced Config</h2>
        </div>

        {#each store.CONFIG_SECTIONS.filter((s) => s.id !== "identity") as section}
            <details class="section-details">
                <summary class="section-summary"><span class="section-summary-label">{section.title}</span><svg aria-hidden="true" class="chevron-down" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg></summary>
                <div class="section-body">
                    {#if section.intro}
                        <p class="section-intro">{section.intro}</p>
                    {/if}
                    {#each section.fields as field}
                        <label class="config-field">
                            <span class="config-field-label">{field.label}</span>
                            {#if field.description}
                                <span class="config-field-desc">{field.description}</span>
                            {/if}
                            {#if field.type === "boolean"}
                                <select
                                    class="select-input"
                                    value={store.configFieldValue(store.appConfig, field) ? "true" : "false"}
                                    onchange={(e) => store.updateConfigField(field.path, e.currentTarget.value === "true")}
                                >
                                    <option value="true">Yes</option>
                                    <option value="false">No</option>
                                </select>
                            {:else if field.type === "order-rule"}
                                <select
                                    class="select-input"
                                    value={store.configFieldValue(store.appConfig, field) ? "true" : "false"}
                                    onchange={(e) => store.updateConfigField(field, e.currentTarget.value)}
                                >
                                    <option value="true">Yes</option>
                                    <option value="false">No</option>
                                </select>
                            {:else if field.type === "number"}
                                <input
                                    class="text-input"
                                    type="number"
                                    min={field.min}
                                    max={field.max}
                                    step={field.step || 1}
                                    value={store.configFieldValue(store.appConfig, field) ?? ""}
                                    oninput={(e) => store.updateConfigField(field.path, Number(e.currentTarget.value))}
                                />
                            {:else}
                                <input
                                    class="text-input"
                                    type="text"
                                    value={store.configFieldValue(store.appConfig, field) ?? ""}
                                    oninput={(e) => store.updateConfigField(field.path, e.currentTarget.value)}
                                />
                            {/if}
                        </label>
                    {/each}
                </div>
            </details>
        {/each}

        <div class="sticky-footer">
            <button type="button" class="primary-btn" onclick={() => store.saveConfig()}>Save Settings</button>
        </div>

    {:else}
        <!-- MAIN VIEW -->
        <header class="screen-header">
            <h2 class="screen-title">Band</h2>
        </header>

        <!-- Band Name -->
        <div class="card">
            <label class="field-group">
                <span class="field-label">Band name</span>
                <input
                    class="text-input band-name-input"
                    type="text"
                    value={store.appConfig?.bandName ?? ""}
                    oninput={(e) => { bandNameDraft = e.currentTarget.value; }}
                    onblur={() => { store.updateConfigField("bandName", bandNameDraft); store.saveConfig(); }}
                    onkeydown={handleBandNameKeydown}
                />
            </label>
            {#if store.connectionStatus === "connected"}
                <div class="field-group">
                    <span class="field-label">Die color</span>
                    <div class="pip-color-swatches">
                        {#each PIP_COLOR_OPTIONS as color}
                            <button type="button"
                                class="pip-swatch"
                                class:active={persistedDieColor === color}
                                style="background: {color};"
                                onclick={() => setDieColor(color)}
                                aria-label="Set die color to {color}"
                            ></button>
                        {/each}
                        <button type="button"
                            class="pip-swatch pip-swatch--reset"
                            class:active={!store.appConfig?.ui?.dieColor}
                            onclick={() => setDieColor(null)}
                            aria-label="Reset to default color"
                        >
                            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 12a9 9 0 1 0 9-9 7 7 0 0 0-5 2l-3 3"/><path d="M3 3v6h6"/></svg>
                        </button>
                    </div>
                </div>
            {/if}
        </div>

        <!-- Stats Row -->
        <div class="stats-row">
            <div class="stat-box">
                <span class="stat-value">{store.songs?.length ?? 0}</span>
                <span class="stat-label">songs</span>
            </div>
            <div class="stat-box">
                <span class="stat-value">{store.instrumentTypeCount ?? 0}</span>
                <span class="stat-label">instrument types</span>
            </div>
        </div>

        <hr class="section-divider" />

        <!-- Members Section -->
        <div class="section-block">
            <h3 class="section-label">Members</h3>

            {#if store.bandMemberEntries?.length === 0}
                <div class="empty-state">
                    <p class="empty-title">No members yet</p>
                    <p class="empty-sub">Add members who switch instruments, tunings, or capos between songs. If someone plays the same gear every song, they don't need to be here.</p>
                </div>
            {/if}

            <div class="member-list">
                {#each store.bandMemberEntries || [] as [memberName, memberConfig]}
                    <button type="button" class="member-row" onclick={() => openMemberEdit(memberName)}>
                        <div class="member-info">
                            <span class="member-name">{memberName}</span>
                            {#if instrumentSummary(memberConfig)}
                                <span class="member-instruments">{instrumentSummary(memberConfig)}</span>
                            {/if}
                        </div>
                        {#if store.songsUsingMember(memberName).length > 0}
                            <span class="ref-count">{store.songsUsingMember(memberName).length}</span>
                        {/if}
                        <svg aria-hidden="true" class="chevron-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>
                    </button>
                {/each}
            </div>

            <div class="inline-add">
                <input
                    class="text-input"
                    type="text"
                    placeholder="New member name..."
                    value={store.newMemberName || ""}
                    oninput={(e) => { store.newMemberName = e.currentTarget.value; }}
                    onkeydown={handleAddMemberKeydown}
                />
                <button type="button" class="add-sm-btn" onclick={handleAddMember}>Add</button>
            </div>
        </div>

        <hr class="section-divider" />

        <!-- Config Section -->
        <div class="section-block">
            <h3 class="section-label">Config</h3>
            <button type="button" class="card link-card" onclick={() => { store.bandSubView = "advanced"; }}>
                <span class="link-card-label">Transition costs and switching rules</span>
                <span class="link-card-arrow">&rsaquo;</span>
            </button>
        </div>

        <hr class="section-divider" />

        <!-- Data Section -->
        <div class="section-block">
            <h3 class="section-label">Data</h3>

            <button type="button" class="secondary-btn" onclick={() => store.exportAllData()}>Export All</button>

            <div class="import-group">
                <span class="field-label">Import</span>
                <input
                    class="file-input"
                    type="file"
                    accept=".json"
                    onchange={(e) => { store.importFile = e.currentTarget.files?.[0] ?? null; }}
                />
                <div class="import-row">
                    <select
                        class="select-input"
                        value={store.importMode || "skip"}
                        onchange={(e) => { store.importMode = e.currentTarget.value; }}
                    >
                        <option value="skip">Skip existing</option>
                        <option value="overwrite">Overwrite existing</option>
                    </select>
                    <button type="button" class="add-sm-btn" onclick={() => store.importFromFile()} disabled={!store.importFile}>Import</button>
                </div>
            </div>

            <button type="button" class="danger-btn" onclick={() => store.deleteAllData()}>Delete All Data</button>
        </div>

        <hr class="section-divider" />

        <!-- Account Section -->
        <div class="section-block">
            <h3 class="section-label">Account</h3>

            {#if store.connectAddress}
                <div class="connect-info">
                    <span class="field-label">Connected as</span>
                    <span class="connect-address">{store.connectAddress}</span>
                </div>
                <button type="button" class="danger-btn" onclick={() => store.disconnectStorage()}>Disconnect</button>
            {:else}
                <p class="empty-sub">Not connected.</p>
            {/if}
        </div>

        <footer class="app-footer">
            <span class="app-footer-name">Setlist Roller v{__APP_VERSION__}</span>
            <span class="app-footer-copy">&copy; Nick Jennings</span>
            <a class="app-footer-link" href="https://github.com/silverbucket/setlist-roller" target="_blank" rel="noopener">GitHub</a>
        </footer>
    {/if}
</div>

<style>
    .band-screen {
        display: grid;
        gap: 0.85rem;
        padding: 1rem;
        max-width: 640px;
        margin: 0 auto;
        padding-bottom: 5rem;
    }

    /* Header */
    .screen-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .screen-title {
        font-size: 1.4rem;
        font-weight: 800;
        margin: 0;
    }

    .sub-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }

    .sub-title {
        font-size: 1.2rem;
        font-weight: 800;
        margin: 0;
    }

    .back-btn {
        min-height: 2.4rem;
        padding: 0.4rem 0.75rem;
        border-radius: var(--radius-md, 16px);
        border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        background: var(--paper, rgba(255, 255, 255, 0.82));
        font-size: 0.85rem;
        font-weight: 700;
        color: var(--ink, #182230);
        cursor: pointer;
        touch-action: manipulation;
    }

    .back-btn:active {
        background: var(--hover);
    }

    /* Card */
    .card {
        padding: 0.85rem 1rem;
        border-radius: var(--radius-md, 16px);
        border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        background: var(--paper, rgba(255, 255, 255, 0.82));
        display: grid;
        gap: 0.65rem;
    }

    /* Stats */
    .stats-row {
        display: flex;
        gap: 0.5rem;
    }

    .stat-box {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 0.65rem 0.5rem;
        border-radius: var(--radius-md, 16px);
        border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        background: var(--paper, rgba(255, 255, 255, 0.82));
    }

    .stat-value {
        font-size: 1.4rem;
        font-weight: 800;
        color: var(--accent, #e15b37);
    }

    .stat-label {
        font-size: 0.72rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--muted, #617086);
    }

    /* Section divider */
    .section-divider {
        border: none;
        border-top: 1px solid var(--line, rgba(27, 49, 80, 0.1));
        margin: 0.5rem 0;
    }

    /* Section */
    .section-block {
        display: grid;
        gap: 0.65rem;
    }

    .section-label {
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted, #617086);
        margin: 0;
        padding-top: 0;
    }

    /* Fields */
    .field-group {
        display: grid;
        gap: 0.25rem;
    }

    .field-label {
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--muted, #617086);
    }

    .text-input {
        width: 100%;
        min-height: 2.8rem;
        padding: 0.6rem 0.9rem;
        border-radius: var(--radius-md, 16px);
        border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        background: var(--surface);
        font-size: 1rem;
        box-sizing: border-box;
    }

    .text-input.small {
        min-height: 2.2rem;
        padding: 0.4rem 0.7rem;
        /* iOS zooms inputs <16px on focus — keep at 16px to prevent zoom. */
        font-size: 16px;
    }

    .select-input {
        min-height: 2.6rem;
        padding: 0.5rem 0.7rem;
        border-radius: var(--radius-md, 16px);
        border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        background: var(--surface);
        /* iOS zooms selects <16px on focus — keep at 16px to prevent zoom. */
        font-size: 16px;
        font-weight: 600;
        color: var(--ink, #182230);
        cursor: pointer;
        width: 100%;
    }

    .band-name-input {
        font-size: 1.15rem;
        font-weight: 700;
    }

    /* Member list */
    .member-list {
        display: grid;
        gap: 0.4rem;
    }

    .member-row {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        padding: 0.75rem 1rem;
        border-radius: var(--radius-md, 16px);
        border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        background: var(--paper, rgba(255, 255, 255, 0.82));
        width: 100%;
        cursor: pointer;
        touch-action: manipulation;
        font: inherit;
        color: inherit;
        text-align: left;
        -webkit-tap-highlight-color: transparent;
    }

    .member-row:active {
        background: var(--accent-soft);
    }

    .member-info {
        flex: 1;
        display: grid;
        gap: 0.15rem;
        min-width: 0;
    }

    .member-name {
        font-weight: 700;
        font-size: 1rem;
    }

    .member-instruments {
        font-size: 0.8rem;
        color: var(--muted, #617086);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .ref-count {
        flex-shrink: 0;
        font-size: 0.72rem;
        font-weight: 700;
        color: var(--muted, #617086);
        background: var(--line);
        min-width: 1.4rem;
        height: 1.4rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        padding: 0 0.3rem;
    }

    .chip-ref-count {
        font-size: 0.65rem;
        font-weight: 700;
        color: var(--muted, #617086);
        opacity: 0.7;
    }

    .chevron-icon {
        flex-shrink: 0;
        color: var(--muted, #617086);
    }

    /* Inline add */
    .inline-add {
        display: flex;
        gap: 0.4rem;
        align-items: center;
    }

    .inline-add .text-input {
        flex: 1;
    }

    .add-sm-btn {
        min-height: 2.8rem;
        padding: 0.5rem 1rem;
        border-radius: var(--radius-md, 16px);
        border: none;
        background: var(--ink, #182230);
        color: var(--on-ink);
        font-size: 0.82rem;
        font-weight: 700;
        cursor: pointer;
        touch-action: manipulation;
        flex-shrink: 0;
    }

    .add-sm-btn:active {
        opacity: 0.85;
    }

    /* Link card */
    .link-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        touch-action: manipulation;
        font: inherit;
        color: inherit;
        text-align: left;
    }

    .link-card:active {
        background: var(--hover);
    }

    .link-card-label {
        font-weight: 700;
        font-size: 1rem;
    }

    .link-card-arrow {
        font-size: 1.4rem;
        font-weight: 700;
        color: var(--muted, #617086);
    }

    /* Buttons */
    .primary-btn {
        width: 100%;
        min-height: 2.8rem;
        padding: 0.6rem 1.2rem;
        border-radius: var(--radius-md, 16px);
        border: none;
        background: var(--accent, #e15b37);
        color: var(--on-accent);
        font-size: 1rem;
        font-weight: 800;
        cursor: pointer;
        touch-action: manipulation;
        transition: background 140ms ease;
    }

    .primary-btn:hover {
        background: var(--accent-strong, #c64724);
    }

    .primary-btn:active {
        opacity: 0.9;
    }

    .secondary-btn {
        width: 100%;
        min-height: 2.6rem;
        padding: 0.5rem 1rem;
        border-radius: var(--radius-md, 16px);
        border: 2px solid var(--accent, #e15b37);
        background: transparent;
        color: var(--accent, #e15b37);
        font-size: 0.9rem;
        font-weight: 700;
        cursor: pointer;
        touch-action: manipulation;
        transition: background 140ms ease;
    }

    .secondary-btn:hover {
        background: var(--accent-soft, rgba(225, 91, 55, 0.12));
    }

    .secondary-btn:active {
        background: var(--accent-soft, rgba(225, 91, 55, 0.12));
    }

    .danger-btn {
        min-height: 2.4rem;
        padding: 0.5rem 1rem;
        border-radius: var(--radius-md, 16px);
        border: 1px solid var(--danger, #992f20);
        background: transparent;
        color: var(--danger, #992f20);
        font-size: 0.85rem;
        font-weight: 700;
        cursor: pointer;
        touch-action: manipulation;
    }

    .danger-btn.small {
        min-height: 2rem;
        padding: 0.3rem 0.7rem;
        font-size: 0.78rem;
    }

    .danger-btn:active {
        background: rgba(153, 47, 32, 0.08);
    }

    /* Instrument card */
    .instrument-card {
        overflow: hidden;
    }

    .instrument-summary {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        cursor: pointer;
        user-select: none;
        list-style: none;
        padding: 0;
        min-height: 2.4rem;
    }

    .instrument-summary::-webkit-details-marker {
        display: none;
    }

    .instrument-name {
        font-weight: 700;
        font-size: 0.95rem;
        flex: 1;
    }

    .chevron-down {
        flex-shrink: 0;
        color: var(--muted, #617086);
        transition: transform 200ms ease;
    }

    .instrument-card[open] > .instrument-summary .chevron-down {
        transform: rotate(180deg);
    }

    .instrument-body {
        display: grid;
        gap: 0.65rem;
        padding-top: 0.65rem;
        border-top: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        margin-top: 0.65rem;
    }

    /* Chips */
    .chip-list {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
    }

    .removable-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.3rem 0.6rem;
        border-radius: 999px;
        background: var(--paper-soft, rgba(247, 249, 253, 0.92));
        border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        font-size: 0.8rem;
        font-weight: 600;
    }

    .chip-remove {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.2rem;
        height: 1.2rem;
        border: none;
        background: none;
        color: var(--muted, #617086);
        font-size: 1rem;
        line-height: 1;
        padding: 0;
        cursor: pointer;
        border-radius: 50%;
    }

    .chip-remove:hover {
        color: var(--danger, #992f20);
        background: rgba(153, 47, 32, 0.08);
    }

    .pill {
        display: inline-flex;
        align-items: center;
        padding: 0.15rem 0.5rem;
        border-radius: 999px;
        font-size: 0.72rem;
        font-weight: 600;
        background: var(--line);
        color: var(--muted, #617086);
    }

    /* Collapsible sections (advanced) */
    .section-details {
        border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        border-radius: var(--radius-lg, 20px);
        background: var(--paper, rgba(255, 255, 255, 0.82));
        overflow: hidden;
    }

    .section-summary {
        padding: 0.75rem 1rem;
        font-weight: 700;
        font-size: 0.95rem;
        color: var(--ink, #182230);
        cursor: pointer;
        user-select: none;
        list-style: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.4rem;
        min-height: 2.8rem;
    }

    .section-summary::-webkit-details-marker {
        display: none;
    }

    .section-summary-label {
        flex: 1;
    }

    .section-details[open] > .section-summary .chevron-down {
        transform: rotate(180deg);
    }

    .section-body {
        padding: 0 1rem 1rem;
        display: grid;
        gap: 0.75rem;
    }

    .section-intro {
        font-size: 0.82rem;
        color: var(--muted, #617086);
        line-height: 1.45;
        margin: 0;
    }

    /* Config fields */
    .config-field {
        display: grid;
        gap: 0.2rem;
    }

    .config-field-label {
        font-size: 0.85rem;
        font-weight: 700;
        color: var(--ink, #182230);
    }

    .config-field-desc {
        font-size: 0.75rem;
        color: var(--muted, #617086);
        line-height: 1.35;
    }

    /* Import */
    .import-group {
        display: grid;
        gap: 0.4rem;
    }

    .import-row {
        display: flex;
        gap: 0.4rem;
        align-items: center;
    }

    .import-row .select-input {
        flex: 1;
    }

    .file-input {
        font-size: 0.85rem;
        color: var(--muted, #617086);
    }

    /* Connect info */
    .connect-info {
        display: grid;
        gap: 0.3rem;
        padding: 0.75rem;
        border-radius: var(--radius-md, 16px);
        border: 1px solid var(--line, rgba(27, 49, 80, 0.12));
        background: var(--paper-soft, rgba(247, 249, 253, 0.92));
    }

    .connect-address {
        font-size: 0.82rem;
        font-weight: 600;
        word-break: break-all;
        color: var(--ink, #182230);
    }

    /* Sticky footer */
    .sticky-footer {
        position: sticky;
        bottom: calc(var(--bottom-nav-height, 56px) + env(safe-area-inset-bottom, 0px) + 0.5rem);
        padding: 0.75rem 0;
        z-index: 10;
    }

    /* Empty state */
    .empty-state {
        padding: 1.5rem 1rem;
        text-align: center;
    }

    .empty-title {
        font-size: 1rem;
        font-weight: 700;
        margin: 0 0 0.3rem;
    }

    .empty-sub {
        color: var(--muted, #617086);
        margin: 0;
        font-size: 0.88rem;
    }

    /* App footer */
    .app-footer {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.2rem;
        padding: 1.5rem 0 0.5rem;
        font-size: 0.72rem;
        color: var(--muted, #617086);
    }

    .app-footer-name {
        font-weight: 700;
    }

    .app-footer-link {
        color: var(--accent, #e15b37);
        text-decoration: none;
        font-weight: 600;
    }

    .app-footer-link:hover {
        text-decoration: underline;
    }

    /* ---- Die color picker ---- */
    .pip-color-swatches {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }

    .pip-swatch {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        transition: transform 150ms ease, border-color 150ms ease;
        -webkit-tap-highlight-color: transparent;
        padding: 0;
    }

    .pip-swatch:hover {
        transform: scale(1.15);
    }

    .pip-swatch.active {
        border-color: var(--ink);
        box-shadow: 0 0 0 2px var(--paper), 0 0 0 4px var(--ink);
    }

    .pip-swatch--reset {
        background: var(--paper);
        border: 2px dashed var(--line-strong);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--muted);
    }
</style>
