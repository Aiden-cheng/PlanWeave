import type { Migration } from "./types.js";
import { columnExists, tableExists } from "./schemaIntrospection.js";

export const endpointSelectionMigration: Migration = {
  version: 44,
  sql: "",
  before(database) {
    if (!tableExists(database, "remote_operations")) {
      throw new Error("endpoint_selection_source_missing:remote_operations");
    }
    if (!columnExists(database, "remote_operations", "endpoint_selection_json")) {
      database.exec("ALTER TABLE remote_operations ADD COLUMN endpoint_selection_json TEXT");
    }
  }
};
