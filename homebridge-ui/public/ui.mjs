/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Hunter Hydrawise webUI.
 */
"use strict";

import { API_KEY_LENGTH, makeHydrawiseConfig, makeLegacyHydrawiseConfig } from "./hydrawise-config.mjs";
import { FeatureOptions, expandOption } from "homebridge-plugin-utils/featureOptions.js";
import { PluginConfigSession } from "homebridge-plugin-utils/pluginConfigSession.mjs";
import { webUi } from "homebridge-plugin-utils/webUi.mjs";
import { withDeadline } from "homebridge-plugin-utils/webUi-liveness.mjs";

// The feature-option category the controller-scope options this webUI reasons about live in. One constant anchors the category everywhere this file names it - the
// floor-entry grammar, the catalog read, and the enable-state oracle - while the plugin's runtime names it independently in TypeScript; the two meet at the wire.
const DEVICE_CATEGORY = "Device";

// The canonical lowercased key the Device feature option expands to. A controller-scope floor entry is an Enable/Disable action prefix, this key, and the serial id -
// we derive the key through the feature-option engine's own grammar rather than hardcoding the string, so a future rename of the option cannot silently break the
// floor parser.
const DEVICE_OPTION_KEY = expandOption(DEVICE_CATEGORY, "").toLowerCase();

// The two floor-entry prefixes the Device option can carry: an explicit enable or an explicit disable of a whole controller.
const DEVICE_FLOOR_PREFIXES = [ "disable." + DEVICE_OPTION_KEY + ".", "enable." + DEVICE_OPTION_KEY + "." ];

// The canonical option name of the zone-scoped name override, derived through the engine's own grammar for the same reason the floor key is: a rename of the
// option cannot silently break the lookup.
const ZONE_NAME_OPTION = expandOption(DEVICE_CATEGORY, "Name");

// The guidance sentences the controller notice states render through the infoPanel. Complete sentences, shown verbatim to the user.
const NOTICE_DISABLED = "This controller is disabled in your Homebridge configuration, so its zones are not listed. " +
  "Use the Refresh from Hydrawise button above the controller list to retrieve them.";
const NOTICE_DISABLED_LISTED = "This controller is disabled in your Homebridge configuration, so it is not published to HomeKit. " +
  "Its zones are listed for reference.";
const NOTICE_UNPUBLISHED = "The plugin has not published this controller's details yet. " +
  "Restart Homebridge, and its zones will appear here after the first update from Hydrawise completes.";
const NOTICE_UNDISCOVERED = "The plugin has not discovered this controller yet. Restart Homebridge to discover it.";

/* The word each zone schedule state is shown as, in one place. The sidebar dot's tooltip, the zone panel's Status row, and the controller fold's own status all read
 * from here, so no two of those surfaces can describe the same state with different words.
 *
 * The unscheduled word claims exactly what the wire supports - no upcoming run - because a zone between schedule computations and a zone the owner suspended carry
 * identical bodies, and labeling either one "Suspended" would routinely misreport a healthy zone.
 */
const ZONE_STATE_LABELS = { running: "Running", scheduled: "Scheduled", "sensor-stopped": "Rain delay", "starting-soon": "Starting soon",
  unscheduled: "Not scheduled" };

// The upper bound in milliseconds on how long the refresh control stays held after a recovery re-entry, covering a re-entered cycle that dies before rendering.
const REFRESH_REBUILD_WAIT = 10000;

/* How far in seconds a schedule instant may sit in the past before the display says so. A live runtime would have transitioned a zone whose next run or whose end
 * instant has passed, so an instant still standing well after it is evidence that nothing is polling. Ten nominal poll intervals is generous enough that a
 * nextpoll excursion or a few minutes of clock skew never false-alarms, and tight enough that a dead runtime surfaces within minutes.
 *
 * This threshold is presentation policy - how patient the display chooses to be - which is why it lives here, while the active-zone window, which is runtime policy
 * the Home app enforces too, travels with the data instead.
 */
const STALE_GRACE = 600;

/* The schedule ticker's cadence in milliseconds, one nominal poll interval. In the steady state a tick's cache read reaches the server fresh, because the browser's
 * own thirty-second cache has expired between ticks; interleaved page activity can instead serve a tick from that window, which bounds that tick's extra staleness
 * at thirty seconds. That is harmless for poll-cadence data, and it is stated here so the cadence is not read as a freshness guarantee.
 */
const SCHEDULE_TICK_MS = 60000;

/* The session stores. A settings-modal open forks a fresh webUI process that dies on close, so these live exactly as long as the user's session and never persist
 * across opens - the natural bound the design relies on. They only ever accumulate identity, never volatile state:
 *
 *   - sessionControllers: every controller this session has shown, keyed by case-folded serial. Seeded from the accessory cache, the config floor, a first-run login,
 *     and an explicit refresh, so a controller that appeared once stays listed for the session even after its backing drops.
 *   - sessionZones: the zones an explicit refresh fetched for a context-less (disabled) controller, keyed by case-folded serial, so its zones list without a live
 *     accessory.
 *   - sessionFloorSerials: every serial ever seen in the config floor this session, so a controller whose floor Disable the user removed this session can be marked
 *     as awaiting a restart rather than silently vanishing from the list.
 */
const sessionControllers = new Map();
const sessionFloorSerials = new Set();
const sessionZones = new Map();

/* The option catalog, fetched once per session from the plugin's own UI server (a local IPC to /getOptions, never a cloud call) and shared by the floor scan
 * and the enable-state oracle. The framework fetches the same endpoint for its own catalog on every show cycle; the two reads are independent by design,
 * since the framework exposes no handle to its copy - the duplication is one static local request per session. The cached promise is cleared on failure so a
 * later read retries rather than pinning a transient fault for the session.
 */
let catalogPromise = null;

/* The schedule ticker's module state, all of it scoped to one mount and reset when that mount aborts. The ticker serves two surfaces from one read - the sidebar's
 * zone dots and the details panel - and only the panel needs tracking here, because the dots are found by query at the moment they are painted:
 *
 *   - renderContext: a fresh { device, panel } object minted on every render of the details panel. Its OBJECT IDENTITY is what a tick's read compares against on
 *     resolution, which is how a read dispatched for a view the user has since left repaints no panel.
 *   - scheduleTimer: the interval handle, and the arm-once guard for this mount.
 *   - scheduleMountSignal: the mount signal the resume subscription was registered against, so one mount registers exactly one subscriber.
 *   - tickSequence / inFlightTick: the dispatch counter and the sequence number of the read currently in flight, which is how a slow read is superseded rather
 *     than allowed to latch the ticker shut.
 */
let renderContext = null;
let scheduleTimer;
let scheduleMountSignal;
let tickSequence = 0;
let inFlightTick = null;

const getCatalog = () => {

  catalogPromise ??= homebridge.request("/getOptions").then((response) => {

    // A response without the catalog shape the server publishes is a failure, not a default. Shaping it into an empty catalog would make the enable-state
    // oracle read every controller as disabled off the engine's false fallback, so a malformed response throws and the guarded callers surface it instead.
    if(!Array.isArray(response?.categories) || !response.categories.length || !Array.isArray(response?.options?.[DEVICE_CATEGORY])) {

      throw new Error("Received a malformed response from the plugin option catalog.");
    }

    return {

      categories: response.categories,
      deviceOptionNames: new Set(response.options[DEVICE_CATEGORY].filter((option) => (typeof option?.name === "string") && option.name.length)
        .map((option) => option.name.toLowerCase())),
      options: response.options
    };
  }).catch((error) => {

    catalogPromise = null;

    throw error;
  });

  return catalogPromise;
};

/* The bound in seconds on the whole load-time wiring below. Five seconds settles the envelope provably inside the page boot monitor's ten-second watchdog, so a
 * wiring step that hangs against an unresponsive host can never be what makes the settings panel look broken.
 */
