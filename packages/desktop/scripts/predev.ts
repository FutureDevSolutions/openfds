import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

const RUST_TARGET = Bun.env.TAURI_ENV_TARGET_TRIPLE

const sidecarConfig = getCurrentSidecar(RUST_TARGET)

const next = windowsify(`../opencode/dist/${sidecarConfig.ocBinary}/bin/openfds`)
const prev = windowsify(next.replace("openfds-", "opencode-").replace("/openfds", "/opencode"))
const binaryPath = (await Bun.file(next).exists()) ? next : prev

await (sidecarConfig.ocBinary.includes("-baseline")
  ? $`cd ../opencode && bun run build --single --baseline`
  : $`cd ../opencode && bun run build --single`)

await copyBinaryToSidecarFolder(binaryPath, RUST_TARGET)
