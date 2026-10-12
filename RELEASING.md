# Releasing HumanStudy Desktop

Installed apps update themselves from **published** GitHub Releases of this repository
(electron-updater, GitHub provider). A release is made in three steps:

1. Bump `version` in `app/package.json`, commit, and tag: `git tag v0.2.0 && git push origin v0.2.0`.
2. The **Release** workflow builds macOS (dmg + zip, arm64 and x64) and Windows (NSIS installer +
   zip, x64 and arm64) and attaches them, with the `latest*.yml` update manifests, to a **draft**
   release.
3. Check the draft, then publish it. Only published releases reach users.

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
