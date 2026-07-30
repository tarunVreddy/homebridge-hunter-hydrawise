/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hydrawise-platform.ts: homebridge-hunter-hydrawise platform class.
 */
import type { API, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from "homebridge";
import { APIEvent, FeatureOptions, MqttClient, composeSignals, loopFaultReporter, retry, superviseLoop } from "homebridge-plugin-utils";
import type { CustomerDetailsResponse, HydrawiseControllerConfig } from "./hydrawise-types.js";
import { HYDRAWISE_API_RETRY_INTERVAL, HYDRAWISE_API_TIMEOUT, HYDRAWISE_MQTT_TOPIC, PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { Pool, errors, interceptors, request, setGlobalDispatcher } from "undici";
import { featureOptionCategories, featureOptions } from "./hydrawise-options.js";
import type { Dispatcher } from "undici";
import { HydrawiseController } from "./hydrawise-controller.js";
import type { HydrawiseOptions } from "./hydrawise-options.js";
import type { Nullable } from "homebridge-plugin-utils";
import { STATUS_CODES } from "node:http";
import util from "node:util";

export class HydrawisePlatform implements DynamicPlatformPlugin {

  private readonly accessories: PlatformAccessory[];
  private account: CustomerDetailsResponse;
  public readonly api: API;
  private dispatcher?: Dispatcher;
  public readonly featureOptions: FeatureOptions;
  public config: HydrawiseOptions;
  public readonly configuredDevices: Record<string, HydrawiseController | undefined>;
  public readonly hap: HAP;
  public readonly log: Logging;
  public readonly mqtt: Nullable<MqttClient>;
  private readonly shutdownController: AbortController;
  public readonly signal: AbortSignal;

  constructor(log: Logging, config: PlatformConfig | undefined, api: API) {

    // PlatformConfig exposes user values through an any-typed index signature, so we read each value through a bracket-access cast to its declared type and keep the
    // reads type-checked rather than any. We resolve the options list once and share it between the feature-options engine and our own config snapshot.
    const options = (config?.["options"] as string[] | undefined) ?? [];

    this.accessories = [];
    this.account = {} as CustomerDetailsResponse;
    this.api = api;
    this.configuredDevices = {};
    this.featureOptions = new FeatureOptions(featureOptionCategories, featureOptions, options);
    this.hap = api.hap;
    this.log = log;
    this.log.debug = this.debug.bind(this);
    this.mqtt = null;

    // Scope an AbortController to the platform's lifetime. We assign it and its signal at the top of the constructor, before the missing-API-key early return below,
    // because strict definite-assignment checking requires every constructor path to initialize these readonly fields. Aborting the controller on Homebridge shutdown
    // tears down every signal-aware resource we own through one composed signal.
    this.shutdownController = new AbortController();
    this.signal = this.shutdownController.signal;

    this.config = {

      apiKey: (config?.["apiKey"] as string | undefined) ?? "",
      debug: config?.["debug"] === true,
      mqttTopic: (config?.["mqttTopic"] as string | undefined) ?? HYDRAWISE_MQTT_TOPIC,
      mqttUrl: config?.["mqttUrl"] as string | undefined,
      options
    };

    // No Hydrawise API key, we're done.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(!this.config.apiKey?.length) {

      this.log.error("Unable to startup: no Hunter Hydrawise API key has been configured. Please configure one and restart the plugin.");

      return;
    }

    // Initialize our network connectivity.
    this.initNetworking();

    // Initialize MQTT, if needed. The HBPU MqttClient throws synchronously on an invalid broker URL, so we wrap construction in a try/catch and degrade gracefully -
    // a single bad MQTT entry should not block the rest of the plugin from loading. The composed shutdown signal ties the client's lifetime to ours.
    if(this.config.mqttUrl) {

      try {

        this.mqtt = new MqttClient({ brokerUrl: this.config.mqttUrl, log: this.log, topicPrefix: this.config.mqttTopic }, { signal: this.signal });
      } catch(error) {

        this.log.error("Unable to initialize MQTT client: %s", util.inspect(error, { depth: null }));
      }
    }

    this.log.debug("Debug logging on. Expect a lot of data.");

    // Fire up the Hydrawise API once Homebridge has loaded all the cached accessories it knows about and called configureAccessory() on each. We supervise the
    // discovery loop so a genuine configuration fault surfaces once through the reporter, while a shutdown abort unwinds it silently.
    api.on(APIEvent.DID_FINISH_LAUNCHING, () => void superviseLoop({ loop: () => this.configureHydrawise(), onError: loopFaultReporter(this.log, "controller discovery"),
      signal: this.signal }));

    // Tear ourselves down cleanly when Homebridge shuts down. This is the single owner of platform shutdown: aborting the signal cancels every signal-aware resource we
    // own (the MQTT client, the retry waits, the polling loops), and destroying the undici dispatcher closes the keep-alive Pool connection so it does not outlive us.
    api.on(APIEvent.SHUTDOWN, () => {

      this.shutdownController.abort("shutdown");

      void this.dispatcher?.destroy();
    });
  }

  // This gets called when homebridge restores cached accessories at startup. We intentionally avoid doing anything significant here, and save all that logic for
  // Hydrawise API enumeration.
  public configureAccessory(accessory: PlatformAccessory): void {

    // Add this to the accessory array so we can track it.
    this.accessories.push(accessory);
  }

  // Configure and connect to the Hydrawise API.
  private async configureHydrawise(): Promise<void> {

    // Retrieve the account's controllers, retrying forever at a fixed 60-second cadence against the rate-limited API. The retried operation covers only the network
    // truth - the request and the JSON parse - and throws on any failure so retry loops; a resolved value is a successful fetch. Everything downstream runs once,
    // outside the retry, so a genuine configuration fault escapes to the supervisor's reporter rather than becoming a silent 60-second retry.
    this.account = await retry(async (): Promise<CustomerDetailsResponse> => {

      // Get our list of controllers.
      const response = await this.retrieve("customerdetails.php");

      // A null response is a recoverable API error (or a shutdown abort) that retrieve() already classified and logged. Throw so retry waits and tries again.
      if(!response) {

        throw new Error("Unable to retrieve the list of controllers.");
      }

      try {

        return await response.body.json() as CustomerDetailsResponse;
      } catch(error) {

        // A shutdown abort mid-read is orderly teardown - rethrow quietly so the retry loop unwinds through its own signal without logging a spurious parse failure.
        if(this.signal.aborted) {

          throw error;
        }

        this.log.error("Unable to retrieve the list of controllers: %s", util.inspect(error, { colors: true, depth: null, sorted: true }));

        throw error;
      }
    }, { attempts: Infinity, backoff: (): number => HYDRAWISE_API_RETRY_INTERVAL * 1000, signal: this.signal });

    this.log.info("Successfully connected to the Hydrawise API.");

    this.log.debug(util.inspect(this.account, { colors: true, depth: null, sorted: true }));

    // Trim whitespace on irrigation controller names.
    this.account.controllers = this.account.controllers.map(x => ({ ...x, name: x.name.trim() }));

    for(const controller of this.account.controllers) {

      this.log.info("Discovered irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);

      this.configureController(controller);
    }

    // Find all the orphaned irrigation controller accessories that aren't in the authoritative list provided by Hydrawise for this account and remove them.
    this.accessories.filter(controller => !this.account.controllers.some(accessory => this.hap.uuid.generate(accessory.controller_id.toString()) === controller.UUID))
      .map(accessory => this.removeAccessory(accessory));
  }

  // Configure a discovered irrigation controller.
  private configureController(controller: HydrawiseControllerConfig): Nullable<HydrawiseController> {

    // Generate this controller's unique identifier.
    const uuid = this.hap.uuid.generate(controller.controller_id.toString());

    // See if we already know about this accessory or if it's truly new.
    let accessory = this.accessories.find(x => x.UUID === uuid);

    // Check to see if the user has disabled the device.
    if(!this.featureOptions.test("Device", controller.controller_id.toString())) {

      // If the accessory already exists, let's remove it.
      if(accessory) {

        this.removeAccessory(accessory);
      }

      // We're done.
      return null;
    }

    // If we've already configured this device before, we're done.
    if(this.configuredDevices[uuid]) {

      return null;
    }

    // It's a new device - let's add it to HomeKit.
    if(!accessory) {

      accessory = new this.api.platformAccessory(controller.name, uuid);

      // Register this accessory with Homebridge and add it to the accessory array so we can track it.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // Inform the user.
    this.log.info("Configuring irrigation controller: %s (serial: %s id: %s).", controller.name, controller.serial_number, controller.controller_id);

    // Add it to our list of configured devices.
    this.configuredDevices[uuid] = new HydrawiseController(this, accessory, controller);

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories([accessory]);

    return this.configuredDevices[uuid];
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

    // We want to enable the use of HTTP/2, accept unauthorized SSL certificates and retry a request up to three times.
    this.dispatcher = new Pool("https://api.hydrawise.com", { allowH2: true, clientTtl: 60 * 1000, connect: { rejectUnauthorized: false }, connections: 1 })
      .compose(ua, interceptors.retry({ maxRetries: 3, maxTimeout: 5000, minTimeout: 1000, statusCodes: [ 400, 404, 429, 500, 502, 503, 504 ], timeoutFactor: 2 }));

    setGlobalDispatcher(this.dispatcher);
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

    // Compose a per-request timeout with the platform's shutdown signal, so a slow request aborts on the timeout and an in-flight request aborts on shutdown, all
    // through one signal handed to undici.
    const signal = composeSignals(AbortSignal.timeout(HYDRAWISE_API_TIMEOUT * 1000), this.signal);

    params ??= {};

    // Set our API key.
    params["api_key"] = this.config.apiKey;

    const queryParams = new URLSearchParams(params);

    // Construct our API call.
    const url = "https://api.hydrawise.com/api/v1/" + endpoint + "?" + queryParams.toString();

    try {

      // Execute the API call.
      response = await request(url, { signal });

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
          (STATUS_CODES[response.statusCode] ?? ""));

        return null;
      }

      return response;
    } catch(error) {

      // A shutdown abort supersedes every other classification. Near the timeout boundary the composed rejection's shape is ambiguous, so the platform signal's own
      // aborted flag is the truth: we exit quietly here, which also guarantees the timeout branch below can never re-arm the Pool after shutdown.
      if(this.signal.aborted) {

        return null;
      }

      // The request exceeded our timeout budget.
      if((error instanceof DOMException) && (error.name === "TimeoutError")) {

        this.log.error("The Hydrawise API is taking too long to respond to a request. This error can usually be safely ignored.");
        this.log.debug("Original request was: %s", url);

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

        this.log.error("Unable to connect to the Hydrawise API. This is usually temporary and will retry automatically.");

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
    }
  }

  // Utility for debug logging.
  public debug(message: string, ...parameters: unknown[]): void {

    if(this.config.debug) {

      this.log.error(util.format(message, ...parameters));
    }
  }
}
