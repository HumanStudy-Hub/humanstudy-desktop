# 0.6.1 automatic-update acceptance

Published 2026-10-15 (Vancouver), 2026-10-16T01:00:43Z.
Release: https://github.com/HumanStudy-Hub/humanstudy-desktop/releases/tag/v0.6.1
Source tag: 2b9b56ed501aee377c04e038d64a2dc933900819.
Workflow safety: PR #3, merge cdc4680d6c95bd8757471283884ca6df49740630.

## Release verification

- Tag-triggered Release run 38831923338 passed both Mac and Windows jobs.
- After the jobs ended, replaced all nine Mac installer/update assets with previously signed,
  notarized/stapled local artifacts. GitHub SHA-256 digests, sizes and upload state matched
  every entry in app/dist/v0.6.1-candidate-20261015/SHA256SUMS.
- Public latest release is v0.6.1, not draft/prerelease. Public latest/download/latest-mac.yml
  byte-matches the verified local metadata; all four installer SHA-512 values were verified
  before publication. Windows latest.yml references the uploaded 208745194-byte NSIS installer.
- Both source Mac apps and the actually upgraded arm64 app pass Gatekeeper as Notarized Developer ID.
- Production https://humanstudy-hub.com/download now links to 0.6.1 arm64/Intel DMGs and Windows preview.
- CI now skips Mac publishing when any signing/notarization credential is absent, instead of
  uploading unsigned replacements. Locally notarized artifacts can still be attached manually.

## Actual packaged-app upgrade

Downloaded the public signed 0.6.0 arm64 ZIP and extracted an isolated test app under
/private/tmp/hs-update-e2e-061/old/. Launched with a temporary --user-data-dir and projectsRoot,
mock kernel and localhost server; no owner project or account was used. The actual preload IPC
and main updater were exercised, not a simulated updater/provider.

1. Confirmed running app version 0.6.0 and temporary userData/projects paths.
2. Checked against the public GitHub channel. It discovered and downloaded 0.6.1.
3. A network change initially interrupted download (ERR_NETWORK_CHANGED). A manual check retry
   succeeded without reinstalling/restarting the old app. This is NOT proof of automatic network retry.
4. Actual electron-updater reported ready, 100%, nextVersion 0.6.1. Native Squirrel.Mac emitted
   update-downloaded after receiving the ZIP. No signature or integrity bypass was used.
5. Quit the isolated app normally through Electron app.quit(), without asking it to relaunch into
   the owner's default userData. ShipIt log: “Installation completed successfully”. The test app's
   CFBundleShortVersionString changed to 0.6.1 without manual extraction/replacement.
6. Reopened that upgraded app with the same temporary flags. Actual app.info returned 0.6.1,
   settings retained projectsRoot and notifications=false, and updater status returned state=none
   (already current). Strict deep codesign verification and Gatekeeper assessment passed.

Raw evidence remains in /private/tmp/hs-update-e2e-061/ (release-verification.json,
after-upgrade.json, public-latest-mac.yml and app.log). Installer checksums are in app/dist.
No owner-installed app was replaced. Updater caches use the standard app cache location.

## Remaining acceptance limits

- Intel Mac artifacts verified, but no Intel hardware installation test.
- Windows is an unsigned preview: build/update metadata present, no real Windows installation test.
- Tested normal quit-to-install plus manual reopening, not the Restart button's automatic relaunch.
- Isolated settings survived; no real signed-in account, existing project or chat migration was tested.
- Network failure was visible/retryable. Old updater logs an unhandled download-promise rejection;
  observe/catch downloadPromise and add bounded transient-network retry in a future patch. Neither
  a silent automatic retry nor uninterrupted download across a network reset is claimed here.
