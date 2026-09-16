import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

const workerMessages = [];

vi.mock("../generator.worker.js?worker", () => ({
    default: class MockGeneratorWorker {
        postMessage(data) {
            workerMessages.push(data);
        }

        terminate() {}
    },
}));

import { accountSlot } from "../accounts.js";
import { createAppStore } from "./app.svelte.js";

function installBrowserEnv() {
    const origIndexedDB = globalThis.indexedDB;
    globalThis.indexedDB = new IDBFactory();
    const origLocalStorage = globalThis.localStorage;
    const origWindow = globalThis.window;
    const map = new Map();
    globalThis.localStorage = {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        clear: () => map.clear(),
    };
    globalThis.window = {
        location: { hash: "" },
        addEventListener: () => {},
        removeEventListener: () => {},
    };
    return () => {
        if (typeof origIndexedDB === "undefined") delete globalThis.indexedDB;
        else globalThis.indexedDB = origIndexedDB;
        if (typeof origLocalStorage === "undefined") delete globalThis.localStorage;
        else globalThis.localStorage = origLocalStorage;
        if (typeof origWindow === "undefined") delete globalThis.window;
        else globalThis.window = origWindow;
    };
}

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function settle(times = 10) {
    for (let i = 0; i < times; i += 1) await flush();
}

function buildRepo() {
    const listeners = new Map();
    let changeHandler = null;
    return {
        on(eventName, handler) {
            if (!listeners.has(eventName)) listeners.set(eventName, new Set());
            listeners.get(eventName).add(handler);
            return () => listeners.get(eventName)?.delete(handler);
        },
        fire(eventName, payload) {
            for (const handler of [...(listeners.get(eventName) || [])]) handler(payload);
        },
        onChange(handler) {
            changeHandler = handler;
            return () => {
                changeHandler = null;
            };
        },
        fireChange(event) {
            changeHandler?.(event);
        },
        loadAll: vi.fn(async () => ({
            songs: [],
            config: null,
            bootstrap: null,
            setlists: [],
            members: {},
            pendingBodies: 0,
            errors: {},
        })),
        getRawConfig: vi.fn(async () => null),
        getSyncInterval: () => 10000,
        setSyncInterval: vi.fn(),
        isConnected: () => true,
        getUserAddress: () => "user@example.com",
        getToken: () => "stub-token",
        connect: vi.fn(),
        disconnect: vi.fn(),
    };
}

afterEach(() => {
    workerMessages.length = 0;
});

describe("extendSetlist worker payload", () => {
    it("clones precedingSong.keepApartFrom so the worker postMessage payload is structured-cloneable", async () => {
        const teardownBrowser = installBrowserEnv();
        globalThis.localStorage.setItem(
            accountSlot("user@example.com").key("current-set"),
            JSON.stringify({
                seed: 1,
                songs: [{ songId: "tail", performance: {} }],
            }),
        );

        const repo = buildRepo();
        const store = createAppStore(repo);
        const teardown = store.init();
        repo.fire("connected");
        await settle();

        for (const [id, name] of [
            ["tail", "Tail"],
            ["s2", "Two"],
            ["s3", "Three"],
            ["s4", "Four"],
            ["s5", "Five"],
        ]) {
            repo.fireChange({
                relativePath: `songs/${id}`,
                origin: "remote",
                newValue: { id, name, keepApartFrom: id === "tail" ? ["s2"] : [] },
            });
        }
        await settle();

        const tail = store.songs.find((song) => song.id === "tail");
        expect(tail).toBeTruthy();
        // Vitest does not proxy $state arrays like the browser runtime, so
        // simulate the production failure mode: a reactive proxy on keepApartFrom.
        const proxiedKeepApart = new Proxy(["s2"], {
            get(target, prop) {
                return target[prop];
            },
        });
        tail.keepApartFrom = proxiedKeepApart;
        expect(() => structuredClone({ keepApartFrom: proxiedKeepApart })).toThrow();

        store.extendSetlist(1);

        expect(workerMessages).toHaveLength(1);
        const payload = workerMessages[0];
        expect(payload.options.precedingSong).toEqual({ id: "tail", keepApartFrom: ["s2"] });
        expect(payload.options.precedingSong.keepApartFrom).not.toBe(tail.keepApartFrom);
        expect(() => structuredClone(payload)).not.toThrow();
        expect(store.isGenerating).toBe(true);

        teardown();
        teardownBrowser();
    });
});
