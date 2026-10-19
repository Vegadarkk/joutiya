import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKUP_COLLECTIONS } from "@/lib/backup/export";

// The incremental backup of a subcollection is a collectionGroup range query on its time field:
// Firestore needs a collection-group single-field index for it (the emulator never asks).

interface Override {
  collectionGroup: string;
  fieldPath: string;
  indexes: { queryScope: string; order?: string }[];
}

describe("backup incremental indexes", () => {
  const file = JSON.parse(readFileSync(new URL("../../firestore.indexes.json", import.meta.url), "utf8")) as { fieldOverrides: Override[] };

  it("declares a collection-group index on the time field of every group collection with incrementals", () => {
    const grouped = BACKUP_COLLECTIONS.filter((collection) => collection.scope === "group" && collection.timeField);
    expect(grouped.map((collection) => collection.id).sort()).toEqual(["favorites", "savedSearches"]);
    for (const collection of grouped) {
      const override = file.fieldOverrides.find((o) => o.collectionGroup === collection.id && o.fieldPath === collection.timeField);
      expect(override?.indexes, collection.id).toContainEqual({ order: "ASCENDING", queryScope: "COLLECTION_GROUP" });
    }
  });
});
