import type { Migration } from "./db";
import instance from "./migrations/001_instance.sql" with { type: "text" };

export const migrations: readonly Migration[] = [{ version: 1, sql: instance }];
