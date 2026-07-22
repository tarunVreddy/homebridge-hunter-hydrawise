/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * settings.test.ts: The plugin constants. Small honest pins so a change to a rate-limit-sensitive timing value or a platform identity is a deliberate, visible edit.
 */
import { HYDRAWISE_ACTIVE_ZONE_INDICATOR, HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_API_TIMEOUT, HYDRAWISE_MQTT_TOPIC, HYDRAWISE_SUSPEND_DURATION,
  PLATFORM_NAME, PLUGIN_NAME } from "./settings.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("settings", () => {

  test("pins the API timing constants", () => {

    assert.equal(HYDRAWISE_API_TIMEOUT, 7, "the per-request timeout is 7 seconds");
    assert.equal(HYDRAWISE_API_RETRY_INTERVAL, 60, "the retry interval is 60 seconds");
    assert.equal(HYDRAWISE_API_JITTER, 0.2, "the poll jitter is 0.2 seconds");
    assert.equal(HYDRAWISE_ACTIVE_ZONE_INDICATOR, 3600, "a zone within 3600 seconds of running is marked active");
    assert.equal(HYDRAWISE_SUSPEND_DURATION, 31556926, "the suspend-all offset is one year in seconds");
  });

  test("pins the MQTT and platform identity constants", () => {

    assert.equal(HYDRAWISE_MQTT_TOPIC, "hydrawise", "the default MQTT topic prefix is hydrawise");
    assert.equal(PLATFORM_NAME, "Hydrawise", "the platform name is Hydrawise");
    assert.equal(PLUGIN_NAME, "homebridge-hunter-hydrawise", "the plugin name is homebridge-hunter-hydrawise");
  });
});
