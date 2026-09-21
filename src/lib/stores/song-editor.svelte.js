import { blankSong, memberDefaultRig, normalizeSongRecord, rigEqualsDefault, songsReferencingKeepApart, syncKeepApartLinks } from "../defaults.js";
import { clone, nowIso, uid } from "../utils.js";

// Song drafts, staged vocabulary, and catalog save/delete actions.
export function createSongEditorStore(repo, stores) {
    let editorSong = $state(null);
    let selectedSongId = $state("");
    let editReturnView = $state("");

    // ---- song editor ----
    // Songs only store deviations from each member's default rig, so a new
    // song starts with NO member entries — every band member implicitly
    // plays their usual setup. The editor offers per-member overrides.
    function openNewSong() {
        editorSong = blankSong();
        selectedSongId = "";
        editorVocabAdds = {};
    }

    function openSong(song) {
        editorSong = normalizeSongRecord(song);
        selectedSongId = editorSong.id;
        editorVocabAdds = {};
    }

    function closeEditor() {
        const returnTo = editReturnView;
        editorSong = null;
        selectedSongId = "";
        editReturnView = "";
        editorVocabAdds = {};
        if (returnTo) stores.ui.navigate(returnTo);
    }

    // ---- staged vocabulary adds ----
    // New instruments/tunings/techniques typed inside the song editor are
    // STAGED here and only written to the band config when the song is
    // saved. (Previously they persisted to remoteStorage the moment they
    // were typed — abandoning the song still left its vocabulary behind.)
    let editorVocabAdds = $state({});

    function stagedInstrumentAdds(memberName) {
        return Object.entries(editorVocabAdds[memberName] || {})
            .filter(([, adds]) => adds.isNew)
            .map(([name]) => name);
    }

    function stagedTuningAdds(memberName, instrumentName) {
        return editorVocabAdds[memberName]?.[instrumentName]?.tunings || [];
    }

    function stagedTechniqueAdds(memberName, instrumentName) {
        return editorVocabAdds[memberName]?.[instrumentName]?.techniques || [];
    }

    function stageVocabAdd(memberName, instrumentName, kind, value) {
        const clean = String(value ?? "").trim();
        if (!memberName || !instrumentName || (kind !== "instrument" && !clean)) return "";
        const memberAdds = { ...(editorVocabAdds[memberName] || {}) };
        const instAdds = {
            isNew: false,
            tunings: [],
            techniques: [],
            ...(memberAdds[instrumentName] || {}),
        };
        if (kind === "instrument") instAdds.isNew = true;
        if (kind === "tuning" && !instAdds.tunings.includes(clean)) {
            instAdds.tunings = [...instAdds.tunings, clean];
        }
        if (kind === "technique" && !instAdds.techniques.includes(clean)) {
            instAdds.techniques = [...instAdds.techniques, clean];
        }
        memberAdds[instrumentName] = instAdds;
        editorVocabAdds = { ...editorVocabAdds, [memberName]: memberAdds };
        return kind === "instrument" ? instrumentName : clean;
    }

    /** Write the staged vocabulary into the band config (at song save). */
    async function applyStagedVocab() {
        for (const [memberName, memberAdds] of Object.entries(editorVocabAdds || {})) {
            let member = clone(stores.catalog.bandMembers[memberName] || null);
            let dirty = false;
            if (!member) {
                member = { instruments: [] };
                dirty = true;
            }
            if (!member.instruments) member.instruments = [];
            for (const [instName, adds] of Object.entries(memberAdds)) {
                let inst = member.instruments.find((i) => i.name === instName);
                if (!inst) {
                    inst = { name: instName, tunings: [], defaultTuning: "", techniques: [], defaultTechnique: "" };
                    member.instruments.push(inst);
                    dirty = true;
                }
                for (const tuning of adds.tunings || []) {
                    if (!inst.tunings.includes(tuning)) {
                        inst.tunings.push(tuning);
                        if (!inst.defaultTuning) inst.defaultTuning = tuning;
                        dirty = true;
                    }
                }
                for (const technique of adds.techniques || []) {
                    if (!inst.techniques.includes(technique)) {
                        inst.techniques.push(technique);
                        dirty = true;
                    }
                }
            }
            if (dirty && !(await stores.band.persistMemberEdit(memberName, member))) return false;
        }
        editorVocabAdds = {};
        return true;
    }

    /**
     * Drop member overrides that add nothing: empty ones and ones equal to
     * the member's default rig. Runs at save so stored songs converge to
     * deviations-only over time.
     */
    function squashDefaultMembers(members) {
        const out = {};
        for (const [name, setup] of Object.entries(members || {})) {
            if ((setup?.instruments || []).length === 0) continue;
            if (stores.catalog.bandMembers[name] && rigEqualsDefault(setup, stores.catalog.bandMembers[name])) continue;
            out[name] = setup;
        }
        return out;
    }

    function updateEditor(mutator) {
        const next = clone(editorSong);
        mutator(next);
        editorSong = next;
    }

    function updateSongField(key, value) {
        updateEditor((s) => { s[key] = value; });
    }

    /**
     * Create a per-song override for a band member, prefilled from their
     * default rig so the user edits from a working starting point.
     */
    function addMember(memberName) {
        if (!memberName) return;
        updateEditor((song) => {
            if (song.members[memberName]) return; // already overridden
            const rig = memberDefaultRig(stores.catalog.bandMembers?.[memberName]);
            song.members[memberName] = rig
                ? clone(rig)
                : { instruments: [{ name: "", tuning: [], capo: 0, picking: [] }] };
        });
    }

    function removeMember(memberName) {
        updateEditor((song) => { delete song.members[memberName]; });
    }

    function addInstrumentOption(memberName) {
        updateEditor((song) => {
            song.members[memberName].instruments.push({
                name: "", tuning: [], capo: 0, picking: []
            });
        });
    }

    function removeInstrumentOption(memberName, index) {
        updateEditor((song) => { song.members[memberName].instruments.splice(index, 1); });
    }

    function instrumentConfigFor(memberName, instrumentName) {
        return (stores.catalog.bandMembers?.[memberName]?.instruments || [])
            .find((i) => i.name === instrumentName) || null;
    }

    function updateInstrumentOption(memberName, index, key, value) {
        updateEditor((song) => {
            const option = song.members[memberName].instruments[index];
            option[key] = value;
            if (key === "name") {
                const instConfig = instrumentConfigFor(memberName, value);
                const defaultTuning = instConfig?.defaultTuning || "";
                option.tuning = defaultTuning ? [defaultTuning] : [];
                option.picking = instConfig?.defaultTechnique ? [instConfig.defaultTechnique] : [];
            }
        });
    }

    /**
     * True when saving/deleting `song` must touch other catalog records to
     * keep the symmetric "keep apart" relation consistent. Because links are
     * stored on both songs, the song's own list names every partner.
     */
    function keepApartCascadeNeeded(song, previous = null) {
        const next = new Set(song?.keepApartFrom || []);
        const prev = new Set(previous?.keepApartFrom || []);
        if (next.size !== prev.size) return true;
        for (const id of next) if (!prev.has(id)) return true;
        return false;
    }

    /**
     * Write each partner record in turn, applying successes locally as they
     * land. Returns the names of partners whose write failed, or null when
     * the session changed mid-way (the caller must stop touching state).
     */
    async function writeKeepApartPartners(partners, sessionAlive) {
        const failed = [];
        for (const other of partners) {
            try {
                const savedOther = await stores.connection.withSync("Saving song", () => repo.putSong(other));
                if (!sessionAlive()) return null;
                stores.catalog.upsertSongLocal(savedOther);
            } catch {
                if (!sessionAlive()) return null;
                failed.push(other.name || other.id);
            }
        }
        return failed;
    }

    function quoteList(names) {
        return names.map((name) => `"${name}"`).join(", ");
    }

    async function saveSong() {
        if (!editorSong || !String(editorSong.name || "").trim()) {
            stores.ui.toastError("Songs need names.");
            return;
        }
        // The keep-apart cascade writes back-references onto partner songs.
        // Until the account's first sync has settled, the in-memory catalog
        // may be partial and a partner could be missed — refuse rather than
        // leave the relation one-sided (same policy as renameBandMember).
        if (!stores.connection.catalogSettled && keepApartCascadeNeeded(editorSong, stores.catalog.songsById.get(editorSong.id))) {
            stores.ui.toastWarn("Still syncing your catalog — try saving the keep-apart change again in a moment.");
            return;
        }
        const sessionAlive = stores.accounts.sessionGuard();
        try {
            stores.ui.busyMessage = `Saving "${editorSong.name}"...`;
            // Vocabulary the user staged in the editor (new instruments,
            // tunings, techniques) lands in the band config first, so the
            // squash below compares against the up-to-date defaults.
            if (!(await applyStagedVocab())) return;
            if (!sessionAlive()) return;
            const saved = await stores.connection.withSync("Saving song", () => repo.putSong({
                ...editorSong,
                members: squashDefaultMembers(editorSong.members),
                updatedAt: nowIso(),
            }));
            if (!sessionAlive()) return;
            stores.catalog.upsertSongLocal(saved);
            // "Keep apart" is symmetric: mirror the link on the partner songs.
            // remoteStorage has no multi-document transactions, so this is
            // best-effort per record (same policy as the member-rename
            // cascade). A missed partner leaves a one-sided link, which the
            // generator and scorer already honour; re-saving this song
            // re-runs the diff and repairs it.
            const failedPartners = await writeKeepApartPartners(syncKeepApartLinks(saved, stores.catalog.songs), sessionAlive);
            if (failedPartners === null) return;
            // No manual setlist sync needed: displayedSetlist re-derives from
            // the catalog automatically when `songs` changes.

            closeEditor();
            if (failedPartners.length) {
                stores.ui.toastWarn(
                    `Saved "${saved.name}", but couldn't update keep-apart on ${quoteList(failedPartners)}. ` +
                        "The rule still applies; re-save this song to retry.",
                );
            } else {
                stores.ui.toastInfo(`Saved "${saved.name}".`);
            }
        } catch (error) {
            stores.ui.toastError(error?.message || "Could not save.");
        } finally {
            stores.ui.busyMessage = "";
        }
    }

    function duplicateSong(song) {
        const copy = normalizeSongRecord({
            ...clone(song), id: uid("song"), name: `${song.name} (Copy)`,
            createdAt: nowIso(), updatedAt: nowIso()
        });
        editorSong = copy;
        selectedSongId = "";
        stores.ui.toastInfo(`Duplicated "${song.name}".`);
    }

    async function deleteSong(song) {
        const confirmed = await stores.ui.requestConfirm({
            title: `Delete "${song.name}"?`,
            message: "This cannot be undone.",
            confirmLabel: "Delete",
        });
        if (!confirmed) return;
        // Deleting a song scrubs its id from every partner's keepApartFrom.
        // With a partial catalog (first sync still running) a partner not
        // yet loaded would keep a stale reference, so wait for settle.
        // Consult the catalog record, not the caller's object: a bare
        // `{ id, name }` from a list row must not sidestep the guard.
        if (!stores.connection.catalogSettled && keepApartCascadeNeeded(stores.catalog.songsById.get(String(song.id)) ?? song)) {
            stores.ui.toastWarn("Still syncing your catalog — try deleting again in a moment.");
            return;
        }
        const sessionAlive = stores.accounts.sessionGuard();
        try {
            stores.ui.busyMessage = `Deleting "${song.name}"...`;
            await stores.connection.withSync("Removing song", () => repo.deleteSong(song.id));
            if (!sessionAlive()) return;
            stores.catalog.removeSongLocal(song.id);
            // Best-effort scrub of partner references; see saveSong. A
            // stale id is inert (unknown ids are ignored everywhere).
            const failedPartners = await writeKeepApartPartners(songsReferencingKeepApart(song.id, stores.catalog.songs), sessionAlive);
            if (failedPartners === null) return;
            if (editorSong?.id === song.id) closeEditor();
            if (failedPartners.length) {
                stores.ui.toastWarn(`Deleted "${song.name}", but couldn't clear its keep-apart link on ${quoteList(failedPartners)}.`);
            } else {
                stores.ui.toastInfo(`Deleted "${song.name}".`);
            }
        } catch (error) {
            stores.ui.toastError(error?.message || "Could not delete.");
        } finally {
            stores.ui.busyMessage = "";
        }
    }

    return {
        get selectedSongId() { return selectedSongId; },
        set selectedSongId(value) { selectedSongId = value; },
        get editorSong() { return editorSong; },
        set editorSong(value) { editorSong = value; },
        closeEditor,
        openNewSong,
        openSong,
        stageVocabAdd,
        stagedInstrumentAdds,
        stagedTuningAdds,
        stagedTechniqueAdds,
        get editorVocabAdds() { return editorVocabAdds; },
        get editReturnView() { return editReturnView; },
        set editReturnView(value) { editReturnView = value; },
        updateSongField,
        addMember,
        removeMember,
        addInstrumentOption,
        removeInstrumentOption,
        updateInstrumentOption,
        saveSong,
        duplicateSong,
        deleteSong,
    };
}
