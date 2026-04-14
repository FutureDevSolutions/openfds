#!/usr/bin/env bun
import { $ } from "bun"

import { Script } from "@opencode-ai/script"
import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

const pkg = await Bun.file("./package.json").json()
pkg.version = Script.version
await Bun.write("./package.json", JSON.stringify(pkg, null, 2) + "\n")
console.log(`Updated package.json version to ${Script.version}`)

const sidecarConfig = getCurrentSidecar()
const artifact = process.env.OPENFDS_CLI_ARTIFACT ?? process.env.OPENCODE_CLI_ARTIFACT ?? "openfds-cli"

const dir = "src-tauri/target/openfds-binaries"

await $`mkdir -p ${dir}`
await $`gh run download ${process.env.GITHUB_RUN_ID} -n ${artifact}`.cwd(dir)

const next = windowsify(`${dir}/${sidecarConfig.ocBinary}/bin/openfds`)
const prev = windowsify(next.replace("openfds-", "opencode-").replace("/openfds", "/opencode"))
await copyBinaryToSidecarFolder((await Bun.file(next).exists()) ? next : prev)
