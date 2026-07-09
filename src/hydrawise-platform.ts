/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-platform.ts: homebridge-hunter-hydrawise platform class.
 */
import type { API, DynamicPlatformPlugin, HAP, Logging, MatterAccessory, PlatformAccessory, PlatformConfig } from "homebridge";
import type { CustomerDetailsResponse, HydrawiseControllerConfig, HydrawiseZoneConfig, StatusScheduleResponse } from "./hydrawise-types.js";
import { type Dispatcher, Pool, errors, interceptors, request } from "undici";
import { FeatureOptions, retry, sleep } from "homebridge-plugin-utils";
import { HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_API_STARTUP_RETRY_INTERVAL, HYDRAWISE_API_TIMEOUT, HYDRAWISE_MQTT_TOPIC, PLATFORM_NAME, PLUGIN_NAME  } from "./settings.js";
import { type HydrawiseOptions, featureOptionCategories, featureOptions } from "./hydrawise-options.js";
import { MqttClient, type Nullable } from "homebridge-plugin-utils";
import { APIEvent } from "homebridge";
import { HydrawiseController } from "./hydrawise-controller.js";
import { HydrawiseMatterController } from "./hydrawise-matter-controller.js";
import { STATUS_CODES } from "node:http";
import util from "node:util";

export class HydrawisePlatform implements DynamicPlatformPlugin {

  private readonly accessories: PlatformAccessory[];
  public readonly matterAccessories: Map<string, MatterAccessory>;
  private account: CustomerDetailsResponse;
  public readonly api: API;
  private dispatcher?: Dispatcher;
  public readonly featureOptions: FeatureOptions;
  public config: HydrawiseOptions;
  public readonly configuredDevices: { [index: string]: HydrawiseController | undefined };
  public readonly configuredMatterDevices: { [index: string]: HydrawiseMatterController | undefined };
  public readonly hap: HAP;
  public readonly log: Logging;
  public readonly mqtt: Nullable<MqttClient>;
  private pollingLoops: Set<number>;
  private statusCallbacks: Map<number, ((status: StatusScheduleResponse) => void)[]>;

  constructor(log: Logging, config: PlatformConfig | undefined, api: API) {

    this.accessories = [];
    this.matterAccessories = new Map();
    this.account = {} as CustomerDetailsResponse;
    this.api = api;
    this.configuredDevices = {};
    this.configuredMatterDevices = {};
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, config?.options ?? []);
    this.hap = api.hap;
    this.log = log;
    this.log.debug = this.debug.bind(this);
    this.mqtt = null;
    this.pollingLoops = new Set();
    this.statusCallbacks = new Map();

    this.config = {

      apiKey: config?.apiKey ?? "",
      debug: config?.debug === true,
      mqttTopic: config?.mqttTopic ?? HYDRAWISE_MQTT_TOPIC,
      mqttUrl: config?.mqttUrl,
      options: config?.options ?? []
    };

    // No Hydrawise API key, we're done.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(!this.config.apiKey?.length) {

      this.log.error("Unable to startup: no Hunter Hydrawise API key has been configured. Please configure one and restart the plugin.");

