import { $ } from "bun"
import * as path from "node:path"
import * as fs from "node:fs/promises"

import { RUST_TARGET } from "./utils"

if (!RUST_TARGET) throw new Error("RUST_TARGET not defined")

const BUNDLE_DIR = `src-tauri/target/${RUST_TARGET}/release/bundle`
const BUNDLES_OUT_DIR = path.join(process.cwd(), `src-tauri/target/bundles`)

await $`mkdir -p ${BUNDLES_OUT_DIR}`
const items = [
  ...(await Array.fromAsync(new Bun.Glob("*/OpenFDS*").scan({ cwd: BUNDLE_DIR }))),
  ...(await Array.fromAsync(new Bun.Glob("*/OpenCode*").scan({ cwd: BUNDLE_DIR }))),
]
for (const item of items) {
  await fs.cp(path.join(BUNDLE_DIR, item), path.join(BUNDLES_OUT_DIR, path.basename(item)), { recursive: true })
}
