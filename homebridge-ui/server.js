/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * server.js: homebridge-hunter-hydrawise webUI server API.
 */
"use strict";

import { featureOptionCategories, featureOptions } from "../dist/options.js";
import { HYDRAWISE_API_TIMEOUT } from "../dist/settings.js";
import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";

// The base URL for every Hydrawise cloud API call this server makes.
const HYDRAWISE_API_BASE = "https://api.hydrawise.com/api/v1/";

// The generic failure sentence for a controllers fetch that failed or returned a malformed response.
const GENERIC_CONTROLLERS_ERROR = "Unable to retrieve your Hydrawise irrigation controllers. Please check your API key and try again.";

// The generic failure sentence for a zones fetch that failed or returned a malformed response.
const GENERIC_DEVICES_ERROR = "Unable to retrieve the zones for this irrigation controller. Please try again.";

// Translate an HTTP status into a specific user-facing sentence, or an empty string to let the caller substitute its own generic sentence for an unmapped status.
const errorSentenceForStatus = (status) => {

  switch(status) {

    case 404:

      return "Invalid API key. Please check your Hydrawise API key.";

    case 429:

      return "The Hydrawise API rate limit has been exceeded. Please try again in a few minutes.";

    default:

      return "";
  }
};

// Return a timeout-specific sentence when a fetch aborted on the request timeout, or an empty string otherwise so the caller substitutes its generic sentence.
// AbortSignal.timeout rejects with a TimeoutError, and any other abort surfaces as an AbortError; both mean the Hydrawise API did not answer in time.
const timeoutSentence = (error) => {

  if((error instanceof DOMException) && ((error.name === "AbortError") || (error.name === "TimeoutError"))) {

    return "The Hydrawise API took too long to respond. Please try again.";
  }

  return "";
};

// Shape a controllers response so the illegal shapes are unconstructable. A null list marks a failed or malformed fetch and always resolves with a non-empty error, so
// the webUI never mistakes a failure for a legitimately empty account; a non-null list - even an empty one - is a successful fetch that resolves with no error.
const shapeControllers = (controllers, error) => {

  if(!controllers) {

    return { controllers: [], error: error.length ? error : GENERIC_CONTROLLERS_ERROR };
  }

  return { controllers, error: "" };
};

// Retrieve the account's irrigation controllers from the Hydrawise cloud API. The apiKey travels on the request from the webUI's live config, so a first-run key that
// has not yet been written to disk still resolves. Every failure path resolves through the shaping helper, so the endpoint always returns a well-formed shape.
const fetchControllers = async (apiKey) => {

  try {

    const params = new URLSearchParams();

    params.set("api_key", apiKey);

    const response = await fetch(HYDRAWISE_API_BASE + "customerdetails.php?" + params.toString(), { signal: AbortSignal.timeout(HYDRAWISE_API_TIMEOUT * 1000) });

    if(!response.ok) {

      return shapeControllers(null, errorSentenceForStatus(response.status));
    }

    const account = await response.json();

    if(!Array.isArray(account?.controllers)) {

      return shapeControllers(null, "Received an unexpected response from the Hydrawise API.");
    }

    // The webUI reads name and serialNumber to list a controller and scope its options, and controllerId to spend exactly one status call per controller when it
    // explicitly refreshes a disabled controller's zones.
    return shapeControllers(account.controllers.map((controller) => ({ controllerId: controller.controller_id, name: controller.name,
      serialNumber: controller.serial_number })), "");
  } catch(error) {

    return shapeControllers(null, timeoutSentence(error));
  }
};

