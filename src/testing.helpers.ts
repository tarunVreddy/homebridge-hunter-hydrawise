/* Copyright(C) 2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: Barrel re-export for the cross-cutting testing helper modules under src/testing/. Test files import from this single entry to keep
 * import paths stable as the implementation modules evolve. The thematic submodules under src/testing/ each own one concern:
 *
 *   - loggers.helpers.ts      TestLogger, CapturedLogLine, silentLog, capturingLog
 *   - fs.helpers.ts           withTempDir
 *   - process.helpers.ts      assertNoUnhandledRejections, expectAt
 *   - narrowing.helpers.ts    firstOf, nthOf
 *   - parity.helpers.ts       assertSameShape, declareKeysOf
 *
 * Tests can import from this barrel for the common case, or from a specific submodule when they want to advertise the narrower dependency. Both styles work
 * because the barrel re-exports verbatim. The optional exec.helpers.ts submodule is omitted here: this plugin has no execFile-shaped adapter port.
 *
 * Add additional thematic submodules as the project grows (e.g., a `network.helpers.ts` for HTTP-fake utilities), keeping the one-concern-per-file discipline.
 * The plugin-specific HAP, platform, MQTT, and wire doubles live in their own submodules under src/testing/ and are imported directly rather than through this
 * canonical barrel.
 */
export type { CapturedLogLine, TestLogger } from "./testing/loggers.helpers.ts";
export { assertNoUnhandledRejections, expectAt } from "./testing/process.helpers.ts";
export { assertSameShape, declareKeysOf } from "./testing/parity.helpers.ts";
export { capturingLog, silentLog } from "./testing/loggers.helpers.ts";
export { firstOf, nthOf } from "./testing/narrowing.helpers.ts";
export { TMPDIR_PREFIX, withTempDir } from "./testing/fs.helpers.ts";