const WIRING_DEADLINE = 5;

/* The interpreter every configuration read in this file goes through. It is declared already holding the degraded-mode interpreter, so the binding is never
 * undefined in any window and no consumer needs a guard; the wiring below swaps in the catalog-backed interpreter the moment the catalog is in hand.
 */
let hydrawiseConfig = makeLegacyHydrawiseConfig();

// The load-time wiring's own lifecycle. Aborting it is how an envelope that failed or expired tells a continuation still running underneath it that it must not
// stage anything after the fact.
const wiringController = new AbortController();

/* Wire the configuration interpreter and run the legacy-settings migration, once, at load.
 *
 * The whole envelope is awaited at module top level, which is what makes every consumer below safe without any of them knowing this ran: module evaluation is
 * suspended until the wiring settles, so the webUI is constructed, the refresh listener is bound, and ui.show() is called only afterwards. Two consequences
 * follow. The framework opens its own configuration session inside the launch path that ui.show() starts, so every replica it hands to a hook - the first-run
 * config, the options page's persist path - is read after the migration has settled, and none of them can commit a pre-migration snapshot over it. And no
 * first-run hook or refresh handler can observe a half-wired interpreter, because nothing that consumes it can run at all until module evaluation completes.
 * Bounding evaluation is what makes that safe rather than reckless: the library's deadline settles the envelope either way, and every failure path assigns
 * rather than throws.
 *
 * A migration that composes a patch persists it to disk itself, without waiting for the user to press Save. Most people never open this panel to save
 * anything, so a migration that waited for one would leave a fleet split between two configuration shapes indefinitely, and the plumbing that reconciles them
 * could never retire. The write is gated on there being a patch, which is what bounds it: only a session that actually found legacy settings writes, so a
 * migrated install's every later open reads, finds nothing to do, and touches the disk not at all. The host's restart indicator therefore appears at most once
 * per install, in the single session that converts it.
 *
 * The weaker outcomes are deliberate. A save the deadline overtakes, and a save the host rejects, both leave the migration sitting in the modal's pending
 * configuration, where the user's own Save picks it up.
 *
 * Reopening the panel is convergent rather than racing. The settings frame is reused and each open imports a fresh copy of this module whose wiring runs
 * independently, but a second copy reads the saved configuration, finds no legacy keys in it, and so composes nothing and writes nothing. Two genuinely
 * simultaneous wirings read the same configuration and compose identical patches, so either ordering of their commits and saves leaves the same disk state.
 *
 * When the envelope fails, the interpreter settles at whatever the wiring reached. A catalog fetch that never succeeded leaves the degraded-mode interpreter in
 * place, which reads and writes the legacy properties, so the page still loads and first run still works; a migration that stumbled after the catalog arrived
 * keeps the catalog-backed interpreter, because one failed attempt is no reason to degrade every read for the session. The migration itself simply waits for a
 * session whose fetches succeed.
 */
const wireHydrawiseConfig = async () => {

  hydrawiseConfig = makeHydrawiseConfig({ FeatureOptions, catalog: await getCatalog() });

  // The library's session is the single conduit the framework's own writes use, so the patch merges onto a replica synced just now rather than onto a snapshot
  // taken before the page opened.
  const session = await PluginConfigSession.open({ host: homebridge, name: "Hydrawise" });
  const patch = hydrawiseConfig.migrate(session.platform);

  // The abort is read immediately before the write, so an envelope that expired while the session was still opening cannot stage a patch after the page has
  // given up waiting for it.
  if(patch && !wiringController.signal.aborted) {

    await session.commit(patch);

    // The signal is read a second time, because the commit itself was an await and the envelope may have expired across it. A save the deadline overtakes is
    // skipped rather than forced, which leaves the migration staged for the user's own save - the weaker outcome, and the honest one.
    if(!wiringController.signal.aborted) {

      await homebridge.savePluginConfig();
    }
  }
};

try {

  await withDeadline({ promise: wireHydrawiseConfig(), seconds: WIRING_DEADLINE, signal: wiringController.signal });
} catch(error) {

  wiringController.abort(error);
}

// Build the feature-option engine over the cached catalog and the user's configured options. The engine is rebuilt per call because the configured options change
// underneath us as the user edits them, so an edit the user just saved is reflected the next time we ask. Every consult in this file resolves through here, which
// is what keeps the enable-state oracle and the zone-name lookup answering from one engine rather than two.
const getEngine = async (config) => {

  const { categories, options } = await getCatalog();

  return new FeatureOptions(categories, options, config?.options ?? []);
};

// Ask the feature-option engine whether the runtime publishes a controller, using the runtime's exact gate call so the webUI and the plugin cannot disagree
// about a controller's enabled state.
const isControllerEnabled = async (config, serialNumber) => (await getEngine(config)).test(DEVICE_CATEGORY, undefined, serialNumber);

// Case-fold a serial for cross-source identity comparison, matching the runtime feature-option engine's serial lowercasing so the webUI and the plugin agree on a
// controller's identity.
const foldSerial = (serial) => String(serial).toLowerCase();

// Validate a persisted controller-identity entry read from the accessory cache or a cloud response. A malformed entry counts as absent, so a corrupt cache never
// crashes the reader or lists a phantom controller.
const isControllerIdentity = (value) => (typeof value === "object") && (value !== null) && (typeof value.controllerId === "number") &&
  (typeof value.name === "string") && (typeof value.serialNumber === "string");

// Validate a persisted zone-identity entry. Like the controller check, a malformed entry counts as absent.
const isZoneIdentity = (value) => (typeof value === "object") && (value !== null) && (typeof value.name === "string") && (typeof value.relay === "number") &&
  (typeof value.relayId === "number");

/* Whether a persisted accessory context belongs to a standalone zone accessory - the accessory that hosts one zone's valve on its own so the user can assign the
 * zone to a room. This is a PRESENCE check on the identity pair, deliberately simpler than the runtime's own predicate, which additionally requires every
 * controller-accessory field to be absent. At this consumer an ambiguous context - one carrying the controller shape and the zone pair at once - is already
 * excluded where it matters: the notice heuristic's other arm tests isControllerIdentity itself, and such a context passes that arm and is excluded regardless
 * of what this one answers.
 */
const isZoneAccessoryLike = (context) => isControllerIdentity(context?.ownerController) && isZoneIdentity(context?.zone);

// Validate one zone's persisted schedule entry. The state must be one the runtime's union declares, and the arm that state names must carry its own numeric fields,
// so a truncated cache entry - a running entry that lost its end instant - counts as absent here rather than rendering as a blank countdown.
const isZoneScheduleStatus = (value) => {

  if((typeof value !== "object") || (value === null) || (typeof value.relayId !== "number")) {

    return false;
  }

  switch(value.state) {

    case "running":

      return typeof value.endsAt === "number";

    case "scheduled":

      return (typeof value.durationSeconds === "number") && (typeof value.nextRunAt === "number");

    case "sensor-stopped":
    case "unscheduled":

      // These states carry no facts beyond the state itself, so a well-formed relay id and a known state are the whole shape.
      return true;

    default:

      return false;
  }
};

// Validate a controller's persisted schedule projection. Like the identity checks, a malformed value counts as absent, so a corrupt cache renders an identity-only
// panel rather than a panel that lies.
const isScheduleStatus = (value) => (typeof value === "object") && (value !== null) && (typeof value.activeWindowSeconds === "number") &&
  (typeof value.asOf === "number") && Array.isArray(value.zones) && value.zones.every(isZoneScheduleStatus);

// Find the cached accessory that carries a controller's own identity, matched on the folded serial. The zone listing and the schedule ticker both have to locate
// the same accessory, so the match lives here once rather than being re-derived at each read site.
const matchControllerAccessory = (cached, targetSerial) => cached.find((accessory) => isControllerIdentity(accessory?.context?.controller) &&
  (foldSerial(accessory.context.controller.serialNumber) === targetSerial));

