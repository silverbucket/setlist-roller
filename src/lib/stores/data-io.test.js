import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppStore } from "./app.svelte.js";
import { createDataIoStore } from "./data-io.svelte.js";

function harness() {
    const state = { songs: [], appConfig: null, bandMembers: {}, savedSetlists: [], busyMessage: "" };
    const repo = {
        putSong: vi.fn(async (song) => song),
        putConfig: vi.fn(async (config) => config),
        putMember: vi.fn(async (_name, member) => member),
        putSetlist: vi.fn(async (setlist) => setlist),
        putBootstrapMeta: vi.fn(async (meta) => meta),
        getRawConfig: vi.fn(async () => null),
    };
    let session = 0;
    const dependencies = {
        state,
        storageKey: (key) => `account:${key}`,
        sessionGuard: () => {
            const started = session;
            return () => session === started;
        },
        withSync: async (_label, action) => action(),
        upsertSongLocal: vi.fn(),
        setConfigLocal: vi.fn(),
        upsertMemberLocal: vi.fn(),
        upsertSetlistLocal: vi.fn(),
        setBootstrapLocal: vi.fn(),
        toastInfo: vi.fn(),
        toastError: vi.fn(),
    };
    const store = createDataIoStore(repo, dependencies);
    return { store, repo, state, dependencies, switchAccount: () => session++ };
}

