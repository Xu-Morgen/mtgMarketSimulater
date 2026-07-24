import { openSqliteDatabase } from "@mtg-market/database";

export function openDatabase(databasePath: string) {
  return openSqliteDatabase(databasePath);
}