      return;
    }

    // Initialize our network connectivity.
    this.initNetworking();

    // Initialize MQTT, if needed.
    if(this.config.mqttUrl) {

      this.mqtt = new MqttClient(this.config.mqttUrl, this.config.mqttTopic, this.log);
    }

    this.log.debug("Debug logging on. Expect a lot of data.");

    // Fire up the Hydrawise API once Homebridge has loaded all the cached accessories it knows about and called configureAccessory() on each.
    api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {

      // To prevent Alexa from thinking these are "new" devices on every reboot, we MUST
      // register the cached Matter accessories immediately. If we wait for the Hydrawise API call,
      // the Matter Server will come online with 0 devices, and when we finally add them,
      // it triggers a parts list change notification.
      if(this.api.isMatterEnabled?.() && this.matterAccessories.size > 0) {
        this.log.info("Registering %s cached Matter accessories immediately.", this.matterAccessories.size);
        this.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, Array.from(this.matterAccessories.values()));
      }

      void this.configureHydrawise();
    });
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic for
  // Hydrawise API enumeration.
  public configureAccessory(accessory: PlatformAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Restore cached Matter accessories from disk on startup.
  public configureMatterAccessory(accessory: MatterAccessory): void {

    this.log.debug("Loading cached Matter accessory: %s", accessory.displayName);
    
    // Reattach proxy handlers based on the context so we can register the accessory immediately
    // during boot before the Hydrawise API call finishes.
    if(accessory.context) {

      const type = accessory.context.type as string;
      const controllerId = accessory.context.controllerId as number;
      const relayId = accessory.context.relayId as number;
      const matterUuid = this.api.matter?.uuid.generate(controllerId.toString()) || "";

      if(type === "zone" && relayId !== undefined) {
        const useSwitch = this.featureOptions.test("Matter.Valve.AsSwitch");
        const expectedTypeName = useSwitch ? "OnOffOutlet" : "WaterValve";

        if(accessory.deviceType?.name !== expectedTypeName) {
          this.log.info("Device type for %s changed from %s to %s. Discarding cache.", accessory.displayName, accessory.deviceType?.name, expectedTypeName);
          return;
        }

        if(useSwitch) {
          accessory.handlers = {
            onOff: {
              on: async () => this.configuredMatterDevices[matterUuid]?.handleOpen(relayId.toString(), undefined, true),
              off: async () => this.configuredMatterDevices[matterUuid]?.handleClose(relayId.toString(), true)
            }
          };
        } else {
          accessory.handlers = {
            valveConfigurationAndControl: {
              open: async (args: any) => this.configuredMatterDevices[matterUuid]?.handleOpen(relayId.toString(), args?.openDuration, true),
              close: async () => this.configuredMatterDevices[matterUuid]?.handleClose(relayId.toString(), true)
            }
          };
        }
      } else if(type === "suspend") {
        accessory.handlers = {
          onOff: {
            on: async () => this.configuredMatterDevices[matterUuid]?.handleSuspend(true, true),
            off: async () => this.configuredMatterDevices[matterUuid]?.handleSuspend(false, true)
          }
        };
      }
    }

    this.matterAccessories.set(accessory.UUID, accessory);
  }

  // Configure and connect to the Hydrawise API.
  private async configureHydrawise(): Promise<void> {

    // Keep retrying until we're successful at regular intervals.
    await retry(async (): Promise<boolean> => {

      // Get our list of controllers.
      const response = await this.retrieve("customerdetails.php");

      // Not found, let's retry again.
      if(!response) {

        return false;
      }

      try {

        this.account = await response.body.json() as CustomerDetailsResponse;
      } catch(error) {

        this.log.error("Unable to retrieve the list of controllers: %s", util.inspect(error, { colors: true, depth: null, sorted: true }));

        return false;
      }

      this.log.info("Successfully connected to the Hydrawise API.");

      this.log.debug(util.inspect(this.account, { colors: true, depth: null, sorted: true }));

      // Trim whitespace on irrigation controller names.
      this.account.controllers = this.account.controllers.map(x => ({ ...x, name: x.name.trim() }));

      for(const controller of this.account.controllers) {

        this.log.info("Discovered irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);
      }

      await Promise.all(this.account.controllers.map(controller => this.configureController(controller)));

      // Cleanup orphaned HAP accessories that aren't in the authoritative list provided by Hydrawise for this account.
      this.accessories.filter(controller => !this.account.controllers.some(accessory => this.hap.uuid.generate(accessory.controller_id.toString()) === controller.UUID))
        .map(accessory => this.removeAccessory(accessory));

      // Cleanup orphaned Matter accessories if Matter is enabled.
      if(this.api.isMatterEnabled?.()) {

        const validUUIDs: string[] = [];

        for(const device of Object.values(this.configuredMatterDevices)) {

          if(device) {

            validUUIDs.push(...device.getAllAccessories().map(y => y.UUID));
          }
        }

        const orphanedMatter = Array.from(this.matterAccessories.values()).filter(x => !validUUIDs.includes(x.UUID));

        if(orphanedMatter.length > 0) {

          this.log.info("Removing orphaned Matter accessories from cache: %s", orphanedMatter.map(x => x.displayName).join(", "));
          void this.api.matter!.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphanedMatter);

          for(const acc of orphanedMatter) {

            this.matterAccessories.delete(acc.UUID);
          }
        }
      }

      return true;
    }, HYDRAWISE_API_RETRY_INTERVAL * 1000);
  }

  // Configure a discovered irrigation controller.
  private async configureController(controller: HydrawiseControllerConfig): Promise<void> {

    const isMatter = this.api.isMatterEnabled?.() === true;
    const hapUuid = this.hap.uuid.generate(controller.controller_id.toString());

    // Check to see if the user has disabled the device.
    if(!this.featureOptions.test("Device", controller.controller_id.toString())) {

      // Remove HAP accessory if it exists.
      const hapAcc = this.accessories.find(x => x.UUID === hapUuid);

      if(hapAcc) {

        this.removeAccessory(hapAcc);
      }

      // Matter accessories for disabled devices will be cleaned up by orphan removal.
      return;
    }

    // Fetch the initial zone status once and share it between HAP and Matter controllers to avoid duplicate API calls during startup.
    let initialStatus: StatusScheduleResponse | undefined;

    await retry(async (): Promise<boolean> => {

      const response = await this.retrieve("statusschedule.php", {

        controller_id: controller.controller_id.toString()
      });

      if(!response) {

        return false;
      }

      try {

        initialStatus = await response.body.json() as StatusScheduleResponse;

        return true;
      } catch(error) {

        this.log.error("%s: Unable to retrieve initial status: %s", controller.name, util.inspect(error, { colors: true, depth: null, sorted: true }));

        return false;
      }
    }, HYDRAWISE_API_STARTUP_RETRY_INTERVAL * 1000, 3);

    // Always configure the HAP accessory.
    if(!this.configuredDevices[hapUuid]) {

      // See if we already know about this accessory or if it's truly new.
      let accessory = this.accessories.find(x => x.UUID === hapUuid);

      // It's a new device - let's add it to HomeKit.
      if(!accessory) {

        accessory = new this.api.platformAccessory(controller.name, hapUuid);

        // Register this accessory with Homebridge and add it to the accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }

      // Inform the user.
      this.log.info("Configuring HAP irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);

      // Add it to our list of configured devices.
      this.configuredDevices[hapUuid] = new HydrawiseController(this, accessory, controller, initialStatus);

      // Refresh the accessory cache.
      this.api.updatePlatformAccessories([accessory]);
    }

    // Additionally configure Matter accessories if Matter is enabled.
    if(isMatter) {

      const matterUuid = this.api.matter!.uuid.generate(controller.controller_id.toString());

      if(!this.configuredMatterDevices[matterUuid]) {

        const controllerDevice = new HydrawiseMatterController(this, controller, matterUuid);

        if(!await controllerDevice.init(initialStatus)) {

          this.log.error("Skipping Matter configuration for %s due to initialization failure. Cached accessories will be preserved.", controller.name);

          return;
        }

        const allAccessories = controllerDevice.getAllAccessories();

        if(allAccessories.length > 0) {

          try {

            // We already registered cached accessories synchronously in didFinishLaunching.
            // So here we ONLY register newly discovered accessories that were not in the cache.
            // This prevents Alexa from discovering existing devices as "new" on every reboot due to registration delays.
            const newAccessories = allAccessories.filter(acc => !this.matterAccessories.has(acc.UUID));

            if(newAccessories.length > 0) {

              this.log.info("Registering %s new Matter accessories for %s.", newAccessories.length, controller.name);
              await this.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
            }

            for(const acc of allAccessories) {

              this.matterAccessories.set(acc.UUID, acc);
            }
          } catch(error) {

            this.log.error("Failed to register Matter accessories for %s: %s", controller.name, util.inspect(error, { colors: true }));
          }
        }

        // Wait for the fire-and-forget registration to actually complete in the background.
        await controllerDevice.waitForRegistration(allAccessories.length);

        this.configuredMatterDevices[matterUuid] = controllerDevice;

        this.log.info("Configured Matter irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);
      }
    }

    if(!this.pollingLoops.has(controller.controller_id)) {

      this.pollingLoops.add(controller.controller_id);
      void this.pollingLoop(controller.controller_id, initialStatus);
    }
  }

  // Register a callback for status updates for a specific controller.
  public onStatusUpdate(controllerId: number, callback: (status: StatusScheduleResponse) => void): void {

    if(!this.statusCallbacks.has(controllerId)) {

      this.statusCallbacks.set(controllerId, []);
    }

    this.statusCallbacks.get(controllerId)!.push(callback);
  }

  // Centralized polling loop for a physical controller.
  private async pollingLoop(controllerId: number, initialStatus?: StatusScheduleResponse): Promise<void> {

    let status = initialStatus ?? { nextpoll: -1, relays: [] as HydrawiseZoneConfig[] } as StatusScheduleResponse;
    let isFirstPoll = initialStatus === undefined;

    for(;;) {

      if(!isFirstPoll) {

        await retry(async (): Promise<boolean> => {

          const response = await this.retrieve("statusschedule.php", { controller_id: controllerId.toString() });

          if(!response) {

            return false;
          }

          try {

            status = await response.body.json() as StatusScheduleResponse;

            return true;
          } catch(error) {

            this.log.error("Unable to retrieve status for controller %s: %s", controllerId.toString(), util.inspect(error, { colors: true, depth: null, sorted: true }));

            return false;
          }
        }, (status.nextpoll === -1 ? HYDRAWISE_API_RETRY_INTERVAL : Math.min(status.nextpoll + HYDRAWISE_API_JITTER, HYDRAWISE_API_RETRY_INTERVAL * 2)) * 1000);
      }

      isFirstPoll = false;

      // Dispatch the updated status to all registered controllers (HAP and Matter).
      const callbacks = this.statusCallbacks.get(controllerId);

      if(callbacks) {

        for(const callback of callbacks) {

          // We intentionally do not await callbacks to ensure they execute independently.
          void callback(status);
        }
      }

      // Sleep until our next polling interval.
      await sleep((status.nextpoll <= 0 ? HYDRAWISE_API_RETRY_INTERVAL : status.nextpoll + HYDRAWISE_API_JITTER) * 1000);
    }
  }

  // Remove the accessory from HomeKit.
  private removeAccessory(accessory: PlatformAccessory): void {

    // Inform the user.
    this.log.info("%s: Removing device from HomeKit.", accessory.displayName);

    // Unregister the accessory and delete it's remnants from HomeKit.
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.splice(this.accessories.indexOf(accessory), 1);
    this.api.updatePlatformAccessories(this.accessories);
  }

  // Handle commands from early-bound Matter accessories before the full controller is configured.
  private async handleEarlyCommand(controllerId: number, relayId: number, action: "run" | "stop" | "suspendall" | "resumeall", duration?: number): Promise<void> {

    const params: Record<string, string> = { controller_id: controllerId.toString() };

    switch(action) {

      case "run":

        params.relay_id = relayId.toString();
        params.action = "run";
        params.custom = (duration ?? 300).toString();
        params.period_id = "999";

        break;

      case "stop":

        params.relay_id = relayId.toString();
        params.action = "stop";

        break;

      case "suspendall":

        params.action = "suspendall";
        params.custom = ((Date.now() / 1000) + 31556926).toString();
        params.period_id = "999";

        break;

      case "resumeall":

        params.action = "suspendall";
        params.custom = (Date.now() / 1000).toString();
        params.period_id = "999";

        break;

      default:

        return;
    }

    await this.retrieve("setzone.php", params);
  }

  // Initialize our network stack.
  private initNetworking(): void {

    // Create an interceptor that allows us to set the user agent to our liking.
    const ua: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {

      opts.headers ??= {};
      (opts.headers as Record<string, string>)["user-agent"] = "homebridge-hunter-hydrawise";

      return dispatch(opts, handler);
    };

    // Cleanup any existing dispatcher we may have.
    void this.dispatcher?.destroy();

    // We want to enable the use of HTTP/2 and retry a request up to three times.
    this.dispatcher = new Pool("https://api.hydrawise.com", { allowH2: true, clientTtl: 60 * 1000, connections: 1 })
      .compose(ua, interceptors.retry({ maxRetries: 3, maxTimeout: 5000, minTimeout: 1000, statusCodes: [ 400, 404, 429, 500, 502, 503, 504 ], timeoutFactor: 2 }));
  }

  // Communicate HTTP requests with the Hydrawise API.
  public async retrieve(endpoint: string, params?: Record<string, string>): Promise<Nullable<Dispatcher.ResponseData<unknown>>> {

    // Catch Hydrawise server-side issues:
    //
    // 400: Bad request.
    // 404: Not found.
    // 429: Too many requests.
    // 500: Internal server error.
    // 502: Bad gateway.
    // 503: Service temporarily unavailable.
    const serverErrors = new Set([ 400, 404, 429, 500, 502, 503 ]);

    let response: Dispatcher.ResponseData<unknown>;

    // Create a signal handler to deliver the abort operation.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HYDRAWISE_API_TIMEOUT * 1000);
    const signal = controller.signal;

    params ??= {};

    // Set our API key.
    // eslint-disable-next-line camelcase
    params.api_key = this.config.apiKey;

    const queryParams = new URLSearchParams(params);

    // Construct our API call.
    const url = "https://api.hydrawise.com/api/v1/" + endpoint + "?" + queryParams.toString();

    try {

      // Execute the API call.
      response = await request(url, { dispatcher: this.dispatcher, signal: signal });

      // Bad username and password.
      if(response.statusCode === 404) {

        this.log.error("Invalid API key. Please check your Hydrawise API key.");

        return null;
      }

      // API rate limit exceeded.
      if(response.statusCode === 429) {

        this.log.error("Hydrawise API rate limit has been exceeded.");

        return null;
      }

      // Some other unknown error occurred.
      if(!(response.statusCode >= 200) && (response.statusCode < 300)) {

        this.log.error(serverErrors.has(response.statusCode) ? "Hydrawise API is temporarily unavailable." : response.statusCode.toString() + ": " +
          STATUS_CODES[response.statusCode]);

        return null;
      }

      return response;
    } catch(error) {

      // We aborted the connection.
      if((error instanceof DOMException) && (error.name === "AbortError")) {

        this.log.error("The Hydrawise API is taking too long to respond to a request. This error can usually be safely ignored.");
        this.log.debug("Original request was: %s", url.replace(/api_key=[^&]+/g, "api_key=REDACTED"));

        // Reset our network stack, just in case.
        this.initNetworking();

        return null;
      }

      // Connection timed out.
      if(error instanceof errors.ConnectTimeoutError) {

        this.log.error("Connection timed out.");

        return null;
      }

      // We destroyed the pool due to a reset event and our inflight connections are failing.
      if(error instanceof errors.RequestRetryError) {

        this.log.error("Unable to connect to the Hydrawise API. This is usually temporary and will retry automatically. Error: %s", error instanceof Error ? error.message : String(error));

        return null;
      }

      if(error instanceof TypeError) {

        const cause = error.cause as NodeJS.ErrnoException;

        switch(cause.code) {

          case "ECONNREFUSED":
          case "EHOSTDOWN":

            this.log.error("Connection refused.");

            break;

          case "ECONNRESET":

            this.log.error("Connection has been reset.");

            break;

          case "ENOTFOUND":

            this.log.error("Hostname or IP address not found. Please ensure you're connected to the Internet.");

            break;

          default:

            this.log.error("Error: %s | %s.", cause.code, cause.message);
            this.log.error(util.inspect(error, { colors: true, depth: null, sorted: true}));

            break;
        }

        return null;
      }

      this.log.error(util.inspect(error, { colors: true, depth: null, sorted: true}));

      return null;
    } finally {

      // Clear out our response timeout if needed.
      clearTimeout(timeout);
    }
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debug) {

      this.log.error(util.format(message, ...parameters));
    }
  }
}