function file(payload) {
    return { name: "catalog.json", text: async () => JSON.stringify(payload) };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("data I/O store", () => {
    it("keeps the app context import accessors and local catalog updates working", async () => {
        vi.useFakeTimers();
        const repo = {
            putSong: vi.fn(async (song) => song),
            putBootstrapMeta: vi.fn(async (meta) => meta),
        };
        const app = createAppStore(repo);
        const otherApp = createAppStore(repo);
        expect(app.importMode).toBe("skip");
        app.importFile = file([{ id: "song-1", name: "First" }]);
        await app.importFromFile();
        expect(app.songs[0].name).toBe("First");
        app.importMode = "overwrite";
        app.importFile = file([{ id: "song-1", name: "Updated" }]);
        await app.importFromFile();
        expect(app.songs).toHaveLength(1);
        expect(app.songs[0].name).toBe("Updated");
        expect(app.importFile.name).toBe("catalog.json");
        expect(app.busyMessage).toBe("");
        expect(otherApp.importMode).toBe("skip");
        expect(otherApp.importFile).toBeNull();
    });

    it("reads the current catalog and import mode after store creation", async () => {
        const { store, repo, state } = harness();
        state.songs = [{ id: "existing", name: "Original" }];
        store.importFile = file([
            { id: "existing", name: "Replacement" },
            { id: "new", name: "New" },
        ]);
        await store.importFromFile();
        expect(repo.putSong.mock.calls.map(([song]) => song.id)).toEqual(["new"]);
        repo.putSong.mockClear();
        store.importMode = "overwrite";
        await store.importFromFile();
        expect(repo.putSong.mock.calls.map(([song]) => song.id)).toEqual(["existing", "new"]);
    });

    it("imports legacy members, config and setlists through local mutation helpers", async () => {
        const { store, repo, dependencies } = harness();
        store.importFile = file({
            songs: [{ id: "song", name: "Song" }],
            config: { bandName: "Band", band: { members: { Alice: { instruments: {} } } } },
            savedSetlists: [{ id: "set", songs: [{ id: "song", name: "Song" }] }],
        });
        await store.importFromFile();
        expect(dependencies.toastError).not.toHaveBeenCalled();
        expect(dependencies.upsertSongLocal).toHaveBeenCalledWith(await repo.putSong.mock.results[0].value);
        expect(dependencies.setConfigLocal).toHaveBeenCalledWith(await repo.putConfig.mock.results[0].value);
        expect(dependencies.upsertMemberLocal).toHaveBeenCalledWith(
            "Alice",
            await repo.putMember.mock.results[0].value,
        );
        expect(dependencies.upsertSetlistLocal).toHaveBeenCalledWith(await repo.putSetlist.mock.results[0].value);
        expect(dependencies.setBootstrapLocal).toHaveBeenCalledWith(expect.objectContaining({ importedSongs: 1 }));
    });

    it("discards an import response when the account changes during a write", async () => {
        const { store, repo, state, dependencies, switchAccount } = harness();
        repo.putSong.mockImplementation(async (song) => {
            switchAccount();
            return song;
        });
        store.importFile = file([{ id: "one" }, { id: "two" }]);
        await store.importFromFile();
        expect(repo.putSong).toHaveBeenCalledTimes(1);
        expect(dependencies.upsertSongLocal).not.toHaveBeenCalled();
        expect(repo.putBootstrapMeta).not.toHaveBeenCalled();
        expect(dependencies.toastError).toHaveBeenCalledWith("Import stopped — the account changed mid-way.");
        expect(state.busyMessage).toBe("");
    });

    it("reports missing and invalid files and clears the busy message", async () => {
        const { store, state, dependencies } = harness();
        await store.importFromFile();
        expect(dependencies.toastError).toHaveBeenLastCalledWith("Choose a JSON file first.");
        store.importFile = file({ unsupported: true });
        await store.importFromFile();
        expect(dependencies.toastError).toHaveBeenLastCalledWith("Unsupported JSON format.");
        expect(state.busyMessage).toBe("");
    });

    it("exports the latest shared state", async () => {
        const { store, state } = harness();
        const link = { click: vi.fn(), remove: vi.fn() };
        vi.stubGlobal("document", { createElement: () => link, body: { appendChild: vi.fn() } });
        let exported;
        vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
            exported = blob;
            return "blob:export";
        });
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        state.appConfig = { bandName: "Current Band" };
        state.songs = [{ id: "song", name: "Current song" }];
        state.bandMembers = { Alice: { instruments: {} } };
        state.savedSetlists = [{ id: "set", songs: [{ songId: "song" }] }];
        store.exportAllData();
        const payload = JSON.parse(await exported.text());
        expect(payload).toMatchObject({
            schemaVersion: 2,
            config: state.appConfig,
            bandMembers: state.bandMembers,
            savedSetlists: state.savedSetlists,
            meta: { bandName: "Current Band", songCount: 1, savedSetlistCount: 1 },
        });
        expect(payload.songs[0].id).toBe("song");
        expect(link.download).toBe("current-band-data.json");
        expect(link.click).toHaveBeenCalled();
        expect(revoke).toHaveBeenCalledWith("blob:export");
    });

    it("migrates only missing legacy members and account-scoped setlists", async () => {
        const { store, repo, state, dependencies } = harness();
        state.bandMembers = { Alice: { instruments: {} } };
        state.savedSetlists = [{ id: "existing" }];
        repo.getRawConfig.mockResolvedValue({ band: { members: { Alice: {}, Bob: {} } } });
        const localStorage = {
            getItem: vi.fn(() =>
                JSON.stringify([
                    { id: "existing", songs: [] },
                    { id: "new", songs: [] },
                ]),
            ),
            removeItem: vi.fn(),
        };
        vi.stubGlobal("localStorage", localStorage);
        await store.runMigrations();
        expect(repo.putMember).toHaveBeenCalledTimes(1);
        expect(repo.putMember.mock.calls[0][0]).toBe("Bob");
        expect(dependencies.setConfigLocal).toHaveBeenCalled();
        expect(repo.putSetlist).toHaveBeenCalledTimes(1);
        expect(repo.putSetlist.mock.calls[0][0].id).toBe("new");
        expect(localStorage.getItem).toHaveBeenCalledWith("account:saved-sets");
        expect(localStorage.removeItem).toHaveBeenCalledWith("account:saved-sets");
    });

    it("stops migration when its account session expires", async () => {
        const { store, repo, dependencies, switchAccount } = harness();
        repo.getRawConfig.mockImplementation(async () => {
            switchAccount();
            return { band: { members: { Alice: {} } } };
        });
        await store.runMigrations();
        expect(repo.putMember).not.toHaveBeenCalled();
        expect(dependencies.setConfigLocal).not.toHaveBeenCalled();
    });
});
