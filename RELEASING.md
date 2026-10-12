# Releasing HumanStudy Desktop

Installed apps update themselves from **published** GitHub Releases of this repository
(electron-updater, GitHub provider). A release is made in three steps:

1. Bump `version` in `app/package.json`, commit, and tag: `git tag v0.2.0 && git push origin v0.2.0`.
2. The **Release** workflow builds macOS (dmg + zip, arm64 and x64) and Windows (NSIS installer +
   zip, x64 and arm64) and attaches them, with the `latest*.yml` update manifests, to a **draft**
   release.
3. Check the draft, then publish it. Only published releases reach users.

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