/* Extract the controller serials named by the config floor. A floor entry names a whole controller as "Enable/Disable.Device.<serial>"; the same grammar also carries
 * a zone-scope disable ("Disable.Device.<relayId>") and the distinct suspend option ("Disable.Device.Suspend.<serial>"), so we keep only single-segment ids and let the
 * caller drop any id that matches a known zone. The action prefixes and the Device key are derived through the engine's own expandOption grammar, so a rename of the
 * option cannot silently break the match; the walk over the entries is a hand scan, because the engine exports no enumeration primitive to delegate it to.
 *
 * excludedNames carries the lowercased Device-category option names the catalog declares, and any candidate id it names is dropped. Such an entry is that option's
 * global-scope entry - the raw-tail lookup key the engine's own config index stores for it - rather than a Device-scoped serial, so honoring the exclusion is what
 * keeps this scan and the engine agreeing on what an entry means. A candidate carrying an "=" is dropped for the same reason: the character is the value grammar's
 * payload delimiter, so such a tail is a value-centric option's entry rather than a serial, and no Hydrawise serial contains one. We slice the original entry, not
 * the lowercased copy, so a mixed-case serial keeps its display casing.
 */
const floorSerials = (options, excludedNames) => {

  const serials = [];

  if(!Array.isArray(options)) {

    return serials;
  }

  for(const entry of options) {

    if(typeof entry !== "string") {

      continue;
    }

    const lower = entry.toLowerCase();

    for(const prefix of DEVICE_FLOOR_PREFIXES) {

      if(!lower.startsWith(prefix)) {

        continue;
      }

      const id = entry.slice(prefix.length);

      if(id.length && !id.includes(".") && !id.includes("=") && !excludedNames.has(id.toLowerCase())) {

        serials.push(id);
      }
    }
  }

  return serials;
};

// Surface a failure sentence to the user. The Homebridge UI toast API is the primary channel; we fall back to the console when it is unavailable in this context.
const notifyError = (message) => {

  if(homebridge.toast?.error) {

    homebridge.toast.error(message, "Error");

    return;
  }

  // eslint-disable-next-line no-console
  console.error(message);
};

// Execute our first run screen if we don't have a valid Hydrawise API key. The framework injects our primary platform-config entry, so this is a pure predicate over
// the persisted config rather than a reach into the feature-options page's state, and the interpreter is what knows where a key can live.
const firstRunIsRequired = ({ config }) => hydrawiseConfig.apiKey(config).length !== API_KEY_LENGTH;

// Initialize our first run screen with any information from our existing configuration. The key's length is a validation fact the interpreter module owns, so the
// input's own bounds are stamped from it here rather than restated in the markup.
const firstRunOnStart = ({ config }) => {

  const input = document.getElementById("apiKey");

  input.maxLength = API_KEY_LENGTH;
  input.minLength = API_KEY_LENGTH;

  // Pre-populate with anything we might already have in our configuration.
  input.value = hydrawiseConfig.apiKey(config);

  return true;
};

/* Render the plugin's first-run login error display. Guidance sentences render as text nodes separated by <br> elements, and the failure detail - when present -
 * renders inside a <code class="text-danger"> via textContent, so a server-reported string is shown as text rather than interpreted as markup. Assembling DOM nodes
 * here rather than an assembled markup string keeps that trust boundary in one place, matching buildStatRow's discipline. An empty lines array renders no guidance,
 * and an omitted or empty detail renders no code element.
 */
const renderLoginError = (lines, detail) => {

  const nodes = [];

  for(const line of lines) {

    nodes.push(document.createTextNode(line), document.createElement("br"));
  }

  if(detail?.length) {

    const errorCode = document.createElement("code");

    errorCode.className = "text-danger";
    errorCode.textContent = detail;
    nodes.push(errorCode);
  }

  document.getElementById("loginError").replaceChildren(...nodes);
};

// Seed the session controller roster from a set of cloud-fetched controller identities, so a first-run login or an explicit refresh makes its controllers listable
// with no further call. Malformed entries are skipped.
const seedSessionControllers = (controllers) => {

  if(!Array.isArray(controllers)) {

    return;
  }

  for(const controller of controllers) {

    if(!isControllerIdentity(controller)) {

      continue;
    }

    sessionControllers.set(foldSerial(controller.serialNumber), { controllerId: controller.controllerId, name: controller.name, serialNumber: controller.serialNumber });
  }
};

// Validate our Hydrawise API key.
const firstRunOnSubmit = async ({ commit, config }) => {

  const apiKey = document.getElementById("apiKey").value;
  const tdLoginError = document.getElementById("loginError");

  // Reset the failure placeholder to a non-breaking space via textContent, keeping the cell's height without routing any text through a markup assignment.
  tdLoginError.textContent = " ";

  // The /login endpoint answers a shaped object: a result sentence ("success" or the failure reason) plus the controllers it parsed from the same customerdetails
  // body it already fetched. On failure we render the sentence inline through the DOM helper, so the user sees the specific reason on the form.
  const { controllers, result } = await homebridge.request("/login", apiKey);

  if(result !== "success") {

    renderLoginError([], result);
    homebridge.hideSpinner();

    return false;
  }

  // Seed the session roster from the login response so a first-run user sees their controllers immediately, with no extra call, once the feature-options view opens.
  seedSessionControllers(controllers);

  // Persist the validated key through commit, the framework's single write path. The interpreter composes the patch, so the key is written to the feature option
  // that owns it and any legacy property carrying an older key leaves on the same save.
  await commit(hydrawiseConfig.withApiKey(config, apiKey));

  return true;
};

// The controller-as-device pseudo-entry is tagged "controller"; every other entry the server returns is a zone.
const isController = (device) => device.kind === "controller";

/* The name HomeKit last showed for a zone's valve, read from the matched cached accessory's serialized services. The valve is located the way the framework's own
 * cache reader locates a service - by the constructor name Homebridge serializes alongside it - narrowed by the subtype the runtime keys each valve on, which is
 * the zone's relay id.
 *
 * This is the LAST-FLUSHED name, not a live mirror: Homebridge rewrites the accessory cache when an accessory is registered, updated, or unregistered, never on a
 * bare characteristic write. Where name synchronization is enabled the plugin keeps each valve at its effective name, so this tracks that name closely; without
 * synchronization, a rename made in the Home app can sit here unflushed until the next write of the cache. ConfiguredName is the name HomeKit shows the user and
 * so takes precedence over Name, matching how the plugin's own service helpers read a service's name.
 */
const cachedValveName = (accessory, relayId) => {

  const service = accessory?.services?.find((entry) => (entry?.constructorName === "Valve") && (entry?.subtype === relayId.toString()));

  if(!Array.isArray(service?.characteristics)) {

    return undefined;
  }

  const nameValue = (constructorName) => {

    const value = service.characteristics.find((characteristic) => characteristic?.constructorName === constructorName)?.value;

    return ((typeof value === "string") && value.length) ? value : undefined;
  };

  return nameValue("ConfiguredName") ?? nameValue("Name");
};

/* Return the account's irrigation controllers for the two-level sidebar, with zero automatic cloud calls. We merge three sources into the session roster and return
 * it: (a) the denormalized controller roster every cached accessory carries in its context - any one accessory knows every sibling, enabled or not; (b) the config
 * floor, whose Disable entries name controllers the user turned off (so they have no accessory), listed by serial until a refresh names them and screened against the
 * option catalog so a global-scope option entry never reads as a controller; and (c) the session roster itself, so a controller that appeared once stays listed. A
 * controller whose floor Disable the user removed this session, with no live accessory yet, is marked as awaiting a restart. The apiKey is never consulted here - the
 * listing is answered from the local accessory cache, the local config, and the option catalog the plugin's own UI server publishes.
 */