// Retrieve the zone lists for an explicit set of controllers from the Hydrawise cloud API, keyed by each controller's serial so the webUI can store them against the
// same identity it reads back from the accessory cache. The status endpoint has no batch form, so we loop one request per controller; the caller only ever hands us
// the controllers it could not resolve from the accessory cache, so the loop count is the number of context-less controllers, not the whole account. The requests run in
// sequence deliberately, to stay clear of the account's 30-calls-per-5-minutes rate limit that this budget shares with the plugin's own polling loop. Any failure
// resolves with a non-empty error and an empty map, so a partial refresh never stores a half-built result.
const fetchZones = async (apiKey, controllers) => {

  const zones = {};

  for(const controller of controllers) {

    try {

      const params = new URLSearchParams();

      params.set("api_key", apiKey);
      params.set("controller_id", String(controller.controllerId));

      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(HYDRAWISE_API_BASE + "statusschedule.php?" + params.toString(), { signal: AbortSignal.timeout(HYDRAWISE_API_TIMEOUT * 1000) });

      if(!response.ok) {

        const sentence = errorSentenceForStatus(response.status);

        return { error: sentence.length ? sentence : GENERIC_DEVICES_ERROR, zones: {} };
      }

      // eslint-disable-next-line no-await-in-loop
      const status = await response.json();

      if(!Array.isArray(status?.relays)) {

        return { error: GENERIC_DEVICES_ERROR, zones: {} };
      }

      // Project each reported zone to the persisted identity shape - the same fields, in the same order, the runtime writes into accessory context - so the webUI
      // renders a refreshed controller's zones exactly as it renders a cached one.
      zones[controller.serialNumber] = status.relays.slice().sort((a, b) => a.relay - b.relay).map((zone) => ({ name: zone.name, relay: zone.relay,
        relayId: zone.relay_id }));
    } catch(error) {

      const sentence = timeoutSentence(error);

      return { error: sentence.length ? sentence : GENERIC_DEVICES_ERROR, zones: {} };
    }
  }

  return { error: "", zones };
};

class PluginUiServer extends HomebridgePluginUiServer {

  constructor() {

    super();

    // Register getOptions() with the Homebridge server API.
    this.onRequest("/getOptions", () => ({ categories: featureOptionCategories, options: featureOptions }));

    // Register the login handler with the Homebridge server API, validating the user's Hydrawise API key against the cloud API. The response is a shaped object: a
    // result sentence ("success" or the failure reason) plus the parsed controller identities, so a first-run user's controllers seed the webUI immediately from the
    // one call the login already makes rather than a second round trip. The fetch shares the conventions every other call here uses - the request-timeout guard, the
    // base-URL constant, and errorSentenceForStatus - with a default branch that reports an unmapped status by its code and body.
    this.onRequest("/login", async (apiKey) => {

      try {

        const params = new URLSearchParams();

        params.set("api_key", apiKey);

        const response = await fetch(HYDRAWISE_API_BASE + "customerdetails.php?" + params.toString(), { signal: AbortSignal.timeout(HYDRAWISE_API_TIMEOUT * 1000) });

        if(!response.ok) {

          const sentence = errorSentenceForStatus(response.status);

          return { controllers: [], result: sentence.length ? sentence : (response.status.toString() + ": " + await response.text()) };
        }

        const account = await response.json();
        const controllers = Array.isArray(account?.controllers) ? account.controllers.map((controller) => ({ controllerId: controller.controller_id,
          name: controller.name, serialNumber: controller.serial_number })) : [];

        return { controllers, result: "success" };
      } catch(error) {

        const sentence = timeoutSentence(error);

        return { controllers: [], result: sentence.length ? sentence : GENERIC_CONTROLLERS_ERROR };
      }
    });

    // Return the account's irrigation controllers on an explicit user refresh. This is a fresh controller-list fetch with no caching: the webUI's automatic listings
    // read the accessory cache, so this endpoint runs only when the user clicks the refresh control.
    this.onRequest("/refreshControllers", (payload) => fetchControllers(payload?.apiKey ?? ""));

    // Return the zones for an explicit set of context-less controllers on a user refresh. The payload carries the controllers the webUI could not resolve from the
    // accessory cache, each with the controllerId to fetch and the serial to key the result on; this endpoint runs only from the refresh handler.
    this.onRequest("/refreshZones", (payload) => fetchZones(payload?.apiKey ?? "", Array.isArray(payload?.controllers) ? payload.controllers : []));

    this.ready();
  }
}

(() => new PluginUiServer())();
