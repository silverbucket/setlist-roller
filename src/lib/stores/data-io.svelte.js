import { normalizeAppConfig, normalizeMemberRecord, normalizeSongRecord } from "../defaults.js";
import { migrator } from "../migrations.js";
import { clone, nowIso, tryParseJson } from "../utils.js";

// Shared catalog state is accessed through getters so account changes and
// local mutations remain visible. Writes use the app's existing mirror helpers.
export function createDataIoStore(repo, {
    state, storageKey, sessionGuard, withSync,
    upsertSongLocal, setConfigLocal, upsertMemberLocal, upsertSetlistLocal,
    setBootstrapLocal, toastInfo, toastError,
}) {
    let importMode = $state("skip");
    let importFile = $state(null);

    // ---- import/export ----
    function buildExportPayload() {
        const currentSaved = state.savedSetlists || [];
        return {
            app: "setlist-roller", schemaVersion: 2, exportedAt: nowIso(),
            songs: state.songs.map(normalizeSongRecord),
            config: clone(state.appConfig),
            bandMembers: clone(state.bandMembers),
            savedSetlists: clone(currentSaved),
            meta: {
                bandName: state.appConfig?.bandName || "",
                songCount: state.songs.length,
                savedSetlistCount: currentSaved.length,
            }
        };
    }

    function exportAllData() {
        const payload = buildExportPayload();
        const safeName = (state.appConfig?.bandName || "band-setlist").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "band-setlist";
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${safeName}-data.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        toastInfo("Exported the whole catalog.");
    }

    function normalizeImportPayload(payload) {
        if (Array.isArray(payload)) {
            return { payloadType: "songs-array", songs: payload.map(normalizeSongRecord), config: null, bandMembers: null, savedSetlists: null };
        }
        if (payload && Array.isArray(payload.songs)) {
            // Extract old-format members BEFORE normalizeAppConfig strips them
            let importedMembers = payload.bandMembers || null;
            if (!importedMembers && payload.config?.band?.members && Object.keys(payload.config.band.members).length > 0) {
                importedMembers = clone(payload.config.band.members);
            }
            const config = payload.config ? normalizeAppConfig({
                ...clone(payload.config), bandName: payload.config.bandName || state.appConfig?.bandName || "", updatedAt: nowIso()
            }) : null;
            // Run rs-migrate on config to strip members
            const migratedConfig = config ? migrator.migrateDocument("config", config) : null;
            return {
                payloadType: "full-export",
                songs: payload.songs.map(normalizeSongRecord),
                config: migratedConfig,
                bandMembers: importedMembers,
                savedSetlists: Array.isArray(payload.savedSetlists)
                    ? payload.savedSetlists.map((s) => migrator.migrateDocument("setlists", s))
                    : null,
            };
        }
        if (payload?.general && payload.show && payload.props) {
            return {
                payloadType: "config-object", songs: [],
                config: normalizeAppConfig({ ...clone(payload), bandName: payload.bandName || state.appConfig?.bandName || "", updatedAt: nowIso() }),
                bandMembers: null,
                savedSetlists: null,
            };
        }
        throw new Error("Unsupported JSON format.");
    }

    async function importFromFile() {
        if (!importFile) { toastError("Choose a JSON file first."); return; }
        const sessionAlive = sessionGuard();
        const abortIfSwitched = () => {
            if (!sessionAlive()) throw new Error("Import stopped — the account changed mid-way.");
        };
        try {
            state.busyMessage = "Importing...";
            const text = await importFile.text();
            const payload = JSON.parse(text);
            const existing = new Map(state.songs.map((s) => [s.id, s]));
            const imported = normalizeImportPayload(payload);
            let ws = 0;

            await withSync("Importing data", async () => {
                for (const s of imported.songs) {
                    if (importMode === "skip" && existing.has(s.id)) continue;
                    const saved = await repo.putSong(s);
                    abortIfSwitched();
                    upsertSongLocal(saved); ws++;
                }
                if (imported.config && (importMode === "overwrite" || !state.appConfig)) {
                    const savedConfig = await repo.putConfig(imported.config);
                    abortIfSwitched();
                    setConfigLocal(savedConfig);
                }
                // Import members
                if (imported.bandMembers) {
                    for (const [name, data] of Object.entries(imported.bandMembers)) {
                        const savedMember = await repo.putMember(name, normalizeMemberRecord(data));
                        abortIfSwitched();
                        upsertMemberLocal(name, savedMember);
                    }
                }
                // Import setlists
                if (imported.savedSetlists && imported.savedSetlists.length > 0) {
                    for (const entry of imported.savedSetlists) {
                        const savedSetlist = await repo.putSetlist(migrator.migrateDocument("setlists", entry));
                        abortIfSwitched();
                        upsertSetlistLocal(savedSetlist);
                    }
                }
                const savedBootstrap = await repo.putBootstrapMeta({
                    source: "uploaded-json", payloadType: imported.payloadType, mode: importMode,
                    fileName: importFile?.name || null, importedSongs: ws
                });
                abortIfSwitched();
                setBootstrapLocal(savedBootstrap);
            });

            const parts = [`${ws} song${ws === 1 ? "" : "s"}`];
            if (imported.savedSetlists?.length) parts.push(`${imported.savedSetlists.length} saved setlist${imported.savedSetlists.length === 1 ? "" : "s"}`);
            if (imported.bandMembers) parts.push(`${Object.keys(imported.bandMembers).length} member${Object.keys(imported.bandMembers).length === 1 ? "" : "s"}`);
            toastInfo(`Imported ${parts.join(", ")}.`);
        } catch (error) {
            toastError(error?.message || "Import failed.");
        } finally {
            state.busyMessage = "";
        }
    }

    // ---- migrations ----
    async function runMigrations() {
        const sessionAlive = sessionGuard();
        // Migrate config: read raw config to check for band.members before normalization strips them
        const rawConfig = await repo.getRawConfig();
        if (!sessionAlive()) return;
        if (rawConfig?.band?.members && Object.keys(rawConfig.band.members).length > 0) {
            // Extract members from old config and write only those not already migrated
            for (const [name, data] of Object.entries(rawConfig.band.members)) {
                if (!state.bandMembers[name]) {
                    const savedMember = await repo.putMember(name, normalizeMemberRecord(data));
                    if (!sessionAlive()) return;
                    upsertMemberLocal(name, savedMember);
                }
            }
            // Run rs-migrate on the raw config to strip band.members, then save
            const migratedConfig = migrator.migrateDocument("config", rawConfig);
            if (migratedConfig !== rawConfig) {
                const savedConfig = await repo.putConfig(migratedConfig);
                if (!sessionAlive()) return;
                setConfigLocal(savedConfig);
            }
        }

        // Migrate localStorage setlists to remoteStorage
        if (typeof localStorage !== "undefined") {
            const localKey = storageKey("saved-sets");
            const raw = localStorage.getItem(localKey);
            if (raw) {
                const localSets = tryParseJson(raw, []) || [];
                if (localSets.length > 0) {
                    // Normalize via rs-migrate before uploading
                    const remoteIds = new Set(state.savedSetlists.map((s) => s.id));
                    const toMigrate = localSets.filter((s) => !remoteIds.has(s.id));
                    for (const entry of toMigrate) {
                        const normalized = migrator.migrateDocument("setlists", entry);
                        const savedSetlist = await repo.putSetlist(normalized);
                        if (!sessionAlive()) return;
                        upsertSetlistLocal(savedSetlist);
                    }
                }
                localStorage.removeItem(localKey);
            }
        }
    }

    return {
        get importMode() { return importMode; },
        set importMode(value) { importMode = value; },
        get importFile() { return importFile; },
        set importFile(value) { importFile = value; },
        exportAllData,
        importFromFile,
        runMigrations,
    };
}