const getControllers = async ({ config }) => {

  const contextSerials = new Set();
  const knownZoneIds = new Set();

  // (a) The union of every validated cached accessory's denormalized controller roster, plus the zone ids those accessories own so a zone-scope floor entry is not
  // mistaken for a disabled controller below.
  try {

    const cached = await homebridge.getCachedAccessories();

    for(const accessory of cached) {

      const roster = accessory?.context?.controllers;

      if(Array.isArray(roster)) {

        for(const entry of roster) {

          if(!isControllerIdentity(entry)) {

            continue;
          }

          const key = foldSerial(entry.serialNumber);

          contextSerials.add(key);
          sessionControllers.set(key, { controllerId: entry.controllerId, name: entry.name, serialNumber: entry.serialNumber });
        }
      }

      const zones = accessory?.context?.zones;

      if(Array.isArray(zones)) {

        for(const zone of zones) {

          if(isZoneIdentity(zone)) {

            knownZoneIds.add(foldSerial(zone.relayId.toString()));
          }
        }
      }
    }
  } catch(err) {

    notifyError((err instanceof Error) ? err.message : String(err));
  }

  /* (b) The config floor, screened against the option catalog. Each named serial is remembered for the session; one that is neither a known controller nor a known
   * zone becomes a serial-labeled disabled entry the user can then refresh to name. A failed catalog read degrades the scan to its prefix-only behavior, which is
   * acceptable here: the framework's own show cycle fetches the same endpoint unguarded, so an endpoint that cannot answer fails the page load before this matters.
   */
  const catalog = await getCatalog().catch(() => null);
  const floorSet = new Set();

  for(const serial of floorSerials(config?.options, catalog?.deviceOptionNames ?? new Set())) {

    const key = foldSerial(serial);

    if(knownZoneIds.has(key)) {

      continue;
    }

    floorSet.add(key);
    sessionFloorSerials.add(key);

    if(!sessionControllers.has(key)) {

      sessionControllers.set(key, { controllerId: undefined, name: serial, serialNumber: serial });
    }
  }

  // (c) Resolve the session roster to the framework's controller shape. A session entry with no current backing whose serial was in the floor earlier this session is
  // a re-enable awaiting a restart, so we mark it; the entry stays listed either way.
  const resolved = [];

  for(const entry of sessionControllers.values()) {

    const key = foldSerial(entry.serialNumber);
    const backed = contextSerials.has(key) || floorSet.has(key);
    const pendingRestart = !backed && sessionFloorSerials.has(key);

    resolved.push({ controllerId: entry.controllerId, name: pendingRestart ? (entry.name + " (pending restart)") : entry.name, serialNumber: entry.serialNumber });
  }

  return resolved;
};

/* Return a selected controller's zones for the two-level sidebar, with zero automatic cloud calls. We resolve the zones from the accessory whose own controller
 * identity matches the selection (an enabled controller), falling back to the zones an explicit refresh stored this session (a disabled controller the user has
 * refreshed). Every value read from the cache is shape-checked, so a malformed read counts as absent. Two empty cases are distinct: an enabled controller with a
 * legitimately empty zone set resolves the controller pseudo-entry with a zero zone count, while a controller whose zones we cannot resolve at all resolves the
 * pseudo-entry alone, carrying the guidance sentence for the state it is in.
 *
 * The pseudo-entry's notice field is the channel for that guidance, rendered by the infoPanel: a controller the configuration disables, one whose published details
 * are unusable, and one the plugin has never discovered each read differently to the user and each prescribe a different remedy. A listable controller the
 * configuration disables carries its own notice alongside the zone count, so a refresh that lists its zones cannot make it look published. The error half of the
 * result therefore means exactly what the framework defines it to mean - a genuine fetch failure, which routes to the connection-error view - and none of these
 * states travel through it.
 */
const getDevices = async (controller, { config } = {}) => {

  if(!controller) {

    return { devices: [], error: "" };
  }

  const targetSerial = foldSerial(controller.serialNumber);
  let cached;
  let matched;
  let zones = null;

  // Resolve the zones from the matching cached accessory's own context. A fresh cache read per invocation is the accepted cost of an unconditionally current listing.
  // Both the cache and the match are function-scoped, because classifying an unresolvable controller below reads the same cache rather than fetching it a second time.
  try {

    cached = await homebridge.getCachedAccessories();
    matched = matchControllerAccessory(cached, targetSerial);

    if(matched && Array.isArray(matched.context.zones) && matched.context.zones.every(isZoneIdentity)) {

      zones = matched.context.zones;
    }
  } catch(err) {

    return { devices: [], error: (err instanceof Error) ? err.message : String(err) };
  }

  // A context-less controller (no live accessory, or a malformed cache) falls back to the zones an explicit refresh stored this session.
  if(zones === null) {

    const refreshed = sessionZones.get(targetSerial);

    if(Array.isArray(refreshed) && refreshed.every(isZoneIdentity)) {

      zones = refreshed;
    }
  }

  if(zones === null) {

    // No zones are resolvable for this controller. Classify why, and answer a calm zero-zone listing whose guidance renders through the infoPanel rather than
    // routing a non-failure through the framework's connection-error view. A genuine catalog failure still takes the error channel: the framework's contract
    // requires this hook to RESOLVE the { devices, error } shape, and a rejection would escape into its failure plumbing instead of the calm listing this
    // state is, so every failure path here resolves the shape rather than rejects.
    try {

      const enabled = await isControllerEnabled(config, controller.serialNumber);
      let notice = NOTICE_UNDISCOVERED;

      if(!enabled) {

        notice = NOTICE_DISABLED;
      } else if(matched || cached.some((accessory) => !isZoneAccessoryLike(accessory?.context) && !isControllerIdentity(accessory?.context?.controller))) {

        notice = NOTICE_UNPUBLISHED;
      }

      return { devices: [{ kind: "controller", name: controller.name, notice, serialNumber: controller.serialNumber, sidebarGroup: "hidden" }], error: "" };
    } catch(error) {

      return { devices: [], error: (error instanceof Error) ? error.message : String(error) };
    }
  }

  /* One consult answers every question this listing asks of the configuration: whether the controller is published, whether each zone is published, and what name
   * the user has set for each zone. A disabled controller can still list zones (a refresh stored them, or its accessory survives until the next restart), so the
   * listing carries the disabled notice alongside the zone count. The whole consult is best-effort and all-or-nothing: a catalog or engine failure is treated as no
   * consult at all - the controller and every zone read as enabled, and every zone label falls through to the arms below - so a failure can never break a healthy
   * listing, and the consumers cannot end up disagreeing about whether the engine answered.
   */
  let enabled = true;
  const overrides = new Map();
  const zoneEnabled = new Map();

  try {

    const engine = await getEngine(config);

    enabled = engine.test(DEVICE_CATEGORY, undefined, controller.serialNumber);

    for(const zone of zones) {

      const override = engine.value(ZONE_NAME_OPTION, zone.relayId.toString(), controller.serialNumber);

      if((typeof override === "string") && override.trim().length) {

        overrides.set(zone.relayId, override.trim());
      }

      // The zone-scope gate, asked with the relay id in the device position and the controller serial in the controller position - the runtime's own scoping
      // convention, so the sidebar and the plugin agree on which zones reach HomeKit.
      zoneEnabled.set(zone.relayId, engine.test(DEVICE_CATEGORY, zone.relayId.toString(), controller.serialNumber));
    }
  } catch {

    enabled = true;
    overrides.clear();
    zoneEnabled.clear();
  }

  /* The zone rows, sorted by relay, keyed by the relay id the runtime scopes zone options against; then the controller-as-device pseudo-entry the two-level sidebar
   * selects on load, hidden from the zone list and reporting the zone count.
   *
   * A zone's sidebar label is its relay number and its effective name: the user's configured override when set - so a just-saved edit reads back immediately - then
   * the name HomeKit last showed, then the name Hydrawise reported. The number is a sidebar affordance only; it is never part of a HomeKit name, and the controller
   * pseudo-entry carries no number at all.
   *
   * A zone row carries the bare name and its published state alongside that composed label, which is what the sidebar's own row renderer lays the number and the
   * name out in aligned columns from. The composed name stays the row's identity surface and the fallback whenever that renderer declines a row.
   */
  /* The cached standalone accessories hosting this controller's zones, keyed by relay id. A zone the user has given its own accessory carries its last-flushed
   * HomeKit name on that accessory rather than on the controller accessory, so the label arm below has to read the accessory the valve actually lives on.
   * Ownership is matched on the folded serial, exactly as the controller match above matches its own.
   */
  const zoneHosts = new Map();

  for(const accessory of cached) {

    if(isZoneAccessoryLike(accessory?.context) && (foldSerial(accessory.context.ownerController.serialNumber) === targetSerial)) {

      zoneHosts.set(accessory.context.zone.relayId, accessory);
    }
  }

  // Each zone's effective display name, resolved once and read by both consumers below - the sidebar label and the controller entry's name map - so a zone reads
  // as the same name wherever it is named. The arms and their order are the listing's own: the configured override, then the name HomeKit last showed on whichever
  // accessory hosts the valve, then the name Hydrawise reported.
  const displayNames = new Map(zones.map((zone) => [ zone.relayId,
    overrides.get(zone.relayId) ?? cachedValveName(zoneHosts.get(zone.relayId) ?? matched, zone.relayId) ?? zone.name ]));

  /* The controller's persisted schedule projection, resolved once from the same matched accessory the zones came from and shape-checked before any consumer reads
   * it. A context-less controller, a legacy cache written before this projection existed, and a corrupt entry all resolve to null, and every renderer treats that
   * as identity-only display. The two row kinds below carry the projection under DISTINCT field names - a zone row's own entry as zoneSchedule, the controller's
   * whole projection as schedule - so no consumer can mistake one shape for the other.
   */
  const schedule = isScheduleStatus(matched?.context?.schedule) ? matched.context.schedule : null;
  const zoneRows = zones.slice().sort((a, b) => a.relay - b.relay).map((zone) => ({ displayName: displayNames.get(zone.relayId),
    enabled: zoneEnabled.get(zone.relayId) ?? true, kind: "zone", name: zone.relay.toString() + ". " + displayNames.get(zone.relayId),
    ownerSerial: controller.serialNumber, relay: zone.relay, relayId: zone.relayId,
    scheduleMeta: schedule ? { activeWindowSeconds: schedule.activeWindowSeconds, asOf: schedule.asOf } : undefined,
    serialNumber: zone.relayId.toString(), zoneSchedule: schedule?.zones.find((entry) => entry.relayId === zone.relayId) }));
  const controllerEntry = { kind: "controller", name: controller.name, ...(enabled ? {} : { notice: NOTICE_DISABLED_LISTED }),
    schedule: schedule ?? undefined, serialNumber: controller.serialNumber, sidebarGroup: "hidden", zoneCount: zoneRows.length,
    zoneNames: Object.fromEntries(zones.map((zone) => [ zone.relayId.toString(), displayNames.get(zone.relayId) ])) };

  return { devices: [ controllerEntry, ...zoneRows ], error: "" };
};

