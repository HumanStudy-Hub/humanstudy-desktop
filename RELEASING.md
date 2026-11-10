# Releasing HumanStudy Desktop

Installed apps update themselves from **published** GitHub Releases of this repository
(electron-updater, GitHub provider). A release is made in three steps:

1. Bump `version` in `app/package.json`, commit, and tag: `git tag v0.2.0 && git push origin v0.2.0`.
2. The **Release** workflow builds macOS (dmg + zip, arm64 and x64) and Windows (NSIS installer +
   zip, x64 and arm64) and attaches them, with the `latest*.yml` update manifests, to a **draft**
   release.
3. Check the draft, then publish it. Only published releases reach users.

## Betas: test before everyone updates

Every release goes out as a beta first. A beta is a version with a prerelease suffix, published as a
GitHub **prerelease**:

1. Set `version` to `0.7.2-beta.1` (`npm version 0.7.2-beta.1 --no-git-tag-version` in `app/`), commit,
   tag `v0.7.2-beta.1`, push. The Release workflow builds the draft as usual; attach the notarized Mac
   assets.
2. Publish it **as a prerelease**: `gh release edit v0.7.2-beta.1 --draft=false --prerelease`.
3. Testers install it from the release page. From then on their app follows betas: electron-updater
   turns on `allowPrerelease` for a prerelease version and takes the newest beta or stable release.
4. When the beta holds up, release the same code as `0.7.2` (not a prerelease). Testers update to it
   and return to the stable channel; the next beta has to be installed by hand again.

Stable installs never see a beta: with a stable version electron-updater reads `releases/latest`,
which GitHub never points at a prerelease. The web `/download` page also offers only the newest
stable release (`lib/desktop-release.ts`). Never publish a beta without `--prerelease`: it would
become "latest" and update everyone.

## The agent kernel

The app downloads its agent kernel, the HumanStudy edition of opencode, from
[HumanStudy-Hub/opencode](https://github.com/HumanStudy-Hub/opencode/releases) at first run. It is not
bundled in the installers. To ship a new kernel:

1. In the fork, tag `hs-v<upstream>` (or `hs-v<upstream>-2` for a second build of the same version);
   the release workflow attaches `opencode-humanstudy-<darwin|windows>-<arch>[-baseline].zip` and
   `SHA256SUMS.txt` (see the fork's `HUMANSTUDY.md`).
2. In `app/src/main/opencode-install-core.ts` set `KERNEL_TAG` (the tag) and `KERNEL_VERSION` (the
   upstream semver that `opencode --version` prints after `opencode-humanstudy`).
3. Run `node --test src/main/*.test.mjs src/main/kernel/*.test.mjs`, then release the app as below.
   Installed apps fetch the new kernel into `userData/opencode/<tag>/` on their next start; the app
   never reads checksums from the source, only from the release's `SHA256SUMS.txt`.

## The research runtime

Python and the PDF tools are also downloaded at first run (never bundled, so nothing in it needs
signing or notarization: files written by the app carry no `com.apple.quarantine` attribute and
Gatekeeper does not assess them; the python-build-standalone and wheel binaries are ad-hoc signed,
which is all Apple Silicon requires). To update it:

1. Python: pick a release of [python-build-standalone](https://github.com/astral-sh/python-build-standalone/releases),
   copy the three `install_only_stripped` asset names, sizes and SHA-256 (from the release's `SHA256SUMS`)
   into `PYTHON_ASSETS` in `app/src/main/runtime-core.ts` with `PBS_TAG` / `PYTHON_VERSION`.
2. Packages: edit `pack/runtime/requirements.in`, run `pack/runtime/relock.sh` (needs `uv`; it also checks that
   every target platform has a binary wheel for every pin), commit `requirements.lock`.
3. `node --test src/main/runtime.test.mjs`; `node scripts/install-runtime.mjs <dir>` does a real install.
   A new lock file changes the runtime version, so installed apps fetch it next start and delete the old one.

## Signing secrets (repository → Settings → Secrets and variables → Actions)

| Secret | What it is |
|---|---|
| `CSC_LINK` | The Developer ID Application certificate exported as .p12, base64-encoded |
| `CSC_KEY_PASSWORD` | Password of that .p12 |
| `APPLE_API_KEY_BASE64` | The App Store Connect API key file (`AuthKey_<id>.p8`), base64-encoded |
| `APPLE_API_KEY_ID` | Its key ID (J3H58NSZJV) |
| `APPLE_API_ISSUER` | Issuer ID from App Store Connect → Users and Access → Integrations → App Store Connect API |

Without `CSC_LINK` the macOS build is unsigned; without the Apple API secrets it is not notarized.
Unsigned or unnotarized Mac apps are blocked by Gatekeeper on first open, and macOS auto-update
requires a signed app, so set these before the first public release. Windows builds are unsigned
for now (SmartScreen shows a warning until the installer builds reputation or is code-signed).

## Local builds

```sh
cd app
npm run dist:mac      # signs with the Developer ID in the login keychain; notarizes if APPLE_API_ISSUER is set
npm run dist:win      # Windows installer, built on macOS
```

## Local disk after release

Installers and unpacked Electron apps in `app/dist/` are generated output, not a second archive.
After confirming every published asset can be downloaded, remove old local `app/dist/` outputs before
building the next candidate. Do not delete the current candidate before upload/acceptance, installed user
apps, projects, runtime data, chats, source materials or uncommitted worktrees. Old inactive `.next/`
folders are rebuildable too; do not delete dependencies shared through symlinks with active worktrees.
