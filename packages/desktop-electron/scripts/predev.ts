import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENFDS_CHANNEL ?? process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../opencode && bun script/build-node.ts`