/* Refine which feature options a device row shows, by the scope levels the option declares. The framework's own view-kind gate has already run by the time we are
 * asked, admitting an option to a device view when it declares either the controller or the device level; this narrows that to the kind of device in hand, so the
 * controller pseudo-entry shows only controller-scopable options and a zone shows only zone-scopable ones. The optional chaining is what keeps an entry that
 * declares no scopes from throwing here - such an entry is valid at every level - and the global case returns true unconditionally because only options the
 * framework already admitted globally ever reach it.
 */
const validOption = (device, option) => {

  if(!device) {

    return true;
  }

  if(isController(device)) {

    return option.scopes?.includes("controller") === true;
  }

  return option.scopes?.includes("device") === true;
};

/* Build one row of the device-stats grid. We construct DOM nodes directly via createElement / textContent rather than concatenating a markup string so any HTML
 * metacharacter in a field value renders as text instead of being interpreted as markup. The discovery boundary is the trust line, and treating server-reported
 * strings as data rather than HTML is the cleanest place to enforce it.
 */
const buildStatRow = (label, value, valueClassName) => {

  const item = document.createElement("div");

  item.className = "stat-item";

  const labelSpan = document.createElement("span");

  labelSpan.className = "stat-label";
  labelSpan.textContent = label;

  const valueSpan = document.createElement("span");

  valueSpan.className = valueClassName;
  valueSpan.textContent = value ?? "";

  item.append(labelSpan, valueSpan);

  return item;
};

/* Build one guidance paragraph for below the stats grid. Its text is assigned through textContent, so a notice renders as text rather than markup, matching the
 * trust boundary buildStatRow holds for every other value we display.
 */
const buildNotice = (text) => {

  const notice = document.createElement("p");

  notice.className = "hbhh-device-notice small mb-0 mt-2";
  notice.textContent = text;

  return notice;
};

// Render a span in whole minutes with its plural marker, matching the runtime's own duration wording so the Homebridge log and this panel describe the same span
// the same way. A span that has already elapsed floors at zero rather than reading as a negative countdown.
const formatMinutes = (seconds) => {

  const minutes = Math.max(Math.round(seconds / 60), 0);

  return minutes.toString() + " minute" + ((minutes !== 1) ? "s" : "");
};

/* Render an absolute instant for a reader in THIS BROWSER's timezone: the clock time alone when it falls on the same calendar day as the render, and a short
 * weekday ahead of it otherwise, so a run later in the week reads unambiguously without spelling out a full date. The runtime's own log line renders the wire's
 * controller-local start string instead, so the two surfaces can legitimately differ for a user viewing from another timezone - the epoch is the truth and each
 * surface renders it honestly for its own reader.
 */
const formatRunTime = (epochSeconds, nowSeconds) => {

  const when = new Date(epochSeconds * 1000);
  const clock = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  if(when.toDateString() === new Date(nowSeconds * 1000).toDateString()) {

    return clock;
  }

  return when.toLocaleDateString(undefined, { weekday: "short" }) + " " + clock;
};

/* Classify one zone's persisted schedule entry into the display state it reads as - the one answer the sidebar dot and the zone panel both branch on, so a dot and
 * the panel beside it can never disagree about what a zone is doing. A zone the projection does not name has no state to show, which is what a legacy cache and a
 * zone the runtime has not yet reported both look like, so those answer null.
 *
 * The wire's scheduled state splits in two here: a run inside the window the runtime marks a valve active on reads as imminent, and one beyond it as merely
 * scheduled. That window travels with the projection rather than being hardcoded here, so this and the Home app agree on when a zone counts as imminent.
 */
const zoneScheduleState = (entry, meta, nowSeconds) => {

  if(!entry) {

    return null;
  }

  switch(entry.state) {

    case "running":

      return "running";

    case "scheduled":

      return ((entry.nextRunAt - nowSeconds) <= (meta?.activeWindowSeconds ?? 0)) ? "starting-soon" : "scheduled";

    case "sensor-stopped":

      return "sensor-stopped";

    default:

      return "unscheduled";
  }
};

/* Derive one zone's schedule rows and its staleness verdict from its persisted entry, at the render pass's shared instant so every row of a pass answers to the
 * same "now". Every presentation decision lives here and nothing derived is ever persisted, which is what keeps a panel from disagreeing with its own inputs: the
 * running countdown, the next-run instant, and the staleness verdict are all computed from stored facts at the moment they are shown, and the status word itself
 * comes from the shared vocabulary rather than being spelled out again here.
 *
 * A zone with no state at all renders no schedule rows.
 */
