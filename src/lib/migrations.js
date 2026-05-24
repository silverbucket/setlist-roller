import { createMigrator } from "rs-migrate";

export const migrator = createMigrator({ versionField: "schemaVersion" });

// --- config ---
migrator.register({
    version: 2, // existing schemaVersion is 1
    collection: "config",
    description: "Remove band.members and show.members (moved to individual member files)",
    transform(doc) {
        if (doc.band) delete doc.band.members;
        if (doc.show) delete doc.show.members;
        return doc;
    },
});

// --- setlists ---
migrator.register({
    version: 1,
    collection: "setlists",
    description: "Normalize saved setlist shape for remoteStorage",
    transform(doc) {
        doc.songs = doc.songs || [];
        doc.songNames = doc.songNames || doc.songs.map((s) => s.name || s.title || "?");
        doc.songCount = doc.songCount || doc.songs.length;
        doc.savedAt = doc.savedAt || doc.createdAt || "";
        return doc;
    },
});

migrator.register({
    version: 2,
    collection: "setlists",
    description: "Lean shape — songs reference catalog by songId; drop embedded catalog fields and derived summary",
    transform(doc) {
        if (Array.isArray(doc.songs)) {
            doc.songs = doc.songs.map((s) => ({
                songId: s.songId || s.id,
                performance: s.performance || {},
            }));
        }
        if (doc.summary) {
            for (const flag of ["minimumsRelaxed", "openerFilterRelaxed", "closerFilterRelaxed"]) {
                if (doc.summary[flag] !== undefined && doc[flag] === undefined) {
                    doc[flag] = doc.summary[flag];
                }
            }
            delete doc.summary;
        }
        delete doc.songNames;
        delete doc.songCount;
        return doc;
    },
});
