import { normalizeAppConfig, normalizeMemberRecord } from "../defaults.js";
import { clone, formatDelimitedList, getByPath, nowIso, parseDelimitedList, setByPath } from "../utils.js";

// Band setup, member vocabulary, and debounced configuration editing.
export function createBandStore(repo, stores) {
    let firstRunBandName = $state("");

    // ---- band editing ----
    let expandedBandMember = $state("");

    // ---- advanced config sub-view ----
    let bandSubView = $state("main"); // "main" | "advanced" | "member-edit"
    let editingMemberName = $state("");
    let bandMemberEntries = $derived(
        Object.entries(stores.catalog.bandMembers || {}).sort(([a], [b]) => a.localeCompare(b))
    );
    let availableMemberNames = $derived(buildAvailableMemberNames());
    let memberInstrumentChoicesByMember = $derived(buildMemberInstrumentChoicesByMember());
    let memberTuningChoicesByMember = $derived(buildMemberTuningChoicesByMember());
    let defaultTuningByMemberInstrument = $derived(buildDefaultTuningByMemberInstrument());
    let allInstrumentNamesList = $derived(buildAllInstrumentNames());
    let instrumentTypeCount = $derived(allInstrumentNamesList.length);

    function buildAvailableMemberNames() {
        const names = new Set([
            ...Object.keys(stores.catalog.bandMembers || {}),
            ...Object.keys(stores.generation.generationOptions.show?.members || {}),
            ...stores.catalog.songs.flatMap((song) => Object.keys(song.members || {}))
        ]);
        return Array.from(names).sort();
    }

    function buildMemberInstrumentChoicesByMember() {
        return availableMemberNames.reduce((result, memberName) => {
            const fromSongs = stores.catalog.songs.flatMap((song) =>
                (song.members?.[memberName]?.instruments || []).map((o) => o.name)
            );
            const fromConfig = stores.generation.generationOptions.show?.members?.[memberName]?.allowedInstruments || [];
            const fromBand = (stores.catalog.bandMembers?.[memberName]?.instruments || []).map((i) => i.name);
            result[memberName] = Array.from(new Set([...fromBand, ...fromSongs, ...fromConfig].filter(Boolean))).sort();
            return result;
        }, {});
    }

    function buildMemberTuningChoicesByMember() {
        return availableMemberNames.reduce((result, memberName) => {
            result[memberName] = (memberInstrumentChoicesByMember[memberName] || []).reduce((ir, instrumentName) => {
                const fromBand = (stores.catalog.bandMembers?.[memberName]?.instruments || [])
                    .find((i) => i.name === instrumentName)?.tunings || [];
                const fromConfig = stores.generation.generationOptions.show?.members?.[memberName]?.allowedTunings?.[instrumentName] || [];
                ir[instrumentName] = Array.from(new Set([...fromBand, ...fromConfig].filter(Boolean))).sort();
                return ir;
            }, {});
            return result;
        }, {});
    }

    function buildDefaultTuningByMemberInstrument() {
        return availableMemberNames.reduce((result, memberName) => {
            result[memberName] = (stores.catalog.bandMembers?.[memberName]?.instruments || []).reduce((ir, instrument) => {
                ir[instrument.name] = instrument.defaultTuning || "";
                return ir;
            }, {});
            return result;
        }, {});
    }

    function buildAllInstrumentNames() {
        const names = new Set();
        Object.values(memberInstrumentChoicesByMember || {}).forEach((instruments) => {
            // Wrap in a block so the arrow doesn't return Set#add's value —
            // Biome's useIterableCallbackReturn flags implicit returns from
            // forEach callbacks as a likely bug.
            (instruments || []).forEach((name) => {
                names.add(name);
            });
        });
        return Array.from(names).sort();
    }

    async function finishFirstRun() {
        const bandName = firstRunBandName.trim();
        if (!bandName) {
            stores.ui.toastError("Your band needs a name.");
            return;
        }
        const sessionAlive = stores.accounts.sessionGuard();
        try {
            stores.ui.busyMessage = "Setting up...";
            const config = await stores.connection.withSync("Setting up", () => repo.ensureConfig(bandName));
            if (!sessionAlive()) return;
            stores.catalog.setConfigLocal(config);
            stores.generation.generationOptions = stores.generation.defaultGenerationOptions(stores.catalog.appConfig);
            stores.generation.persistGenerationOptions();
            stores.ui.toastInfo(`Welcome, ${bandName}.`);
        } catch (error) {
            stores.ui.toastError(error?.message || "Could not save your band name.");
        } finally {
            stores.ui.busyMessage = "";
        }
    }

    // ---- config ----
    function configFieldValue(config, field) {
        const value = getByPath(config, field.path);
        if (field.type === "list") return formatDelimitedList(value);
        if (field.type === "order-rule") {
            if (!Array.isArray(value) || !Array.isArray(field.rule) || field.rule.length < 2) return false;
            const ruleField = field.rule[0];
            const ruleValue = field.rule[1];
            return value.some((entry) => Array.isArray(entry) && entry.length >= 2 && entry[0] === ruleField && entry[1] === ruleValue);
        }
        return value;
    }

    // Debounced autosave for config field edits. Advanced-config inputs
    // write through updateConfigField on every keystroke; persisting each
    // one would spam remoteStorage, and requiring an explicit "Save
    // Settings" press silently lost edits when the user navigated away
    // (the in-memory config had already changed). One save model instead:
    // edits persist themselves shortly after the user stops typing.
    let configSaveTimer = null;
    function scheduleConfigSave() {
        if (configSaveTimer) clearTimeout(configSaveTimer);
        configSaveTimer = setTimeout(() => {
            configSaveTimer = null;
            if (stores.catalog.appConfig) void persistConfigEdit(stores.catalog.appConfig);
        }, 800);
    }
    function cancelConfigSave() {
        if (configSaveTimer) {
            clearTimeout(configSaveTimer);
            configSaveTimer = null;
        }
    }

    function updateConfigField(fieldOrPath, rawValue) {
        if (!stores.catalog.appConfig) return;
        scheduleConfigSave();
        // Accept either a field object { path, type } or a plain path string
        if (typeof fieldOrPath === "string") {
            stores.catalog.appConfig = setByPath(stores.catalog.appConfig, fieldOrPath, rawValue);
            return;
        }
        const field = fieldOrPath;
        let next = rawValue;
        if (field.type === "number") {
            next = Number(rawValue);
            if (Number.isFinite(field.min)) next = Math.max(field.min, next);
            if (Number.isFinite(field.max)) next = Math.min(field.max, next);
        }
        else if (field.type === "boolean") next = Boolean(rawValue);
        else if (field.type === "list") next = parseDelimitedList(rawValue);
        else if (field.type === "order-rule") {
            if (!Array.isArray(field.rule) || field.rule.length < 2) return;
            const current = getByPath(stores.catalog.appConfig, field.path) ?? [];
            const enabled = rawValue === "true" || rawValue === true;
            const ruleField = field.rule[0];
            const ruleValue = field.rule[1];
            const filtered = (Array.isArray(current) ? current : []).filter(
                (entry) => !(Array.isArray(entry) && entry.length >= 2 && entry[0] === ruleField && entry[1] === ruleValue),
            );
            stores.catalog.appConfig = setByPath(stores.catalog.appConfig, field.path, enabled ? [...filtered, [ruleField, ruleValue]] : filtered);
            return;
        }
        stores.catalog.appConfig = setByPath(stores.catalog.appConfig, field.path, next);
    }

    async function saveConfig() {
        if (!stores.catalog.appConfig) return;
        try {
            stores.ui.busyMessage = "Saving config...";
            if (await persistConfigEdit(stores.catalog.appConfig)) stores.ui.toastInfo("Settings saved.");
        } finally {
            stores.ui.busyMessage = "";
        }
    }

    // Monotonic token serializing config saves: rapid edits can overlap
    // (debounced autosave + blur save, or two slow writes), and applying an
    // OLDER save's response would roll the UI and known-accounts registry
    // back to stale data. Only the newest in-flight save applies its result.
    let configSaveRevision = 0;

    async function persistConfigEdit(nextConfig, errorMessage = "Could not save config.") {
        const normalized = normalizeAppConfig({ ...clone(nextConfig), updatedAt: nowIso() });
        const sessionAlive = stores.accounts.sessionGuard();
        const revision = ++configSaveRevision;
        stores.catalog.appConfig = normalized;
        try {
            const saved = await stores.connection.withSync("Saving settings", () => repo.putConfig(normalized));
            if (!sessionAlive()) return false;
            // Superseded by a newer save: the write itself succeeded, but
            // the newer save's response owns the local state.
            if (revision !== configSaveRevision) return true;
            stores.catalog.setConfigLocal(saved);
            stores.generation.persistGenerationOptions();
            return true;
        } catch (error) {
            stores.ui.toastError(error?.message || errorMessage);
            return false;
        }
    }

    // ---- band members ----
    async function persistMemberEdit(memberName, data, errorMessage = "Could not save member.") {
        const normalized = normalizeMemberRecord(data);
        const previousMember = stores.catalog.bandMembers?.[memberName];
        const sessionAlive = stores.accounts.sessionGuard();
        stores.catalog.bandMembers = { ...stores.catalog.bandMembers, [memberName]: normalized };
        try {
            await stores.connection.withSync("Saving member", () => repo.putMember(memberName, normalized));
            if (!sessionAlive()) return false;
            void stores.accounts.mirror?.putMember({ ...normalized, name: memberName }).catch(() => {});
            return true;
        } catch (error) {
            // Revert only our own key, and only if a newer edit hasn't already
            // replaced it, so a failed save can't clobber a concurrent successful
            // edit to this or another member. Post-switch the state was
            // blanked/re-hydrated wholesale — nothing of ours to revert.
            if (sessionAlive() && stores.catalog.bandMembers?.[memberName] === normalized) {
                const next = { ...stores.catalog.bandMembers };
                if (previousMember === undefined) delete next[memberName];
                else next[memberName] = previousMember;
                stores.catalog.bandMembers = next;
            }
            stores.ui.toastError(error?.message || errorMessage);
            return false;
        }
    }

    async function addBandMember(name) {
        const clean = String(name ?? "").trim();
        if (!clean) { stores.ui.toastError("Name the member first."); return false; }
        if (bandMemberEntries.some(([n]) => n === clean)) { stores.ui.toastError("Already exists."); return false; }
        if (await persistMemberEdit(clean, { instruments: [] }, "Could not add member.")) {
            expandedBandMember = clean;
            stores.ui.toastInfo(`Added "${clean}".`);
            return true;
        }
        return false;
    }

    async function renameBandMember(oldName, newName) {
        const clean = newName.trim();
        if (!clean || clean === oldName || bandMemberEntries.some(([n]) => n === clean)) return;
        // The rename cascades through every song referencing the member.
        // Until the account's first sync has settled, the in-memory catalog
        // may be partial and the cascade would miss documents — refuse
        // rather than rename half the catalog.
        if (!stores.connection.catalogSettled) {
            stores.ui.toastWarn("Still syncing your catalog — try the rename again in a moment.");
            return;
        }
        const data = stores.catalog.bandMembers[oldName] || { instruments: [] };

        const sessionAlive = stores.accounts.sessionGuard();
        // Put the new key first so a failure leaves the original member
        // intact — songs that reference `oldName` still resolve, and we
        // bail out without touching local state.
        try {
            await stores.connection.withSync("Renaming member", () => repo.putMember(clean, data));
        } catch (error) {
            stores.ui.toastError(error?.message || "Could not rename member.");
            return;
        }
        if (!sessionAlive()) return;

        // Apply the local rename now: the new key exists remotely, so the
        // UI must switch over even if the follow-up delete fails. The
        // caller (BandScreen) moves `editingMemberName` to `clean` without
        // awaiting this function; without the local mutation here the
        // edit-view filter would match nothing and the pane would go blank.
        stores.catalog.upsertMemberLocal(clean, data);
        stores.catalog.removeMemberLocal(oldName);
        if (expandedBandMember === oldName) expandedBandMember = clean;

        // Best-effort delete of the old key. A failure here leaves a
        // temporary duplicate in remoteStorage; rs.js retries on the next
        // sync round and the next reloadAll reconciles. This is the
        // explicit "duplicate member that resolves on next sync" failure
        // mode #70 accepts — surface it as a warning, not a hard error.
        try {
            await stores.connection.withSync("Cleaning up old member name", () => repo.deleteMember(oldName));
            stores.ui.toastInfo(`Renamed "${oldName}" to "${clean}".`);
        } catch (error) {
            stores.ui.toastWarn(
                `Renamed to "${clean}". Old name will clear on the next sync.${
                    error?.message ? ` (${error.message})` : ""
                }`,
            );
        }
        if (!sessionAlive()) return;

        // Cascade the rename into everything else keyed by member name —
        // song overrides and per-member generation constraints. Without
        // this, renamed members silently orphaned both.
        const affectedSongs = stores.catalog.songs.filter((s) => s.members && oldName in s.members);
        for (const song of affectedSongs) {
            const members = { ...song.members, [clean]: song.members[oldName] };
            delete members[oldName];
            try {
                const saved = await repo.putSong({ ...clone(song), members });
                if (!sessionAlive()) return;
                stores.catalog.upsertSongLocal(saved);
            } catch (error) {
                stores.ui.toastWarn(`Couldn't update "${song.name}" for the rename: ${error?.message || error}`);
            }
        }
        const showMembers = stores.generation.generationOptions.show?.members;
        if (showMembers?.[oldName]) {
            const members = { ...showMembers, [clean]: showMembers[oldName] };
            delete members[oldName];
            stores.generation.generationOptions = { ...stores.generation.generationOptions, show: { ...stores.generation.generationOptions.show, members } };
            stores.generation.persistGenerationOptions();
        }
    }

    function songsUsingMember(memberName) {
        return stores.catalog.songs.filter((s) => s.members && memberName in s.members);
    }

    function songsUsingInstrument(memberName, instrumentName) {
        return stores.catalog.songs.filter((s) =>
            (s.members?.[memberName]?.instruments || []).some((i) => i.name === instrumentName)
        );
    }

    function songsUsingTuning(memberName, instrumentName, tuning) {
        return stores.catalog.songs.filter((s) =>
            (s.members?.[memberName]?.instruments || []).some((i) =>
                i.name === instrumentName && (i.tuning || []).includes(tuning)
            )
        );
    }

    function songsUsingTechnique(memberName, instrumentName, technique) {
        return stores.catalog.songs.filter((s) =>
            (s.members?.[memberName]?.instruments || []).some((i) =>
                i.name === instrumentName && (Array.isArray(i.picking) ? i.picking : []).includes(technique)
            )
        );
    }

    async function removeBandMember(memberName) {
        const usedIn = songsUsingMember(memberName);
        const names = usedIn.slice(0, 5).map((s) => s.name).join(", ");
        const extra = usedIn.length > 5 ? ` and ${usedIn.length - 5} more` : "";
        const confirmed = await stores.ui.requestConfirm({
            title: `Remove "${memberName}" from the band?`,
            message:
                usedIn.length > 0
                    ? `${memberName} is referenced in ${usedIn.length} song${usedIn.length === 1 ? "" : "s"} (${names}${extra}). Existing songs keep their setups, but new setlists won't account for ${memberName}.`
                    : "",
            confirmLabel: "Remove",
        });
        if (!confirmed) return;
        const sessionAlive = stores.accounts.sessionGuard();
        try {
            await stores.connection.withSync("Removing member", () => repo.deleteMember(memberName));
            if (!sessionAlive()) return;
            stores.catalog.removeMemberLocal(memberName);
            if (expandedBandMember === memberName) expandedBandMember = "";
            stores.ui.toastInfo(`Removed "${memberName}".`);
        } catch (error) {
            stores.ui.toastError(error?.message || "Could not remove member.");
        }
    }

    async function addBandMemberInstrument(memberName, instrumentName) {
        const clean = String(instrumentName ?? "").trim();
        if (!clean) { stores.ui.toastError("Type an instrument name first."); return false; }
        const member = stores.catalog.bandMembers[memberName] || { instruments: [] };
        const current = member.instruments || [];
        if (current.some((i) => i.name === clean)) { stores.ui.toastError("Already on this member."); return false; }
        const updated = { ...member, instruments: current.concat({ name: clean, tunings: [], defaultTuning: "", techniques: [], defaultTechnique: "" }) };
        if (await persistMemberEdit(memberName, updated)) {
            stores.ui.toastInfo(`Added ${clean} for ${memberName}.`);
            return true;
        }
        return false;
    }

    async function removeBandMemberInstrument(memberName, instrumentName) {
        const usedIn = songsUsingInstrument(memberName, instrumentName);
        const names = usedIn.slice(0, 5).map((s) => s.name).join(", ");
        const extra = usedIn.length > 5 ? ` and ${usedIn.length - 5} more` : "";
        const confirmed = await stores.ui.requestConfirm({
            title: `Remove "${instrumentName}" from ${memberName}?`,
            message:
                usedIn.length > 0
                    ? `It's used in ${usedIn.length} song${usedIn.length === 1 ? "" : "s"} (${names}${extra}). Existing songs keep it, but it won't be offered for new songs.`
                    : "",
            confirmLabel: "Remove",
        });
        if (!confirmed) return;
        const member = stores.catalog.bandMembers[memberName] || { instruments: [] };
        const updated = { ...member, instruments: (member.instruments || []).filter((i) => i.name !== instrumentName) };
        if (await persistMemberEdit(memberName, updated)) stores.ui.toastInfo(`Removed ${instrumentName} from ${memberName}.`);
    }

    // Ensure a member and instrument exist in band members (creates them if missing)
    async function ensureBandInstrument(memberName, instrumentName) {
        if (!memberName || !instrumentName) return;
        let dirty = false;
        let member = clone(stores.catalog.bandMembers[memberName] || null);
        if (!member) {
            member = { instruments: [] };
            dirty = true;
        }
        if (!member.instruments) member.instruments = [];
        if (!member.instruments.find((i) => i.name === instrumentName)) {
            member.instruments.push({ name: instrumentName, tunings: [], defaultTuning: "", techniques: [], defaultTechnique: "" });
            dirty = true;
        }
        if (dirty) await persistMemberEdit(memberName, member);
    }

    async function addTuningChoice(memberName, instrumentName, tuning) {
        const clean = String(tuning ?? "").trim();
        if (!clean) { stores.ui.toastError("Type a tuning name first."); return ""; }
        await ensureBandInstrument(memberName, instrumentName);
        const member = stores.catalog.bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const current = currentInstruments.find((i) => i.name === instrumentName);
        if ((current?.tunings || []).includes(clean)) { stores.ui.toastError("Already exists."); return ""; }
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : { ...i, tunings: (i.tunings || []).concat(clean) }) };
        if (await persistMemberEdit(memberName, updated)) {
            stores.ui.toastInfo(`Added "${clean}" to ${instrumentName}.`);
            return clean;
        }
        return "";
    }

    async function removeTuningChoice(memberName, instrumentName, tuning) {
        const usedIn = songsUsingTuning(memberName, instrumentName, tuning);
        if (usedIn.length > 0) {
            const names = usedIn.slice(0, 5).map((s) => s.name).join(", ");
            const extra = usedIn.length > 5 ? ` and ${usedIn.length - 5} more` : "";
            const confirmed = await stores.ui.requestConfirm({
                title: `Remove "${tuning}" from ${instrumentName}?`,
                message: `It's used in ${usedIn.length} song${usedIn.length === 1 ? "" : "s"} (${names}${extra}). Existing songs keep it, but it won't be offered for new songs.`,
                confirmLabel: "Remove",
            });
            if (!confirmed) return;
        }
        const member = stores.catalog.bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : {
            ...i, tunings: (i.tunings || []).filter((t) => t !== tuning),
            defaultTuning: i.defaultTuning === tuning ? "" : (i.defaultTuning || "")
        }) };
        if (await persistMemberEdit(memberName, updated)) stores.ui.toastInfo(`Removed "${tuning}" from ${instrumentName}.`);
    }

    async function setMemberDefaultInstrument(memberName, instrumentName) {
        const member = stores.catalog.bandMembers[memberName];
        if (!member) return;
        const updated = { ...member, defaultInstrument: instrumentName };
        if (await persistMemberEdit(memberName, updated)) {
            stores.ui.toastInfo(instrumentName ? `Default instrument set to "${instrumentName}".` : `Cleared default instrument.`);
        }
    }

    async function setInstrumentDefaultTuning(memberName, instrumentName, defaultTuning) {
        const member = stores.catalog.bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : { ...i, defaultTuning }) };
        if (await persistMemberEdit(memberName, updated)) {
            stores.ui.toastInfo(defaultTuning ? `Default set to "${defaultTuning}".` : `Cleared default tuning.`);
        }
    }

    async function addTechniqueChoice(memberName, instrumentName, technique) {
        const clean = String(technique ?? "").trim();
        if (!clean) { stores.ui.toastError("Type a technique name first."); return ""; }
        await ensureBandInstrument(memberName, instrumentName);
        const member = stores.catalog.bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const current = currentInstruments.find((i) => i.name === instrumentName);
        if ((current?.techniques || []).includes(clean)) { stores.ui.toastError("Already exists."); return ""; }
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : { ...i, techniques: (i.techniques || []).concat(clean) }) };
        if (await persistMemberEdit(memberName, updated)) {
            stores.ui.toastInfo(`Added "${clean}" technique to ${instrumentName}.`);
            return clean;
        }
        return "";
    }

    async function removeTechniqueChoice(memberName, instrumentName, technique) {
        const usedIn = songsUsingTechnique(memberName, instrumentName, technique);
        if (usedIn.length > 0) {
            const names = usedIn.slice(0, 5).map((s) => s.name).join(", ");
            const extra = usedIn.length > 5 ? ` and ${usedIn.length - 5} more` : "";
            const confirmed = await stores.ui.requestConfirm({
                title: `Remove "${technique}" from ${instrumentName}?`,
                message: `It's used in ${usedIn.length} song${usedIn.length === 1 ? "" : "s"} (${names}${extra}). Existing songs keep it, but it won't be offered for new songs.`,
                confirmLabel: "Remove",
            });
            if (!confirmed) return;
        }
        const member = stores.catalog.bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : {
            ...i, techniques: (i.techniques || []).filter((t) => t !== technique),
            defaultTechnique: i.defaultTechnique === technique ? "" : (i.defaultTechnique || "")
        }) };
        if (await persistMemberEdit(memberName, updated)) stores.ui.toastInfo(`Removed "${technique}" technique from ${instrumentName}.`);
    }

    async function setInstrumentDefaultTechnique(memberName, instrumentName, defaultTechnique) {
        const member = stores.catalog.bandMembers[memberName] || { instruments: [] };
        const currentInstruments = member.instruments || [];
        const updated = { ...member, instruments: currentInstruments.map((i) => i.name !== instrumentName ? i : { ...i, defaultTechnique }) };
        if (await persistMemberEdit(memberName, updated)) {
            stores.ui.toastInfo(defaultTechnique ? `Default technique set to "${defaultTechnique}".` : `Cleared default technique.`);
        }
    }

    // ---- performance summary ----
    function performanceSummary(performance) {
        return Object.keys(performance || {}).sort().map((member) => {
            const setup = performance[member];
            const details = [];
            if (setup.instrument) details.push(setup.instrument);
            if (setup.tuning) details.push(setup.tuning);
            if (setup.capo) details.push(`capo ${setup.capo}`);
            const techniques = Array.isArray(setup.picking) ? setup.picking : (setup.picking ? [setup.picking] : []);
            if (techniques.length) details.push(techniques.join(", "));
            return `${member}: ${details.join(", ") || "default"}`;
        }).join(" | ");
    }

    return {
        cancelConfigSave,
        persistMemberEdit,
        get firstRunBandName() { return firstRunBandName; },
        set firstRunBandName(value) { firstRunBandName = value; },
        get expandedBandMember() { return expandedBandMember; },
        set expandedBandMember(value) { expandedBandMember = value; },
        get bandSubView() { return bandSubView; },
        set bandSubView(value) { bandSubView = value; },
        get editingMemberName() { return editingMemberName; },
        set editingMemberName(value) { editingMemberName = value; },
        get bandMemberEntries() { return bandMemberEntries; },
        get availableMemberNames() { return availableMemberNames; },
        get memberInstrumentChoicesByMember() { return memberInstrumentChoicesByMember; },
        get memberTuningChoicesByMember() { return memberTuningChoicesByMember; },
        get defaultTuningByMemberInstrument() { return defaultTuningByMemberInstrument; },
        get allInstrumentNamesList() { return allInstrumentNamesList; },
        get instrumentTypeCount() { return instrumentTypeCount; },
        finishFirstRun,
        configFieldValue,
        updateConfigField,
        saveConfig,
        addBandMember,
        renameBandMember,
        removeBandMember,
        addBandMemberInstrument,
        removeBandMemberInstrument,
        addTuningChoice,
        removeTuningChoice,
        setMemberDefaultInstrument,
        setInstrumentDefaultTuning,
        addTechniqueChoice,
        removeTechniqueChoice,
        setInstrumentDefaultTechnique,
        performanceSummary,
        songsUsingMember,
        songsUsingInstrument,
        songsUsingTuning,
        songsUsingTechnique,
    };
}
