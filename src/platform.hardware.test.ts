/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * platform.hardware.test.ts: The platform's optional hardware enrichment, exercised against a REAL HydrawisePlatform whose account-credentialed client is a
 * recording double, so the credential gate, the one-shot dispatch, and the distribution all run production code with no cloud call of any kind.
 *
 * Two things are being told apart throughout. The GATE decides whether a client exists at all, and it answers to the configured credentials; the DISTRIBUTION
 * decides which controller receives which facts, and it answers to the correlation id v1 and the account API agree about. A test that conflated them could pass
 * with the wrong controller enriched.
 */
// The Hydrawise API wire shapes use snake_case keys such as controller_id, so camelcase is disabled here to let the controller fixture mirror the wire verbatim.
/* eslint-disable camelcase */
import { Characteristic, Service } from "./testing/hap.helpers.ts";
import type { CharacteristicType, TestAccessory } from "./testing/hap.helpers.ts";
import { HOMEBRIDGE_UNKNOWN_FIRMWARE, HYDRAWISE_V2_BUDGET_CALLS } from "./settings.ts";
import { buildPlatform, installMockDispatcher, installV2Client, makeTestV2Client, programJsonReply, v2BudgetOf, waitFor } from "./testing/platform.helpers.ts";
import { describe, test } from "node:test";
import { makeCustomerDetails, normalSchedule } from "./api.helpers.ts";
import type { HydrawiseControllerHardware } from "./types.ts";
import assert from "node:assert/strict";
import { syntheticController } from "./api.fixtures.ts";

const DID_FINISH_LAUNCHING = "didFinishLaunching";
const SHUTDOWN = "shutdown";

// The configured-option entries that carry an account login, which is the only home those credentials have.
const CREDENTIAL_OPTIONS = [ "Enable.Account.Password=test-password", "Enable.Account.Username=test-user" ];

// A second controller, so a distribution test has two candidates to get wrong. Its id and serial differ from the synthetic controller's in every digit that
// matters, and the UUID the platform generates from its id is what the accessory lookups below match on.
const SECOND_CONTROLLER = { ...syntheticController, controller_id: 500002, name: "Second Controller", serial_number: "SN9Z8Y7X6W5" };

// The facts each controller reports, deliberately distinguishable so an assertion about which one landed where cannot pass by coincidence.
const FIRST_HARDWARE: HydrawiseControllerHardware = { firmware: "4.76", model: "HCC 38 Zones" };
const SECOND_HARDWARE: HydrawiseControllerHardware = { firmware: "2.11", model: "Pro-HC 12 Zones" };

// One accessory's information characteristic, which is what HomeKit shows the user for it. Every assertion below reads through here, so no test body has to
// re-derive where a model or a firmware version lives.
function informationValue(accessory: TestAccessory, characteristic: CharacteristicType): unknown {

  return accessory.getService(Service.AccessoryInformation)?.getCharacteristic(characteristic).value;
}

describe("HydrawisePlatform hardware enrichment gate", () => {

  test("configures no account-credentialed client when neither credential is set", (t) => {

    const { emit, platform } = buildPlatform();

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.hasV2Client, false, "an install carrying only an API key builds no client at all");
  });

  test("configures no client when only the username is set", (t) => {

    const { emit, platform } = buildPlatform({ options: ["Enable.Account.Username=test-user"] });

    t.after(() => emit(SHUTDOWN));

    // Half a login cannot authenticate, so building a client on it would only spend calls failing. The gate is an AND for exactly that reason.
    assert.equal(platform.hasV2Client, false, "a username with no password builds no client");
  });

  test("configures no client when only the password is set", (t) => {

    const { emit, platform } = buildPlatform({ options: ["Enable.Account.Password=test-password"] });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.hasV2Client, false, "a password with no username builds no client");
  });

  test("configures a client, and its own rate budget, when both credentials are set", (t) => {

    const { emit, lines, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));

    assert.equal(platform.hasV2Client, true, "a complete login builds the client");
    assert.equal(v2BudgetOf(platform).capacity, HYDRAWISE_V2_BUDGET_CALLS, "the account-credentialed budget carries its own ceiling");
    assert.ok(lines().some(line => (line.level === "info") && line.message.includes("Enhanced features are enabled")),
      "turning on an off-by-default capability is reported at startup");
  });
});