const deriveZoneDisplay = (entry, meta, nowSeconds) => {

  const state = zoneScheduleState(entry, meta, nowSeconds);

  if(state === null) {

    return { rows: [], stale: false };
  }

  const status = [ "Status", ZONE_STATE_LABELS[state] ];

  switch(state) {

    case "running":

      // A running zone whose end instant has passed by more than the grace is evidence of a dead runtime: a live one would have reported the zone stopped.
      return { rows: [ status, [ "Time Remaining", formatMinutes(entry.endsAt - nowSeconds) ] ], stale: (nowSeconds - entry.endsAt) > STALE_GRACE };

    case "scheduled":
    case "starting-soon":

      // The two scheduled states describe the same upcoming run and differ only in the word above it, so one arm renders both.
      return { rows: [ status, [ "Next Run", formatRunTime(entry.nextRunAt, nowSeconds) ], [ "Duration", formatMinutes(entry.durationSeconds) ] ],
        stale: (nowSeconds - entry.nextRunAt) > STALE_GRACE };

    default:

      // Rain delay and the unscheduled state carry no facts beyond the word itself, so the status row is the whole display and there is no instant to age against.
      return { rows: [status], stale: false };
  }
};

/* Fold a controller's whole projection into its account-level rows: one word for what the controller is doing, the zones actually watering, and the next zone due.
 * This is a pure read of the same persisted entries the zone panels read, at the same shared instant, so the controller panel and its zones can never tell
 * different stories.
 *
 * A projection that is absent OR names no zone at all renders no schedule rows, deliberately: an account with no zones is not an account with nothing scheduled,
 * and folding an empty set to "Not scheduled" would say exactly that.
 */
const deriveControllerDisplay = (schedule, zoneNames, nowSeconds) => {

  if(!schedule?.zones.length) {

    return { rows: [], stale: false };
  }

  const running = schedule.zones.filter((zone) => zone.state === "running").toSorted((a, b) => a.relayId - b.relayId);
  const scheduled = schedule.zones.filter((zone) => zone.state === "scheduled");
  const soon = scheduled.filter((zone) => (zone.nextRunAt - nowSeconds) <= schedule.activeWindowSeconds);
  const nextUp = scheduled.reduce((earliest, zone) => (!earliest || (zone.nextRunAt < earliest.nextRunAt)) ? zone : earliest, null);
  const nameOf = (zone) => zoneNames?.[zone.relayId.toString()] ?? zone.relayId.toString();
  const rows = [];

  /* The fold's own status word. Every arm but the first names a zone state and reads its word from the shared vocabulary, so a controller and the zones beneath it
   * always use the same words; "Watering" is the fold's own summary of an account with water flowing, which no single zone state means, so it stays a word of its
   * own.
   */
  if(running.length) {

    rows.push([ "Status", "Watering" ]);
  } else if(soon.length) {

    rows.push([ "Status", ZONE_STATE_LABELS["starting-soon"] ]);
  } else if(scheduled.length) {

    rows.push([ "Status", ZONE_STATE_LABELS.scheduled ]);
  } else if(schedule.zones.some((zone) => zone.state === "sensor-stopped")) {

    rows.push([ "Status", ZONE_STATE_LABELS["sensor-stopped"] ]);
  } else {

    rows.push([ "Status", ZONE_STATE_LABELS.unscheduled ]);
  }

  // Every running zone is named, not just the first: the runtime genuinely runs zones concurrently, so a single-zone row would hide water that is flowing.
  if(running.length) {

    rows.push([ "Now Running", running.map((zone) => nameOf(zone) + " (" + formatMinutes(zone.endsAt - nowSeconds) + ")").join(", ") ]);
  }

  if(nextUp) {

    rows.push([ "Next Zone", nameOf(nextUp) + " at " + formatRunTime(nextUp.nextRunAt, nowSeconds) ]);
  }

  return { rows, stale: schedule.zones.some((zone) => ((zone.state === "running") && ((nowSeconds - zone.endsAt) > STALE_GRACE)) ||
    ((zone.state === "scheduled") && ((nowSeconds - zone.nextRunAt) > STALE_GRACE))) };
};

// The controller serial a device row's schedule belongs to: a controller pseudo-entry answers with its own serial, a zone row with the owner serial its listing
// stamped on it. One accessor, so the ticker locates the owning accessory the same way for either row kind.
const ownerSerialOf = (device) => (isController(device) ? device.serialNumber : device.ownerSerial);

// Whether a device row carries schedule surface at all - the field its own kind carries it on. A zone answers on its listing's projection metadata rather than on
// its own entry, so a zone momentarily missing from the projection still refreshes rather than going quiet for the rest of the mount.
const scheduleSurface = (device) => (isController(device) ? device.schedule !== undefined : device.scheduleMeta !== undefined);

// The instant a device row's projection was last CHANGED, read from whichever field its kind carries it on. This is what the staleness notice dates itself by.
const scheduleAsOf = (device) => (isController(device) ? device.schedule?.asOf : device.scheduleMeta?.asOf);

// A device row with its schedule fields replaced by what the cache holds now, which is what one tick renders. Building a copy rather than mutating the listing's
// own row leaves the row the framework handed us untouched, so a later render of the same selection still starts from the listing's own truth.
const withSchedule = (device, schedule) => {

  if(isController(device)) {

    return { ...device, schedule: schedule ?? undefined };
  }

  return { ...device, scheduleMeta: schedule ? { activeWindowSeconds: schedule.activeWindowSeconds, asOf: schedule.asOf } : undefined,
    zoneSchedule: schedule?.zones.find((entry) => entry.relayId === device.relayId) };
};

/* Paint the details panel for one device row. The controller pseudo-entry reports its serial number, and its zone count whenever the count is known - a controller
 * whose zones cannot be resolved carries no count, so the row is omitted rather than reporting a zero that would read as a controller with no zones. A zone reports
 * its display relay number and its relay id. Both kinds then append whatever schedule rows their persisted facts derive to, and a pseudo-entry carrying a notice
 * renders that guidance below the grid rather than as a stat cell, keeping prose out of a row layout the framework may hide as it narrows.
 *
 * This is the internal renderer, separated from the framework's hook below so the ticker can repaint the panel on screen with a fresher projection without going
 * through the framework's own render cycle. Every value is carried on the device object by the read hooks' shapes, so it reads no field those shapes do not
 * declare, and every value reaches the DOM through buildStatRow or textContent rather than a markup string.
 */
const renderDeviceDetails = ({ device, panel }) => {

  // No device specified, we must be in a global context.
  if(!device) {

    panel.replaceChildren();

    return;
  }

  // Build the device-details grid fresh so successive selections do not stack stale rows.
  const grid = document.createElement("div");

  grid.className = "device-stats-grid";

  // One instant for the whole pass, so every countdown and the staleness verdict answer to the same "now" rather than to whatever the clock read as each was built.
  const nowSeconds = Math.floor(Date.now() / 1000);
  let derived;

  if(isController(device)) {

    grid.append(buildStatRow("Serial Number", device.serialNumber, "stat-value font-monospace"));

    if(device.zoneCount !== undefined) {

      grid.append(buildStatRow("Zones", device.zoneCount.toString(), "stat-value"));
    }

    derived = deriveControllerDisplay(device.schedule, device.zoneNames, nowSeconds);
  } else {

    grid.append(buildStatRow("Zone", (device.relay ?? "").toString(), "stat-value"),
      buildStatRow("Relay ID", (device.relayId ?? "").toString(), "stat-value font-monospace"));

    derived = deriveZoneDisplay(device.zoneSchedule, device.scheduleMeta, nowSeconds);
  }

  for(const [ label, value ] of derived.rows) {

    grid.append(buildStatRow(label, value, "stat-value"));
  }

  const nodes = [grid];

  // The guidance sentence, when the read hooks attached one, follows the grid as a paragraph of its own.
  if(device.notice !== undefined) {

    nodes.push(buildNotice(device.notice));
  }

  // A schedule instant that a live runtime would already have moved past says something the rows themselves cannot: what is on screen may be describing a plugin
  // that has stopped. We date the notice by the projection's own timestamp, so the user can see how far behind it is.
  const asOf = scheduleAsOf(device);

  if(derived.stale && (asOf !== undefined)) {

    nodes.push(buildNotice("This schedule was last updated " + formatRunTime(asOf, nowSeconds) +
      " and may be out of date. Verify that Homebridge and this plugin are running."));
  }

  panel.replaceChildren(...nodes);
};

