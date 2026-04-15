<p align="center">
  <a href="https://github.com/anomalyco/openfds">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenFDS logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/openfds-ai"><img alt="npm" src="https://img.shields.io/npm/v/openfds-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/openfds/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/openfds/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenFDS Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://github.com/anomalyco/openfds)

---

### Installation

```bash
# YOLO
curl -fsSL https://raw.githubusercontent.com/anomalyco/openfds/dev/install | bash

# Package managers
npm i -g openfds-ai@latest        # or bun/pnpm/yarn
scoop install openfds             # Windows
choco install openfds             # Windows
brew install anomalyco/tap/openfds # macOS and Linux (recommended, always up to date)
brew install openfds              # macOS and Linux (official brew formula, updated less)
sudo pacman -S openfds            # Arch Linux (Stable)
paru -S openfds-bin               # Arch Linux (Latest from AUR)
mise use -g openfds               # Any OS
nix run nixpkgs#openfds           # or github:anomalyco/openfds for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenFDS is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/openfds/releases).

| Platform              | Download                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `openfds-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `openfds-desktop-darwin-x64.dmg`     |
| Windows               | `openfds-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, or AppImage           |

```bash
# macOS (Homebrew)
brew install --cask openfds-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/openfds-desktop
```

#### Installation Directory

The default install location is `$HOME/.openfds/bin`.

### Agents

OpenFDS includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://github.com/anomalyco/openfds).

### Documentation

For more info on how to configure OpenFDS, [**head over to our docs**](https://github.com/anomalyco/openfds).

### Contributing

If you're interested in contributing to OpenFDS, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenFDS

If you are working on a project that's related to OpenFDS and is using "openfds" as part of its name, for example "openfds-dashboard" or "openfds-mobile", please add a note to your README to clarify that it is not built by the OpenFDS team and is not affiliated with us in any way.

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. Although we recommend the models we provide through OpenFDS Zen, OpenFDS can be used with Claude, OpenAI, Google, or even local models. As models evolve, the gaps between them will close and pricing will drop, so being provider-agnostic is important.
- Out-of-the-box LSP support
- A focus on TUI. OpenFDS is built by neovim users and the creators of [terminal.shop](https://terminal.shop); we are going to push the limits of what's possible in the terminal.
- A client/server architecture. This, for example, can allow OpenFDS to run on your computer while you drive it remotely from a mobile app, meaning that the TUI frontend is just one of the possible clients.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
