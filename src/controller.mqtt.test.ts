/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * controller.mqtt.test.ts: The controller's MQTT surface, driven through the recording MQTT double's invokeGet / invokeSet knobs. Covers the status
 * JSON the get handler answers, the set-command grammar (start / stop and the invalid-zone and invalid-command throws), and the per-poll publish including the
 * guarded-dispatch path that lands a publish rejection in the log rather than as an unhandled rejection.
 */

// The Hydrawise API wire shapes use snake_case keys such as relay_id and controller_id, so camelcase is disabled here to let these literals mirror the wire verbatim.
/* eslint-disable camelcase */
import type { HydrawiseZoneConfig, StatusScheduleResponse } from "./types.ts";
import { assertNoUnhandledRejections, firstOf } from "./testing.helpers.ts";
import { buildController, loggedAt, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { fastPolling, makeStatusSchedule, makeZone } from "./api.helpers.ts";
import { Service } from "./testing/hap.helpers.ts";
import assert from "node:assert/strict";
import { bareSensors } from "./api.fixtures.ts";

function schedule(zones: HydrawiseZoneConfig[]): StatusScheduleResponse {

  return fastPolling(makeStatusSchedule({ relays: zones, sensors: bareSensors }));
}

function runningZone(): HydrawiseZoneConfig {

  return makeZone({ name: "Alpha", relay: 1, relay_id: 700001, run: 600, time: 1, timestr: "" });
}

describe("HydrawiseController MQTT", () => {

  test("the get handler answers the current status as parseable JSON", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]),
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);

    const payload = mqtt.invokeGet("controller");

    assert.ok(payload, "the get handler should answer a payload");

    const parsed = JSON.parse(payload) as { name: string; relay: number }[];
    const zone = firstOf(parsed, "status zone");

    assert.equal(zone.relay, 1, "the status JSON should carry the zone relay number");
    assert.equal(zone.name, "Alpha", "the status JSON should carry the zone name");
  });

  test("the set handler runs a zone on a start command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await mqtt.invokeSet("controller", "start 1 300");

    const command = firstOf(h.retrieve.callsTo("setzone.php"), "setzone call");

    assert.equal(command.params?.["action"], "run", "a start command should send the run action");
    assert.equal(command.params?.["custom"], "300", "a start command should carry the requested duration");
  });

  test("the set handler stops a zone on a stop command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await mqtt.invokeSet("controller", "stop 1");

    const command = firstOf(h.retrieve.callsTo("setzone.php"), "setzone call");

    assert.equal(command.params?.["action"], "stop", "a stop command should send the stop action");
  });

  test("a zero-duration start hits the guard and sends no wire command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => {

      recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]), kind: "response" });
      recorder.programDefault("setzone.php", { body: { message: "", message_type: "info" }, kind: "response" });
    }, signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await mqtt.invokeSet("controller", "start 1 0");

    // A run command with a non-positive duration returns null from sendCommand before it reaches the wire, so no setzone call is recorded.
    assert.equal(h.retrieve.callsTo("setzone.php").length, 0, "a zero-duration start should send no setzone command");
  });

  test("the set handler throws on an unknown zone", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]),
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await assert.rejects(() => mqtt.invokeSet("controller", "start 99 300"), /Invalid zone specified/, "a command for an unknown zone should throw");
  });

  test("the set handler throws on an unknown command", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]),
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => h.accessory.getServiceById(Service.Valve, "700001") ? true : undefined);
    await assert.rejects(() => mqtt.invokeSet("controller", "toggle 1"), /Invalid command/, "an unknown command should throw");
  });

  test("each poll publishes the controller status", async (t) => {

    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]),
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    await waitFor(() => (mqtt.publishes.length >= 1) ? true : undefined);

    const published = firstOf(mqtt.publishes, "MQTT publish");

    assert.ok(published.topic.endsWith("controller"), "the publish topic should be the controller topic");
    assert.ok(published.payload.includes("Alpha"), "the published payload should carry the zone status");
  });

  test("a publish rejection is guarded into the log rather than an unhandled rejection", async (t) => {

    const cleanup = assertNoUnhandledRejections();
    const h = buildController({ mqtt: true, program: (recorder) => recorder.programDefault("statusschedule.php", { body: schedule([runningZone()]),
      kind: "response" }), signalAborted: false });

    t.after(() => h.abort());

    assert.ok(h.mqtt, "the MQTT recorder should be attached");
    const mqtt = h.mqtt;

    // Arm the publish rejection before the first poll's publish fires; the guarded dispatch must route it to the log.
    mqtt.publishRejection = new Error("broker gone");

    await waitFor(() => loggedAt(h.lines(), "error", "MQTT publish (controller) handler failed") ? true : undefined);

    assert.ok(loggedAt(h.lines(), "error", "MQTT publish (controller) handler failed"), "a rejected publish should be logged by the guarded dispatch");

    cleanup();
  });
});
