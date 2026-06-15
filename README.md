<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-hunter-hydrawise: Native HomeKit support for Hunter Hydrawise](https://raw.githubusercontent.com/hjdhjd/homebridge-hunter-hydrawise/main/images/homebridge-hunter-hydrawise.svg)](https://github.com/hjdhjd/homebridge-hunter-hydrawise)

# Homebridge Hunter Hydrawise

[![Downloads](https://img.shields.io/npm/dt/homebridge-hunter-hydrawise?color=%230A6E93&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-hunter-hydrawise)
[![Version](https://img.shields.io/npm/v/homebridge-hunter-hydrawise?color=%230A6E93&label=Homebridge%20Hunter%20Hydrawise&logoColor=%23FFFFFF&style=for-the-badge&logo=rainmeter)](https://www.npmjs.com/package/homebridge-hunter-hydrawise)
[![Hunter Hydrawise@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=%230A6E93&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%2357277C&style=for-the-badge&logoColor=%23FFFFFF&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5OTIuMDkiIGhlaWdodD0iMTAwMCIgdmlld0JveD0iMCAwIDk5Mi4wOSAxMDAwIj48ZGVmcz48c3R5bGU+LmF7ZmlsbDojZmZmO308L3N0eWxlPjwvZGVmcz48cGF0aCBjbGFzcz0iYSIgZD0iTTk1MC4xOSw1MDguMDZhNDEuOTEsNDEuOTEsMCwwLDEtNDItNDEuOWMwLS40OC4zLS45MS4zLTEuNDJMODI1Ljg2LDM4Mi4xYTc0LjI2LDc0LjI2LDAsMCwxLTIxLjUxLTUyVjEzOC4yMmExNi4xMywxNi4xMywwLDAsMC0xNi4wOS0xNkg3MzYuNGExNi4xLDE2LjEsMCwwLDAtMTYsMTZWMjc0Ljg4bC0yMjAuMDktMjEzYTE2LjA4LDE2LjA4LDAsMCwwLTIyLjY0LjE5TDYyLjM0LDQ3Ny4zNGExNiwxNiwwLDAsMCwwLDIyLjY1bDM5LjM5LDM5LjQ5YTE2LjE4LDE2LjE4LDAsMCwwLDIyLjY0LDBMNDQzLjUyLDIyNS4wOWE3My43Miw3My43MiwwLDAsMSwxMDMuNjIuNDVMODYwLDUzOC4zOGE3My42MSw3My42MSwwLDAsMSwwLDEwNGwtMzguNDYsMzguNDdhNzMuODcsNzMuODcsMCwwLDEtMTAzLjIyLjc1TDQ5OC43OSw0NjguMjhhMTYuMDUsMTYuMDUsMCwwLDAtMjIuNjUuMjJMMjY1LjMsNjgwLjI5YTE2LjEzLDE2LjEzLDAsMCwwLDAsMjIuNjZsMzguOTIsMzlhMTYuMDYsMTYuMDYsMCwwLDAsMjIuNjUsMGwxMTQtMTEyLjM5YTczLjc1LDczLjc1LDAsMCwxLDEwMy4yMiwwbDExMywxMTEsLjQyLjQyYTczLjU0LDczLjU0LDAsMCwxLDAsMTA0TDU0NS4wOCw5NTcuMzV2LjcxYTQxLjk1LDQxLjk1LDAsMSwxLTQyLTQxLjk0Yy41MywwLC45NS4zLDEuNDQuM0w2MTYuNDMsODA0LjIzYTE2LjA5LDE2LjA5LDAsMCwwLDQuNzEtMTEuMzMsMTUuODUsMTUuODUsMCwwLDAtNC43OS0xMS4zMmwtMTEzLTExMWExNi4xMywxNi4xMywwLDAsMC0yMi42NiwwTDM2Ny4xNiw3ODIuNzlhNzMuNjYsNzMuNjYsMCwwLDEtMTAzLjY3LS4yN2wtMzktMzlhNzMuNjYsNzMuNjYsMCwwLDEsMC0xMDMuODZMNDM1LjE3LDQyNy44OGE3My43OSw3My43OSwwLDAsMSwxMDMuMzctLjlMNzU4LjEsNjM5Ljc1YTE2LjEzLDE2LjEzLDAsMCwwLDIyLjY2LDBsMzguNDMtMzguNDNhMTYuMTMsMTYuMTMsMCwwLDAsMC0yMi42Nkw1MDYuNSwyNjUuOTNhMTYuMTEsMTYuMTEsMCwwLDAtMjIuNjYsMEwxNjQuNjksNTgwLjQ0QTczLjY5LDczLjY5LDAsMCwxLDYxLjEsNTgwTDIxLjU3LDU0MC42OWwtLjExLS4xMmE3My40Niw3My40NiwwLDAsMSwuMTEtMTAzLjg4TDQzNi44NSwyMS40MUE3My44OSw3My44OSwwLDAsMSw1NDAsMjAuNTZMNjYyLjYzLDEzOS4zMnYtMS4xYTczLjYxLDczLjYxLDAsMCwxLDczLjU0LTczLjVINzg4YTczLjYxLDczLjYxLDAsMCwxLDczLjUsNzMuNVYzMjkuODFhMTYsMTYsMCwwLDAsNC43MSwxMS4zMmw4My4wNyw4My4wNWguNzlhNDEuOTQsNDEuOTQsMCwwLDEsLjA4LDgzLjg4WiIvPjwvc3ZnPg==)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Hunter Hydrawise support for [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

`homebridge-hunter-hydrawise` is a [Homebridge](https://homebridge.io) plugin that makes your Hunter Hydrawise irrigation controller available to [Apple's](https://www.apple.com) [HomeKit](https://www.apple.com/ios/home) smart home platform. It also supports [Matter](https://csa-iot.org/all-solutions/matter/), enabling cross-platform compatibility with **Amazon Alexa**, **Google Home**, and other Matter-compatible ecosystems.

## Why use this plugin for Hunter Hydrawise support in HomeKit?
In a nutshell, the aim of this plugin for things to *just work* with minimal required configuration by users. The goal is to provide as close to a streamlined experience as you would expect from a first-party or native HomeKit solution. For the adventurous, those additional granular options are, of course, available to support more esoteric use cases or other unique needs.

What does *just work* mean in practice? It means that this plugin will discover all of the Hydrawise controllers connected to your Hydrawise account without the need for additional configuration beyond entering your account-specific API key. This plugin will expose those controllers and their zones as an irrigation system in HomeKit.

**I rely on this plugin every day and actively maintain and support it.**

I've developed a full-featured Homebridge plugin that enables the following features:

  * Control each individual zone on your irrigation controller.
  * Display when your irrigation system is off due to a rain sensor preventing watering (the irrigation system will show as *off* in HomeKit).
  * Show, at a glance, all the zones that are queued up to run in the next 60 minutes on your controller (each individual zone will appear active in HomeKit when it's queued to run).
  * **Matter support** for cross-platform smart home control (Amazon Alexa, Google Home, Samsung SmartThings, and more).
  * A rich webUI for configuration.
  * MQTT support.

## <A NAME="matter"></A>Matter Support
This plugin supports [Matter](https://csa-iot.org/all-solutions/matter/) via Homebridge 2.0+, allowing your Hydrawise irrigation zones to be controlled from ecosystems beyond Apple HomeKit — including **Amazon Alexa**, **Google Home**, **Samsung SmartThings**, and any other Matter-compatible controller.

### Why Matter?
HomeKit-only plugins are limited to the Apple ecosystem. By enabling Matter, each irrigation zone is exposed as a standalone accessory that can be discovered and controlled by any Matter-compatible platform. This is especially useful if you:

  * Use **Amazon Alexa** and want voice control of your irrigation zones (e.g. *"Alexa, turn on Zone 3"*).
  * Use **Google Home** and want to manage your irrigation from the Google Home app or via Google Assistant.
  * Have a **multi-platform household** where different family members use different smart home ecosystems.
  * Want your irrigation zones to appear with **clean, simple names** (e.g. "Zone 1") without the controller name prefix.

### Enabling Matter
To enable Matter support:

  1. Ensure you are running **Homebridge 2.0** or later.
  2. In the Homebridge UI, go to your `homebridge-hunter-hydrawise` child bridge settings.
  3. Enable the **Matter** toggle for the child bridge.
  4. Restart Homebridge.
  5. **Commission the Matter bridge** by adding it as a new Matter device in your smart home app (Apple Home, Google Home, Alexa, etc.) using the pairing code displayed in the Homebridge UI or logs.

> [!IMPORTANT]
> The Matter bridge must be **commissioned** (paired) from your smart home app before accessories will appear. Simply enabling Matter in Homebridge is not enough — you must complete the pairing step using the displayed manual pairing code or QR code.

### <A NAME="feature-options-matter"></A>Matter Feature Options
The following feature options are available for customizing Matter behavior. These can be set via the Feature Options tab in the plugin's webUI or manually in the `options` array of your config.

| Feature Option | Default | Description |
| :--- | :---: | :--- |
| `Enable.Matter.Valve.AsSwitch` | Disabled | Expose each irrigation zone as an **On/Off switch** (outlet) instead of a water valve. This is useful for compatibility with ecosystems like **Alexa** that may not fully support the Matter valve device type. When enabled, zones appear as simple switches that can be toggled on and off. |

> [!TIP]
> If your zones are not appearing or not controllable in **Amazon Alexa**, try enabling `Matter.Valve.AsSwitch`. Alexa's Matter support currently has better compatibility with On/Off switch device types than with valve device types.

### How It Works
When Matter is enabled, the plugin registers each irrigation zone as an independent Matter accessory on the Homebridge Matter bridge. This means:

  * Each zone appears as a **separate, individually named device** in your smart home app.
  * Zone names come directly from your Hydrawise configuration (e.g. "Zone 1", "Zone 2", "Berm 21").
  * Zone state (on/off, running/idle) is synchronized with the Hydrawise API in real-time.
  * Commands issued from any Matter controller (Alexa, Google Home, HomeKit) are sent to the Hydrawise API to start or stop watering.

> [!NOTE]
> When Matter is enabled, the traditional HAP (HomeKit Accessory Protocol) accessories are automatically removed to avoid duplicate devices. Your zones will only be accessible through the Matter bridge.

## <A NAME="plugin-configuration"></A>Installation
To get started with `homebridge-hunter-hydrawise`:

  * [Generate a Hydrawise API key](https://app.hydrawise.com/config/account-details), should you need one.</li>
  * Install `homebridge-hunter-hydrawise` using the Homebridge webUI. Make sure you make `homebridge-hunter-hydrawise` a child bridge for the best experience.
  * Configure `homebridge-hunter-hydrawise` and enter your API key.
  * That's it. Enjoy!

<A NAME="notes"></A>
> [!IMPORTANT]
> Things to keep in mind regarding the Hydrawise API:
> * The Hydrawise API is rate-limited with the following constraints:
>   * A limit of 3 API calls to start, stop, or suspend any zone within a 30 second interval.
>   * An additional limit across the entire API of no more than 30 calls in any 5 minute period.
> * While the API provides the ability to suspend a zone, it does not provide the ability to resume a schedule.

## Plugin Development Dashboard
This is mostly of interest to the true developer nerds amongst us.

[![License](https://img.shields.io/npm/l/homebridge-hunter-hydrawise?color=%230A6E93&logo=open%20source%20initiative&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-hunter-hydrawise/blob/main/LICENSE.md)
[![Build Status](https://img.shields.io/github/actions/workflow/status/hjdhjd/homebridge-hunter-hydrawise/ci.yml?branch=main&color=%230A6E93&logo=github-actions&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-hunter-hydrawise/actions?query=workflow%3A%22Continuous+Integration%22)
[![Dependencies](https://img.shields.io/librariesio/release/npm/homebridge-hunter-hydrawise?color=%230A6E93&logo=dependabot&style=for-the-badge)](https://libraries.io/npm/homebridge-hunter-hydrawise)
[![GitHub commits since latest release (by SemVer)](https://img.shields.io/github/commits-since/hjdhjd/homebridge-hunter-hydrawise/latest?color=%230A6E93&logo=github&sort=semver&style=for-the-badge)](https://github.com/hjdhjd/homebridge-hunter-hydrawise/commits/main)
