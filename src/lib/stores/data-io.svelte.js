import { DEFAULT_APP_CONFIG, normalizeAppConfig, normalizeMemberRecord, normalizeSongRecord } from "../defaults.js";
import { migrator } from "../migrations.js";
import { clone, nowIso, tryParseJson } from "../utils.js";

// Shared catalog state is accessed through getters so account changes and
// local mutations remain visible. Writes use the app's existing mirror helpers.
export function createDataIoStore(repo, stores) {
    let importMode = $state("skip");
    let importFile = $state(null);

    // ---- import/export ----
    function buildExportPayload() {
        const currentSaved = stores.catalog.savedSetlists || [];
        return {
            app: "setlist-roller", schemaVersion: 2, exportedAt: nowIso(),
            songs: stores.catalog.songs.map(normalizeSongRecord),
            config: clone(stores.catalog.appConfig),
            bandMembers: clone(stores.catalog.bandMembers),
            savedSetlists: clone(currentSaved),
            meta: {
                bandName: stores.catalog.appConfig?.bandName || "",
                songCount: stores.catalog.songs.length,
                savedSetlistCount: currentSaved.length,
            }
        };
    }

    function exportAllData() {
        const payload = buildExportPayload();
        const safeName = (stores.catalog.appConfig?.bandName || "band-setlist").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "band-setlist";
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${safeName}-data.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        stores.ui.toastInfo("Exported the whole catalog.");
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
                ...clone(payload.config), bandName: payload.config.bandName || stores.catalog.appConfig?.bandName || "", updatedAt: nowIso()
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
                config: normalizeAppConfig({ ...clone(payload), bandName: payload.bandName || stores.catalog.appConfig?.bandName || "", updatedAt: nowIso() }),
                bandMembers: null,
                savedSetlists: null,
            };
        }
        throw new Error("Unsupported JSON format.");
    }

    async function importFromFile() {
        if (!importFile) { stores.ui.toastError("Choose a JSON file first."); return; }
        const sessionAlive = stores.accounts.sessionGuard();
        const abortIfSwitched = () => {
            if (!sessionAlive()) throw new Error("Import stopped — the account changed mid-way.");
        };
        try {
            stores.ui.busyMessage = "Importing...";
            const text = await importFile.text();
            const payload = JSON.parse(text);
            const existing = new Map(stores.catalog.songs.map((s) => [s.id, s]));
            const imported = normalizeImportPayload(payload);
            let ws = 0;

            await stores.connection.withSync("Importing data", async () => {
                for (const s of imported.songs) {
                    if (importMode === "skip" && existing.has(s.id)) continue;
                    const saved = await repo.putSong(s);
                    abortIfSwitched();
                    stores.catalog.upsertSongLocal(saved); ws++;
                }
                if (imported.config && (importMode === "overwrite" || !stores.catalog.appConfig)) {
                    const savedConfig = await repo.putConfig(imported.config);
                    abortIfSwitched();
                    stores.catalog.setConfigLocal(savedConfig);
                }
                // Import members
                if (imported.bandMembers) {
                    for (const [name, data] of Object.entries(imported.bandMembers)) {
                        const savedMember = await repo.putMember(name, normalizeMemberRecord(data));
                        abortIfSwitched();
                        stores.catalog.upsertMemberLocal(name, savedMember);
                    }
                }
                // Import setlists
                if (imported.savedSetlists && imported.savedSetlists.length > 0) {
                    for (const entry of imported.savedSetlists) {
                        const savedSetlist = await repo.putSetlist(migrator.migrateDocument("setlists", entry));
                        abortIfSwitched();
                        stores.catalog.upsertSetlistLocal(savedSetlist);
                    }
                }
                const savedBootstrap = await repo.putBootstrapMeta({
                    source: "uploaded-json", payloadType: imported.payloadType, mode: importMode,
                    fileName: importFile?.name || null, importedSongs: ws
                });
                abortIfSwitched();
                stores.catalog.setBootstrapLocal(savedBootstrap);
            });

            const parts = [`${ws} song${ws === 1 ? "" : "s"}`];
            if (imported.savedSetlists?.length) parts.push(`${imported.savedSetlists.length} saved setlist${imported.savedSetlists.length === 1 ? "" : "s"}`);
            if (imported.bandMembers) parts.push(`${Object.keys(imported.bandMembers).length} member${Object.keys(imported.bandMembers).length === 1 ? "" : "s"}`);
            stores.ui.toastInfo(`Imported ${parts.join(", ")}.`);
        } catch (error) {
            stores.ui.toastError(error?.message || "Import failed.");
        } finally {
            stores.ui.busyMessage = "";
        }
    }

    // ---- migrations ----
    async function runMigrations() {
        const sessionAlive = stores.accounts.sessionGuard();
        // Migrate config: read raw config to check for band.members before normalization strips them
        const rawConfig = await repo.getRawConfig();
        if (!sessionAlive()) return;
        if (rawConfig?.band?.members && Object.keys(rawConfig.band.members).length > 0) {
            // Extract members from old config and write only those not already migrated
            for (const [name, data] of Object.entries(rawConfig.band.members)) {
                if (!stores.catalog.bandMembers[name]) {
                    const savedMember = await repo.putMember(name, normalizeMemberRecord(data));
                    if (!sessionAlive()) return;
                    stores.catalog.upsertMemberLocal(name, savedMember);
                }
            }
            // Run rs-migrate on the raw config to strip band.members, then save
            const migratedConfig = migrator.migrateDocument("config", rawConfig);
            if (migratedConfig !== rawConfig) {
                const savedConfig = await repo.putConfig(migratedConfig);
                if (!sessionAlive()) return;
                stores.catalog.setConfigLocal(savedConfig);
            }
        }

        // Migrate localStorage setlists to remoteStorage
        if (typeof localStorage !== "undefined") {
            const localKey = stores.accounts.storageKey("saved-sets");
            const raw = localStorage.getItem(localKey);
            if (raw) {
                const localSets = tryParseJson(raw, []) || [];
                if (localSets.length > 0) {
                    // Normalize via rs-migrate before uploading
                    const remoteIds = new Set(stores.catalog.savedSetlists.map((s) => s.id));
                    const toMigrate = localSets.filter((s) => !remoteIds.has(s.id));
                    for (const entry of toMigrate) {
                        const normalized = migrator.migrateDocument("setlists", entry);
                        const savedSetlist = await repo.putSetlist(normalized);
                        if (!sessionAlive()) return;
                        stores.catalog.upsertSetlistLocal(savedSetlist);
                    }
                }
                localStorage.removeItem(localKey);
            }
        }
    }

    async function deleteAllData() {
        // Typed-name verification instead of the old chained double
        // window.confirm (near-identical wording made it easy to click
        // through both without reading).
        const confirmed = await stores.ui.requestConfirm({
            title: "Delete ALL data?",
            message:
                "Every song, saved setlist, band member, and setting will be permanently deleted — locally and from your remoteStorage. This cannot be undone.",
            confirmLabel: "Delete everything",
            requireText: stores.catalog.appConfig?.bandName || "",
        });
        if (!confirmed) return;
        const sessionAlive = stores.accounts.sessionGuard();
        // Bail out cleanly if the user switches accounts mid-wipe: any
        // further deletes would run against the NEW account's storage paths.
        const abortIfSwitched = () => {
            if (!sessionAlive()) throw new Error("Deletion stopped — the account changed mid-way.");
        };
        try {
            stores.ui.busyMessage = "Deleting everything...";
            // Delete all songs from RS. List from the repo as well as memory
            // so songs that never made it into the in-memory catalog (e.g.
            // mid-first-sync) are still deleted.
            const { songs: listedSongs } = await repo.listSongs();
            const allSongIds = new Set([...stores.catalog.songs.map((s) => s.id), ...listedSongs.map((s) => s.id)]);
            for (const id of allSongIds) {
                abortIfSwitched();
                await repo.deleteSong(id);
                void stores.accounts.mirror?.deleteSong(id).catch(() => {});
            }
            // Delete all setlists from RS (list from remote to catch any beyond in-memory state)
            const { setlists: allSetlists } = await repo.listSetlists();
            for (const setlist of allSetlists) {
                abortIfSwitched();
                await repo.deleteSetlist(setlist.id);
                void stores.accounts.mirror?.deleteSetlist(setlist.id).catch(() => {});
            }
            // Delete all members from RS (list from remote to catch any beyond in-memory state)
            const { members: allMembers } = await repo.listMembers();
            for (const name of Object.keys(allMembers)) {
                abortIfSwitched();
                await repo.deleteMember(name);
                void stores.accounts.mirror?.deleteMember(name).catch(() => {});
            }
            // Delete config from RS so first-run triggers on reload
            abortIfSwitched();
            await repo.deleteConfig();
            if (!sessionAlive()) return;
            void stores.accounts.mirror?.deleteKv("config").catch(() => {});
            void stores.accounts.mirror?.deleteKv("bootstrap").catch(() => {});
            // Clear local state
            stores.catalog.appConfig = null;
            stores.catalog.songs = [];
            stores.catalog.bootstrapMeta = null;
            stores.generation.clearGeneratedSetlist();
            stores.generation.setlistLocked = false;
            stores.generation.setlistSaved = false;
            stores.catalog.savedSetlists = [];
            stores.catalog.bandMembers = {};
            stores.generation.persistCurrentSetlist();
            if (stores.songEditor.editorSong) stores.songEditor.closeEditor();
            // Trigger first-run experience: with appConfig now null and the
            // session still connected/synced, the derived showFirstRunPrompt
            // will evaluate to true and the modal will render.
            stores.band.firstRunBandName = "";
            stores.ui.navigate("roll");
            stores.generation.generationOptions = stores.generation.defaultGenerationOptions(DEFAULT_APP_CONFIG);
            stores.generation.persistGenerationOptions();
            stores.ui.toastInfo("All data deleted. Name your band to start fresh.");
        } catch (error) {
            stores.ui.toastError(error?.message || "Could not delete.");
        } finally {
            stores.ui.busyMessage = "";
        }
    }

    return {
        deleteAllData,
        get importMode() { return importMode; },
        set importMode(value) { importMode = value; },
        get importFile() { return importFile; },
        set importFile(value) { importFile = value; },
        exportAllData,
        importFromFile,
        runMigrations,
    };
}
