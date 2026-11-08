// The web edition (app/web) serves this renderer from a cloud sandbox: no local folders, no Finder, and
// the server updates the app, so the controls for those are not shown there.
export const WEB_EDITION = typeof window !== 'undefined' && Boolean((window as unknown as { __HS_WEB__?: unknown }).__HS_WEB__)
