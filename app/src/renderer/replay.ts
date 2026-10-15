// Session replay was retired in 0.6.1. Do not import rrweb or install DOM/mouse observers here.
// Product research uses explicit semantic events (telemetry.ts/capture.ts) and consented
// agent transcripts/project artifacts. Kept as an inert compatibility entry point.
export function startReplay(): void {}
