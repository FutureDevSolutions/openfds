import { app } from "electron"
import log from "electron-log/main.js"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CHANNEL } from "./constants"
import { getStore, store } from "./store"

const TAURI_MIGRATED_KEY = "tauriMigrated"

// Resolve the directory where Tauri stored its .dat files for the given app identifier.
// Mirrors Tauri's AppLocalData / AppData resolution per OS.
function tauriDir(id: string) {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", id)
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), id)
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), id)
  }
}

// The Tauri app identifier changes between dev/beta/prod builds.
const TAURI_APP_IDS: Record<string, string> = {
  dev: "ai.openfds.desktop.dev",
  beta: "ai.openfds.desktop.beta",
  prod: "ai.openfds.desktop",
}
const LEGACY_TAURI_APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
function tauriAppId() {
  return app.isPackaged ? TAURI_APP_IDS[CHANNEL] : "ai.openfds.desktop.dev"
}

// Migrate a single Tauri .dat file into the corresponding electron-store.
// `openfds.settings.dat` is special: it maps to the `openfds.settings` store
// (the electron-store name without the `.dat` extension). All other .dat files
// keep their full filename as the electron-store name so they match what the
// renderer already passes via IPC (e.g. `"default.dat"`, `"openfds.global.dat"`).
function migrateFile(datPath: string, filename: string) {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(readFileSync(datPath, "utf-8"))
  } catch (err) {
    log.warn("tauri migration: failed to parse", filename, err)
    return
  }

  // openfds.settings.dat → the electron settings store ("openfds.settings").
  // All other .dat files keep their full filename as the store name so they match
  // what the renderer passes via IPC (e.g. "default.dat", "openfds.global.dat").
  const storeName =
    filename === "openfds.settings.dat" || filename === "opencode.settings.dat"
      ? "openfds.settings"
      : filename === "opencode.global.dat"
        ? "openfds.global.dat"
        : filename
  const target = getStore(storeName)
  const migrated: string[] = []
  const skipped: string[] = []

  for (const [key, value] of Object.entries(data)) {
    // Don't overwrite values the user has already set in the Electron app.
    if (target.has(key)) {
      skipped.push(key)
      continue
    }
    target.set(key, value)
    migrated.push(key)
  }

  log.log("tauri migration: migrated", filename, "→", storeName, { migrated, skipped })
}

export function migrate() {
  if (store.get(TAURI_MIGRATED_KEY)) {
    log.log("tauri migration: already done, skipping")
    return
  }

  const dirs = [
    tauriDir(tauriAppId()),
    tauriDir(app.isPackaged ? LEGACY_TAURI_APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"),
  ]
  log.log("tauri migration: starting", { dirs })

  const roots = dirs.filter((dir, idx) => dirs.indexOf(dir) === idx && existsSync(dir))
  if (roots.length === 0) {
    log.log("tauri migration: no tauri data directories found, nothing to migrate")
    store.set(TAURI_MIGRATED_KEY, true)
    return
  }

  for (const dir of roots) {
    for (const filename of readdirSync(dir)) {
      if (!filename.endsWith(".dat")) continue
      migrateFile(join(dir, filename), filename)
    }
  }

  log.log("tauri migration: complete")
  store.set(TAURI_MIGRATED_KEY, true)
}