describe("HydrawisePlatform hardware distribution", () => {

  test("hands each controller the hardware its own correlation id names", async (t) => {

    const { emit, platform, registered, updated } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    /* The map is deliberately keyed in the OPPOSITE order to the account's controller list, and both entries carry facts the other controller could plausibly own.
     * A distribution that matched positionally rather than by id would swap them, and each assertion below would then read the sibling's model.
     */
    installV2Client(platform, makeTestV2Client(new Map([ [ SECOND_CONTROLLER.controller_id, SECOND_HARDWARE ],
      [ syntheticController.controller_id, FIRST_HARDWARE ] ])).client);

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails({ controllers: [ { ...syntheticController }, { ...SECOND_CONTROLLER } ] }));
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);

    // The enrichment is dispatched rather than awaited, so each wait is on the characteristic actually landing rather than on discovery returning.
    const first = await waitFor(() => registered.find(accessory => accessory.UUID === syntheticController.controller_id.toString()));
    const second = await waitFor(() => registered.find(accessory => accessory.UUID === SECOND_CONTROLLER.controller_id.toString()));

    await waitFor(() => (informationValue(first, Characteristic.Model) === FIRST_HARDWARE.model) ? true : undefined);
    await waitFor(() => (informationValue(second, Characteristic.Model) === SECOND_HARDWARE.model) ? true : undefined);

    assert.equal(informationValue(first, Characteristic.FirmwareRevision), FIRST_HARDWARE.firmware, "the first controller shows its own firmware");
    assert.equal(informationValue(second, Characteristic.FirmwareRevision), SECOND_HARDWARE.firmware, "the second controller shows its own firmware");

    // The durable half of the same claim: the characteristics ARE the store, so each accessory was flushed once with its own values and the next restart reads
    // them straight back.
    assert.ok(updated.some(batch => batch.includes(first)), "the first controller's accessory was flushed to the disk cache");
    assert.ok(updated.some(batch => batch.includes(second)), "the second controller's accessory was flushed to the disk cache");
  });

  test("a failed fetch enriches nothing and leaves every placeholder standing", async (t) => {

    const { emit, platform, registered } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const { client, fetches } = makeTestV2Client(null);

    installV2Client(platform, client);
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);

    const accessory = await waitFor(() => registered[0]);

    await waitFor(() => (fetches() >= 1) ? true : undefined);

    /* A failed enrichment is not a failed startup. The accessory keeps exactly the information a user without credentials would see, which is the display the whole
     * credential gate falls back to, and it persists nothing it did not learn.
     */
    assert.equal(informationValue(accessory, Characteristic.Model), "Hydrawise", "a failed fetch leaves the product-line placeholder in place");
    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), Characteristic.FirmwareRevision.DEFAULT_VALUE,
      "a failed fetch leaves the firmware exactly as HAP constructed it, because the credentialed path never writes it");
  });

  test("a second discovery pass spends no second fetch", async (t) => {

    const { emit, lines, platform } = buildPlatform({ options: CREDENTIAL_OPTIONS });

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    const { client, fetches } = makeTestV2Client(new Map([[ syntheticController.controller_id, FIRST_HARDWARE ]]));

    installV2Client(platform, client);
    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (fetches() >= 1) ? true : undefined);

    // Re-entering discovery is a real cadence - the launch event can fire again, and the supervisor can re-enter the loop - while hardware is static, so the query
    // is worth exactly one call for the life of the plugin. The counter is what catches a re-entry that spent another.
    const connections = lines().filter(line => line.message.includes("Successfully connected")).length;

    emit(DID_FINISH_LAUNCHING);
    await waitFor(() => (lines().filter(line => line.message.includes("Successfully connected")).length > connections) ? true : undefined);

    assert.equal(fetches(), 1, "a re-entered discovery pass should spend no second fetch");
  });

  test("no fetch fires at all without credentials", async (t) => {

    const { emit, registered } = buildPlatform();

    t.after(() => emit(SHUTDOWN));
    await using dispatcher = installMockDispatcher();

    programJsonReply(dispatcher.agent, "customerdetails.php", makeCustomerDetails());
    programJsonReply(dispatcher.agent, "statusschedule.php", normalSchedule());

    emit(DID_FINISH_LAUNCHING);

    const accessory = await waitFor(() => registered[0]);

    /* The parity case stated as an assertion: an install with no credentials shows exactly what it always has. The MockAgent has net connect disabled and
     * intercepts only the two key-based endpoints, so a request escaping the credential gate would fail this test loudly rather than reaching the network.
     */
    assert.equal(informationValue(accessory, Characteristic.Manufacturer), "Hunter", "the manufacturer is unchanged");
    assert.equal(informationValue(accessory, Characteristic.Model), "Hydrawise", "the model is the product-line placeholder");
    assert.equal(informationValue(accessory, Characteristic.FirmwareRevision), HOMEBRIDGE_UNKNOWN_FIRMWARE,
      "the firmware is the unknown marker Homebridge itself uses");
  });
});