/* Put a sidebar dot into the state given, the single writer of a dot's whole presentation - its color class, its tooltip, and how a screen reader treats it. The
 * initial render and every repaint the ticker drives both come through here, so a dot's look and the word describing it can never be set by two code paths that
 * have drifted apart.
 *
 * A null state is a zone with nothing to say. Such a dot keeps its column, so the numbers and names beside it stay aligned, but it carries no color, no tooltip,
 * and no accessible name - an invisible spacer rather than a claim about the zone.
 */
const applyDotState = (dot, state) => {

  dot.classList.remove(...[...dot.classList].filter((name) => name.startsWith("hbhh-dot-")));

  if(state === null) {

    dot.removeAttribute("aria-label");
    dot.removeAttribute("role");
    dot.removeAttribute("title");
    dot.setAttribute("aria-hidden", "true");

    return;
  }

  // A colored dot is genuinely information, so it is exposed as an image with the state's own word as its accessible name rather than being hidden from assistive
  // technology as decoration would be. The tooltip carries the same word, which is what makes the color legible to anyone who has not memorized the palette.
  dot.classList.add("hbhh-dot-" + state);
  dot.removeAttribute("aria-hidden");
  dot.setAttribute("aria-label", ZONE_STATE_LABELS[state]);
  dot.setAttribute("role", "img");
  dot.setAttribute("title", ZONE_STATE_LABELS[state]);
};

/* Compose a sidebar row's content. The framework asks this once per device per sidebar build, with the very device object our own listing produced, and renders
 * whatever we return in place of the device name; a null return leaves the framework's default name rendering alone, which is how the controller pseudo-entry
 * keeps its plain label.
 *
 * A zone renders as three aligned columns - its state dot, its number, and its name - because a right-aligned number column is what makes every name start at one
 * shared edge, however many digits the numbers around it carry. A zone the configuration disables is still a real zone at Hydrawise, so it is set apart rather
 * than struck out: an italic, muted name with a tooltip saying what is different about it.
 *
 * Every value reaches the DOM through textContent, the same trust boundary buildStatRow holds - a name reported by Hydrawise or typed by the user renders as text
 * and is never parsed as markup. The framework owns the link element around this content, so nothing here is interactive: an interactive element would fight the
 * link's own delegated click.
 */
const renderDeviceContent = (device) => {

  if(device.kind !== "zone") {

    return null;
  }

  const row = document.createElement("span");

  row.className = "hbhh-zone-row";

  const dot = document.createElement("span");

  dot.className = "hbhh-zone-dot";
  dot.dataset.ownerSerial = device.ownerSerial;
  dot.dataset.relayId = device.relayId.toString();

  // The dot's identity travels in its own data attributes rather than in a closure, which is what lets the ticker find every rendered dot by query and repaint it
  // without holding a reference to the row that built it.
  applyDotState(dot, zoneScheduleState(device.zoneSchedule, device.scheduleMeta, Math.floor(Date.now() / 1000)));

  const number = document.createElement("span");

  number.className = "hbhh-zone-number";
  number.textContent = device.relay.toString() + ".";

  const name = document.createElement("span");

  name.className = "hbhh-zone-name";
  name.textContent = device.displayName ?? device.name;

  if(device.enabled === false) {

    name.classList.add("hbhh-zone-disabled");
    name.title = "Not published to HomeKit.";
  }

  row.append(dot, number, name);

  return row;
};

/* One tick of the schedule ticker, refreshing both schedule-bearing surfaces from ONE read of the accessory cache: the sidebar's zone dots and the details panel on
 * screen. A poll that landed since the last render therefore shows up in both at once, and a running countdown keeps counting down while the user watches. The read
 * is homebridge.getCachedAccessories, a LOCAL call, so the webUI's zero-automatic-cloud-call property is untouched by the cadence.
 *
 * The two surfaces are reached differently, and deliberately so. The panel belongs to one render, so its repaint is gated on that render still being the one on
 * screen; the dots are found by query at the top of the tick, so they belong to whatever the sidebar is actually showing and need no such gate.
 */
const scheduleTick = async () => {

  const context = renderContext;
  const dots = document.querySelectorAll("#devicesContainer .hbhh-zone-dot[data-relay-id]");
  const wantsPanel = Boolean(context?.device) && scheduleSurface(context.device);

  // Neither surface reads a schedule, so there is nothing to refresh and the cache is left alone. The interval itself keeps running until the mount aborts, which a
  // no-op this cheap makes entirely acceptable.
  if(!wantsPanel && !dots.length) {

    return;
  }

  const sequence = ++tickSequence;

  /* Supersede rather than latch. The plugin-ui bridge's RPC carries no timeout of its own, so a read can hang forever and a boolean busy flag would latch the
   * ticker shut for the rest of the mount; bounding an in-flight read at two ticks lets a later tick proceed while the checks below keep the older read's late
   * resolution harmless.
   */
  if((inFlightTick !== null) && ((sequence - inFlightTick) < 2)) {

    return;
  }

  inFlightTick = sequence;

  let cached;

  try {

    cached = await homebridge.getCachedAccessories();
  } catch {

    // A rejected read clears its own record and leaves the last render standing: a failed refresh is no reason to blank a panel that is showing good data.
    if(inFlightTick === sequence) {

      inFlightTick = null;
    }

    return;
  }

  // A read that a later tick already superseded is dropped rather than painted, since the newer read is the one that describes the cache as it is now.
  if(inFlightTick !== sequence) {

    return;
  }

  inFlightTick = null;

  /* The sidebar dots first, and unconditionally: they were queried from the DOM rather than carried on a render, so they are the sidebar the user is looking at
   * whatever the panel beside them is showing. Dots are grouped by their owning controller so each controller's accessory is located and validated once however
   * many zones it lists, and the whole pass shares one instant, so no two dots of a pass answer to a different "now".
   *
   * A sidebar rebuilt while this read was in flight has already painted its own fresh dots from the listing that rebuilt it, so the nodes gathered above are then
   * detached and writing to them changes nothing the user can see.
   */
  const nowSeconds = Math.floor(Date.now() / 1000);

  for(const [ serial, group ] of Map.groupBy(dots, (dot) => foldSerial(dot.dataset.ownerSerial))) {

    const owner = matchControllerAccessory(cached, serial);
    const schedule = isScheduleStatus(owner?.context?.schedule) ? owner.context.schedule : null;
    const meta = schedule ? { activeWindowSeconds: schedule.activeWindowSeconds, asOf: schedule.asOf } : undefined;

    for(const dot of group) {

      applyDotState(dot, zoneScheduleState(schedule?.zones.find((zone) => zone.relayId === Number(dot.dataset.relayId)), meta, nowSeconds));
    }
  }

  // The dots were this tick's whole work when the view on screen reads no schedule of its own.
  if(!wantsPanel) {

    return;
  }

  // Discard unless the view that dispatched this read is still the one on screen. The context object is minted fresh on every render, so an identity check asks
  // exactly the right question - is this still the same render - and a read that resolves after the user navigated leaves the panel alone.
  if(renderContext !== context) {

    return;
  }

  const owner = matchControllerAccessory(cached, foldSerial(ownerSerialOf(context.device)));
  const schedule = isScheduleStatus(owner?.context?.schedule) ? owner.context.schedule : null;

  renderDeviceDetails({ device: withSchedule(context.device, schedule), panel: context.panel });
};

