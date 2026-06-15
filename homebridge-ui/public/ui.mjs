/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui.mjs: Homebridge Hunter Hydrawise webUI.
 */

"use strict";

import { webUi } from "./lib/webUi.mjs";
import { webUiFeatureOptions } from "./lib/webUi-featureoptions.mjs";

// Wrap homebridge API methods with a timeout to prevent UI hangs when the plugin is disabled or communication channels are blocked.
const originalGetCachedAccessories = homebridge.getCachedAccessories.bind(homebridge);
homebridge.getCachedAccessories = async () => {
  try {
    const timeout = new Promise((resolve) => setTimeout(() => resolve([]), 1000));
    return await Promise.race([originalGetCachedAccessories(), timeout]);
  } catch(err) {
    return [];
  }
};

const originalRequest = homebridge.request.bind(homebridge);
homebridge.request = async (path, body) => {
  try {
    const timeout = new Promise((resolve) => setTimeout(() => {
      if(path === "/getOptions") {
        resolve({
          categories: [
            { description: "Device feature options.", name: "Device" },
            { description: "Logging feature options.", name: "Log" },
            { description: "Matter integration feature options.", name: "Matter" }
          ],
          options: {
            "Device": [
              { default: true, description: "Make this device available in HomeKit.", name: "" },
              { default: false, description: "Enable a switch accessory to control suspending all zones.", name: "Suspend" }
            ],
            "Log": [
              { default: true, description: "Log zone start and stop events in Homebridge.", name: "Zone" }
            ],
            "Matter": [
              { default: false, description: "Map zone valves to On/Off switches/outlets for compatibility.", name: "Valve.AsSwitch" }
            ]
          }
        });
      } else {
        resolve(undefined);
      }
    }, 1000));
    return await Promise.race([originalRequest(path, body), timeout]);
  } catch(err) {
    if(path === "/getOptions") {
      return { categories: [], options: {} };
    }
    return undefined;
  }
};

const originalUserCurrentLightingMode = homebridge.userCurrentLightingMode?.bind(homebridge);
if(originalUserCurrentLightingMode) {
  homebridge.userCurrentLightingMode = async () => {
    try {
      const timeout = new Promise((resolve) => setTimeout(() => resolve("light"), 1000));
      return await Promise.race([originalUserCurrentLightingMode(), timeout]);
    } catch(err) {
      return "light";
    }
  };
}

// Execute our first run screen if we don't have a valid Hydrawise API key.
const firstRunIsRequired = () => ui.featureOptions.currentConfig[0]?.apiKey?.length !== 19;

// Initialize our first run screen with any information from our existing configuration.
const firstRunOnStart = () => {

  // Pre-populate with anything we might already have in our configuration.
  document.getElementById("apiKey").value = ui.featureOptions.currentConfig[0].apiKey ?? "";

  return true;
};

// Validate our Hydrawise API key.
const firstRunOnSubmit = async () => {

  const apiKey = document.getElementById("apiKey").value;
  const tdLoginError = document.getElementById("loginError");

  tdLoginError.innerHTML = "&nbsp;";

  const validateApiKey = await homebridge.request("/login", apiKey);

  if(validateApiKey !== "success") {

    tdLoginError.innerHTML = "<code class=\"text-danger\">" + validateApiKey + "</code>";
    homebridge.hideSpinner();
    return false;
  }

  ui.featureOptions.currentConfig[0].apiKey = apiKey;
  await homebridge.updatePluginConfig(ui.featureOptions.currentConfig);

  return true;
};

// Tailor the list of devices and associated details for this API key.
const getDevices = async () => {

  let devices = [];
  try {
    // Retrieve the list of devices from HBPU that we then customize further.
    devices = (await ui.featureOptions.getHomebridgeDevices()) ?? [];
  } catch(err) {
    // Stale/disabled plugin might throw errors or return null/undefined.
  }

  let accessories = [];
  try {
    // Retrieve the full list of cached accessories.
    accessories = (await homebridge.getCachedAccessories()) ?? [];
  } catch(err) {
    // Stale/disabled plugin might throw errors or return null/undefined.
  }

  // We want to retrieve the list of zones associated with each accessory so we can include that in the UI.
  if(Array.isArray(accessories) && Array.isArray(devices)) {
    for(const accessory of accessories) {

      // Find the serial number of the accessory.
      const info = accessory?.services?.find(s => s.constructorName === "AccessoryInformation");
      const serialNumber = info?.characteristics?.find(c => c.constructorName === "SerialNumber")?.value;

      if(serialNumber) {

        const device = devices.find(d => d.serialNumber === serialNumber);

        if(device) {

          device.zones = accessory.services?.filter(service => service.constructorName === "Valve").length.toString();
        }
      }
    }
  }

  // Return the list.
  return devices;
};

// Show the details for this device.
const showDeviceDetails = (device) => {

  const deviceStatsContainer = document.getElementById("deviceStatsContainer");

  // No device specified, we must be in a global context.
  if(!device) {

    deviceStatsContainer.innerHTML = "";
    return;
  }

  // Populate the device details.
  deviceStatsContainer.innerHTML =
    "<div class=\"device-stats-grid\">" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">MAC Address</span>" +
        "<span class=\"stat-value font-monospace\">" + device.serialNumber + "</span>" +
      "</div>" +
      "<div class=\"stat-item\">" +
        "<span class=\"stat-label\">Zones</span>" +
        "<span class=\"stat-value\">" +  (device.zones ?? "0") + "</span>" +
      "</div>" +
    "</div>";
};

// Parameters for our feature options webUI.
const featureOptionsParams = {

  getDevices: getDevices,
  infoPanel: showDeviceDetails,
  sidebar: {

    deviceLabel: "Hydrawise Devices"
  }
};

// Instantiate the webUI.
const ui = new webUi({ featureOptions: featureOptionsParams, firstRun: { isRequired: firstRunIsRequired, onStart: firstRunOnStart, onSubmit: firstRunOnSubmit },
  name: "Hydrawise" });

// Display the webUI.
ui.show();
