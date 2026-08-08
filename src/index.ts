/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * index.ts: homebridge-hydrawise plugin registration.
 */

/* The explicit-resource-management floor bridge, and deliberately the FIRST import this process makes. It installs DisposableStack and its siblings as globals on
 * any runtime below the Node release that ships them, so every construction site anywhere in the program afterwards reads against a global that is guaranteed to
 * exist. Position is the whole guarantee: an install that ran after a module which constructs a stack during its own evaluation would arrive too late.
 *
 * The gesture is temporary by design. When this package's engines.node reaches that release the install is redundant, and the runtime-floor conformance test
 * fails with the enumerated cleanup that removes this import along with the rest of the gesture.
 */
import "homebridge-plugin-utils/polyfills";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import type { API } from "homebridge";
import { HydrawisePlatform } from "./platform.ts";

// Register our platform with homebridge.
export default (api: API): void => {

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HydrawisePlatform);
};