/* Show the details for the selected sidebar entry. The framework invokes this with a single options bag carrying the selected device, the panel element to render
 * into, and the mount's lifecycle signal, and this hook consumes all three: it paints through the internal renderer above and arms the schedule ticker against the
 * mount.
 *
 * The render-context bookkeeping runs UNCONDITIONALLY on every invocation - a fresh object per render, schedule-bearing or not and an undefined device included -
 * so the tick guards always describe the view actually on screen. A fresh object per render is exactly what gives the ticker's same-object discard its meaning.
 */
const showDeviceDetails = ({ device, panel, signal }) => {

  renderContext = { device, panel };

  renderDeviceDetails(renderContext);

  // Arming is conditional, unlike the bookkeeping above: there is nothing to tick for a view that reads no schedule.
  if(!device || !scheduleSurface(device)) {

    return;
  }

  /* Arm the ticker once for this mount. The framework hands every render within one mount the SAME signal object - switching between zones, the controller entry,
   * and back mints no new one and fires no abort - so the signal is the mount's identity, and keying the arm on the interval handle is what keeps a panel switch
   * from stacking a second interval. The teardown is registered BEFORE the interval, because the handle is this block's own re-entry guard: arming first and then
   * throwing on the registration would leave an interval nothing can stop behind a guard that never re-enters.
   *
   * The MOUNT signal, not the page epoch, is the deliberate lifetime. This data is per-selected-device and its read is a cheap local call, so the ticker dies with
   * the view and re-arms on the next mount; nothing here is worth keeping warm across a navigation the way an expensive cloud fetch would be.
   */
  if(scheduleTimer === undefined) {

    signal.addEventListener("abort", () => {

      clearInterval(scheduleTimer);
      scheduleTimer = undefined;
      renderContext = null;
      inFlightTick = null;
    }, { once: true });

    scheduleTimer = setInterval(() => void scheduleTick(), SCHEDULE_TICK_MS);
  }

  // A wake from an OS-level freeze should not have to wait out the remainder of a tick, so the page's resume detector runs one the moment it notices. It rides the
  // same mount signal the interval does, and the mount-identity guard registers it exactly once per mount.
  if(scheduleMountSignal !== signal) {

    scheduleMountSignal = signal;
    ui.liveness.onResume(() => void scheduleTick(), { signal });
  }
};

// Parameters for our feature options webUI.
const featureOptionsParams = {

  getControllers: getControllers,
  getDevices: getDevices,
  infoPanel: showDeviceDetails,
  sidebar: {

    deviceContent: renderDeviceContent,
    deviceLabel: "Zones"
  },
  ui: {

    isController: isController,
    validOption: validOption
  }
};

// Parameters for our plugin webUI.
const webUiParams = {

  featureOptions: featureOptionsParams,
  firstRun: {

    isRequired: firstRunIsRequired,
    onStart: firstRunOnStart,
    onSubmit: firstRunOnSubmit
  },
  name: "Hydrawise"
};

// Instantiate the webUI.
const ui = new webUi(webUiParams);

/* The HBHH-owned refresh handler. This is the webUI's only on-demand cloud touch: on click it fetches a fresh controller list, then - only for controllers it cannot
 * resolve from the accessory cache (the disabled ones) - fetches their zones, storing both in the session stores the read hooks consult. A fresh controller list is
 * one Hydrawise call; the zones fetch adds one request that loops server-side over the context-less controllers, so a successful refresh drives 1 + K upstream calls,
 * K being the number of disabled controllers (possibly zero). A failed controllers fetch stops at that one call and changes nothing - the cached view stands. The
 * in-flight guard disables the control across the whole handler and the try/finally restores it on every exit path, so a click cannot overlap itself.
 *
 * The refreshed roster reaches the view along one of two paths, chosen by what the sidebar actually rendered. A rendered listing takes the framework's surgical
 * repaint, which rebuilds the controller list alone and leaves the rest of the view standing. A listing the framework never rendered - it showed its no-controllers
 * message instead - has no model for that repaint to act on, so the handler re-enters the page through the menu affordance and holds the in-flight guard until the
 * rebuilt list lands in the container, or until the bounded wait expires for a re-entered cycle that dies before rendering.
 */
const onRefreshControllers = async () => {

  const button = document.getElementById("hbhhRefreshControllers");

  if(button) {

    button.disabled = true;
  }

  try {

    const apiKey = hydrawiseConfig.apiKey((await homebridge.getPluginConfig())?.[0]);
    const { controllers, error } = await homebridge.request("/refreshControllers", { apiKey });

    // A failed refresh surfaces its reason and changes nothing: the context view stands rather than being masked by a failure.
    if(error) {

      notifyError(error);

      return;
    }

    // Update the session roster from the refreshed controllers.
    const identities = Array.isArray(controllers) ? controllers.filter(isControllerIdentity) : [];

    seedSessionControllers(identities);

    // Determine which refreshed controllers have no live accessory. A cache-read failure here leaves the list empty, so we skip the zones fetch rather than fetch
    // every controller's zones; the roster refresh above still stands.
    let contextless = [];

    try {

      const cached = await homebridge.getCachedAccessories();
      const contextSerials = new Set();

      for(const accessory of cached) {

        if(isControllerIdentity(accessory?.context?.controller)) {

          contextSerials.add(foldSerial(accessory.context.controller.serialNumber));
        }
      }

      contextless = identities.filter((identity) => !contextSerials.has(foldSerial(identity.serialNumber)));
    } catch(err) {

      notifyError((err instanceof Error) ? err.message : String(err));
    }

    // Fetch the zones for the context-less controllers - the owner-ruled explicit fetch that keeps a disabled controller's zones listable - and store them by serial.
    if(contextless.length > 0) {

      const { error: zonesError, zones } = await homebridge.request("/refreshZones", { apiKey,
        controllers: contextless.map((identity) => ({ controllerId: identity.controllerId, serialNumber: identity.serialNumber })) });

      if(zonesError) {

        notifyError(zonesError);
      } else if(zones && (typeof zones === "object")) {

        for(const [ serial, zoneList ] of Object.entries(zones)) {

          if(Array.isArray(zoneList) && zoneList.every(isZoneIdentity)) {

            sessionZones.set(foldSerial(serial), zoneList);
          }
        }
      }
    }

    /* A rendered controllers container always carries at least the Global Options link, so an empty container means the framework showed its no-controllers
     * message and never dispatched its model - the surgical sidebar repaint cannot render in that state, because the nav view yields until the model loads.
     * Re-enter through the framework's own menu affordance, which re-runs the full show cycle against the freshly seeded session stores, and hold the
     * in-flight guard until the rebuilt controller list lands (or the bounded wait expires, when the re-entered cycle dies before rendering - the
     * connection-error retry governs there), so a second click cannot spend cloud calls against a rebuild already in flight. In every other case, repaint
     * the sidebar surgically without disturbing the rendered view.
     */
    const container = document.getElementById("controllersContainer");

    if(container && (container.childElementCount === 0)) {

      const rebuilt = new Promise((resolve) => {

        let expiry = null;

        const observer = new MutationObserver(() => {

          if(container.childElementCount > 0) {

            observer.disconnect();
            clearTimeout(expiry);
            resolve();
          }
        });

        expiry = setTimeout(() => {

          observer.disconnect();
          resolve();
        }, REFRESH_REBUILD_WAIT);

        observer.observe(container, { childList: true });
      });

      document.getElementById("menuFeatureOptions")?.click();
      await rebuilt;
    } else {

      await ui.featureOptions.refreshControllers();
    }
  } finally {

    if(button) {

      button.disabled = false;
    }
  }
};

// Wire the HBHH-owned refresh control. The button lives in index.html, present before this module loads, so we bind its listener once at load.
document.getElementById("hbhhRefreshControllers")?.addEventListener("click", () => void onRefreshControllers());

// Display the webUI.
ui.show();
