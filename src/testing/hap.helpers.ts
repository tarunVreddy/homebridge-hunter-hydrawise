/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * hap.helpers.ts: A hand-built HAP test-double - the Service and Characteristic marker namespaces, TestCharacteristic, TestService, and TestAccessory - that
 * mirrors only the HAP surface the plugin actually touches. homebridge-plugin-utils' REAL acquireService / validService / getServiceName / setServiceName run
 * unmodified against these doubles, so a REAL HydrawiseController is constructed end to end with no live HAP runtime.
 *
 * The doubles carry no cross-kind service statics, so the real service helpers' name-set predicates (serviceRequiresConfiguredName, serviceHasName, ...) resolve
 * honestly false against every marker; the helpers therefore never reach their optional-characteristic add paths, and getServiceName reads through to undefined
 * rather than a real name characteristic. That collapse is the same one the family's other plugin doubles rely on, and it is what lets the real helpers run
 * against a marker namespace this small.
 *
 * Consumed surface (swept from homebridge-plugin-utils/src/service.ts and the plugin source): a service exposes UUID, subtype, displayName (mutable),
 * characteristics (the public array getCharacteristicConstructor destructures), optionalCharacteristics, addOptionalCharacteristic, testCharacteristic,
 * getCharacteristic, updateCharacteristic, and removeService's target shape; a characteristic exposes value, updateValue, onGet, onSet, and
 * the triggerGet / triggerSet test knobs; an accessory exposes context, displayName, _associatedHAPAccessory, services, addService, getService,
 * getServiceById, and removeService.
 */

// Identity classes for the HAP Characteristic kinds the plugin touches. Each kind is its own marker class carrying a hapKind property (so a failure surfaces the
// kind in inspect output) and, where production compares against named constants, the HAP integer constants as statics. Production passes the class itself as a
// key into getCharacteristic / updateCharacteristic; the value is looked up by class identity.
class ActiveCharacteristicType {

  public static readonly ACTIVE = 1;
  public static readonly INACTIVE = 0;
  public readonly hapKind = "Active" as const;
}

class ConfiguredNameCharacteristicType {

  public readonly hapKind = "ConfiguredName" as const;
}

class InUseCharacteristicType {

  public static readonly IN_USE = 1;
  public static readonly NOT_IN_USE = 0;
  public readonly hapKind = "InUse" as const;
}

class IsConfiguredCharacteristicType {

  public static readonly CONFIGURED = 1;
  public static readonly NOT_CONFIGURED = 0;
  public readonly hapKind = "IsConfigured" as const;
}

class ManufacturerCharacteristicType {

  public readonly hapKind = "Manufacturer" as const;
}

class ModelCharacteristicType {

  public readonly hapKind = "Model" as const;
}

class NameCharacteristicType {

  public readonly hapKind = "Name" as const;
}

class OnCharacteristicType {

  public readonly hapKind = "On" as const;
}

class ProgramModeCharacteristicType {

  public static readonly NO_PROGRAM_SCHEDULED = 0;
  public static readonly PROGRAM_SCHEDULED = 1;
  public static readonly PROGRAM_SCHEDULED_MANUAL_MODE = 2;
  public readonly hapKind = "ProgramMode" as const;
}

class RemainingDurationCharacteristicType {

  public readonly hapKind = "RemainingDuration" as const;
}

class SerialNumberCharacteristicType {

  public readonly hapKind = "SerialNumber" as const;
}

class ServiceLabelIndexCharacteristicType {

  public readonly hapKind = "ServiceLabelIndex" as const;
}

class ServiceLabelNamespaceCharacteristicType {

  public static readonly ARABIC_NUMERALS = 1;
  public static readonly DOTS = 0;
  public readonly hapKind = "ServiceLabelNamespace" as const;
}

class SetDurationCharacteristicType {

  public readonly hapKind = "SetDuration" as const;
}

class ValveTypeCharacteristicType {

  public static readonly GENERIC_VALVE = 0;
  public static readonly IRRIGATION = 1;
  public static readonly SHOWER_HEAD = 2;
  public static readonly WATER_FAUCET = 3;
  public readonly hapKind = "ValveType" as const;
}

// The HAP Characteristic namespace as the test-double exposes it. Alphabetical per the house property-order style. Add a kind here when production reaches for one.
export const Characteristic = {

  Active: ActiveCharacteristicType,
  ConfiguredName: ConfiguredNameCharacteristicType,
  InUse: InUseCharacteristicType,
  IsConfigured: IsConfiguredCharacteristicType,
  Manufacturer: ManufacturerCharacteristicType,
  Model: ModelCharacteristicType,
  Name: NameCharacteristicType,
  On: OnCharacteristicType,
  ProgramMode: ProgramModeCharacteristicType,
  RemainingDuration: RemainingDurationCharacteristicType,
  SerialNumber: SerialNumberCharacteristicType,
  ServiceLabelIndex: ServiceLabelIndexCharacteristicType,
  ServiceLabelNamespace: ServiceLabelNamespaceCharacteristicType,
  SetDuration: SetDurationCharacteristicType,
  ValveType: ValveTypeCharacteristicType
} as const;

// The constructor-as-key shapes both namespaces expose. The argument list is intentionally permissive: the characteristic markers take no arguments, the service
// markers take HAP's (displayName?, subtype?) pair, and the alias must admit either when used as a Map key.
export type CharacteristicType = abstract new (...args: never[]) => object;
export type ServiceType = abstract new (...args: never[]) => object;

// One characteristic backing instance, owned by a TestService. Holds the last value written plus the optional onGet / onSet handlers production installs.
// triggerGet / triggerSet are the test-side knobs that exercise the bound handlers without a real HAP request path.
export class TestCharacteristic {

  public readonly type: CharacteristicType;
  private currentValue: unknown = null;
  private getHandler: (() => unknown) | undefined = undefined;
  private setHandler: ((value: unknown) => Promise<void> | void) | undefined = undefined;

  public constructor(type: CharacteristicType) {

    this.type = type;
  }

  // The most recently written value. Production reads this after updateCharacteristic to confirm its own write landed.
  public get value(): unknown {

    return this.currentValue;
  }

  // Write a value into the characteristic. Returns this so it chains in the production-typical service.updateCharacteristic pattern.
  public updateValue(value: unknown): this {

    this.currentValue = value;

    return this;
  }

  // Install the production read handler. Tests inspect what was bound via triggerGet.
  public onGet(handler: () => unknown): this {

    this.getHandler = handler;

    return this;
  }

  // Install the production write handler. Tests drive it via triggerSet; the production handler runs as if HomeKit invoked it.
  public onSet(handler: (value: unknown) => Promise<void> | void): this {

    this.setHandler = handler;

    return this;
  }

  // Test-side trigger for the installed onGet handler. Falls through to the last-written value when no handler is bound, matching HAP's read-from-cache semantics.
  public async triggerGet(): Promise<unknown> {

    if(!this.getHandler) {

      return this.currentValue;
    }

    return this.getHandler();
  }

  // Test-side trigger for the installed onSet handler. After the handler resolves, the supplied value becomes the cached value, mirroring HAP's set-then-cache
  // behavior.
  public async triggerSet(value: unknown): Promise<void> {

    if(this.setHandler) {

      await this.setHandler(value);
    }

    this.currentValue = value;
  }
}

/* One service instance attached to a TestAccessory. Holds a Map of characteristic-kind -> TestCharacteristic so getCharacteristic returns the same instance
 * across calls (production binds onGet / onSet once and expects the binding to persist). characteristics is a PUBLIC ARRAY view because acquireService's
 * getCharacteristicConstructor destructures the first element to recover the Characteristic constructor and throws when none exists - which is why each
 * constructible service marker seeds one characteristic. displayName is MUTABLE because setServiceName assigns it on every acquire. UUID mirrors the marker's
 * static and is never empty, keeping the real helpers' name-set predicates honestly false against markers that carry no name statics.
 */
export class TestService {

  public displayName: string;
  public readonly subtype: string | undefined;
  public readonly type: ServiceType;
  private readonly characteristicsByType = new Map<CharacteristicType, TestCharacteristic>();
  private readonly optionalTypes = new Set<CharacteristicType>();

  public constructor(type: ServiceType, displayName: string, subtype: string | undefined) {

    this.displayName = displayName;
    this.subtype = subtype;
    this.type = type;
  }

  // The service kind's identity string, mirrored from the type's static. Real HAP identifies kinds by UUID; the double uses the kind string, which is unique
  // within the namespace and legible in failures. The fallback is a non-empty sentinel for a hand-rolled type outside the namespace, so the returned UUID is
  // never empty.
  public get UUID(): string {

    return (this.type as { UUID?: string }).UUID ?? "unidentified-service-kind";
  }

  // The public array view of the materialized characteristics, mirroring HAP's Service.characteristics. Insertion order, so a marker's seed characteristic is
  // always first - exactly what the real getCharacteristicConstructor destructures.
  public get characteristics(): TestCharacteristic[] {

    return [...this.characteristicsByType.values()];
  }

  // The optional-characteristic view HAP exposes. The real acquireService reads this behind its name-set predicates (which resolve false against these markers),
  // so it is populated only if a caller explicitly declares an optional characteristic.
  public get optionalCharacteristics(): TestCharacteristic[] {

    return [...this.optionalTypes].map(type => this.getCharacteristic(type));
  }

  // Fetch or lazily create the characteristic of the given kind. Lazy creation matches HAP, which instantiates required characteristics on first access.
  public getCharacteristic(charType: CharacteristicType): TestCharacteristic {

    let char = this.characteristicsByType.get(charType);

    if(!char) {

      char = new TestCharacteristic(charType);
      this.characteristicsByType.set(charType, char);
    }

    return char;
  }

  // Write a value to the characteristic of the given kind. Returns this so chained production updates compile.
  public updateCharacteristic(charType: CharacteristicType, value: unknown): this {

    this.getCharacteristic(charType).updateValue(value);

    return this;
  }

  // Declare an optional characteristic, mirroring HAP's Service.addOptionalCharacteristic. HAP lazily materializes a permitted characteristic on first access, so
  // the double records it in the optional set and materializes it now, keeping a later getCharacteristic / onGet bind against the SAME instance.
  public addOptionalCharacteristic(charType: CharacteristicType): void {

    this.optionalTypes.add(charType);
    this.getCharacteristic(charType);
  }

  // Report whether the characteristic of the given kind has already been created, mirroring HAP's Service.testCharacteristic. Unlike getCharacteristic, this never
  // lazily creates - it is a pure predicate over what has already been added.
  public testCharacteristic(charType: CharacteristicType): boolean {

    return this.characteristicsByType.has(charType);
  }
}

// The service marker classes. Each is a CONSTRUCTIBLE subclass of TestService carrying HAP's (displayName?, subtype?) constructor, because the real acquireService
// instantiates the namespace entry directly on its create branch and recovers the Characteristic constructor from the new service's first characteristic. Every
// marker therefore seeds exactly one characteristic at construction: the kind's primary required characteristic.
class AccessoryInformationServiceType extends TestService {

  public static readonly UUID = "AccessoryInformation";
  public readonly hapKind = "AccessoryInformation" as const;

  public constructor(displayName = "", subtype?: string) {

    super(AccessoryInformationServiceType, displayName, subtype);

    this.getCharacteristic(NameCharacteristicType);
  }
}

class IrrigationSystemServiceType extends TestService {

  public static readonly UUID = "IrrigationSystem";
  public readonly hapKind = "IrrigationSystem" as const;

  public constructor(displayName = "", subtype?: string) {

    super(IrrigationSystemServiceType, displayName, subtype);

    this.getCharacteristic(ActiveCharacteristicType);
  }
}

class ServiceLabelServiceType extends TestService {

  public static readonly UUID = "ServiceLabel";
  public readonly hapKind = "ServiceLabel" as const;

  public constructor(displayName = "", subtype?: string) {

    super(ServiceLabelServiceType, displayName, subtype);

    this.getCharacteristic(ServiceLabelNamespaceCharacteristicType);
  }
}

class SwitchServiceType extends TestService {

  public static readonly UUID = "Switch";
  public readonly hapKind = "Switch" as const;

  public constructor(displayName = "", subtype?: string) {

    super(SwitchServiceType, displayName, subtype);

    this.getCharacteristic(OnCharacteristicType);
  }
}

class ValveServiceType extends TestService {

  public static readonly UUID = "Valve";
  public readonly hapKind = "Valve" as const;

  public constructor(displayName = "", subtype?: string) {

    super(ValveServiceType, displayName, subtype);

    this.getCharacteristic(ActiveCharacteristicType);
  }
}

// The HAP Service namespace as the test-double exposes it. Alphabetical per the house property-order style. Add a kind here when production touches one.
export const Service = {

  AccessoryInformation: AccessoryInformationServiceType,
  IrrigationSystem: IrrigationSystemServiceType,
  ServiceLabel: ServiceLabelServiceType,
  Switch: SwitchServiceType,
  Valve: ValveServiceType
} as const;

/* One accessory. Carries an AccessoryInformation service from construction (every HomeKit accessory has one); subsequent addService calls append more. getService
 * / getServiceById mirror HAP's distinction between "the bare service of this type" and "the service of this type with a specific subtype". The mutable context
 * and displayName are the fields the production controller path reads and writes; the _associatedHAPAccessory mirror is retained for HAP-shape parity because the
 * accessoryName setter assigns through it.
 */
export class TestAccessory {

  public context: Record<string, unknown> = {};
  public displayName: string;
  public readonly UUID: string;
  public readonly _associatedHAPAccessory: { displayName: string };
  public readonly services: TestService[] = [];

  public constructor(displayName: string, uuid: string) {

    this.displayName = displayName;
    this.UUID = uuid;
    this._associatedHAPAccessory = { displayName };
    this.services.push(new TestService(Service.AccessoryInformation, displayName, undefined));
  }

  /* Add a new service in either form HAP's real addService accepts: a service INSTANCE (what acquireService passes after constructing a namespace marker), or the
   * legacy (type, name?, subtype?) form. The instanceof check is sound because a marker CLASS is never an instance of TestService - only constructed services are.
   * Returns the service so production can immediately bind characteristics on it.
   */
  public addService(service: TestService): TestService;
  public addService(type: ServiceType, name?: string, subtype?: string): TestService;
  public addService(typeOrService: ServiceType | TestService, name?: string, subtype?: string): TestService {

    const service = (typeOrService instanceof TestService) ? typeOrService : new TestService(typeOrService, name ?? this.displayName, subtype);

    this.services.push(service);

    return service;
  }

  // Find the first service of the given type with no subtype. Production uses this for the "primary" service of a type.
  public getService(type: ServiceType): TestService | undefined {

    return this.services.find(service => (service.type === type) && (service.subtype === undefined));
  }

  // Find the service of the given type AND subtype. Production uses subtypes to disambiguate among multiple Valve or Switch services on one accessory.
  public getServiceById(type: ServiceType, subtype: string): TestService | undefined {

    return this.services.find(service => (service.type === type) && (service.subtype === subtype));
  }

  // Remove a service instance, mirroring HAP's PlatformAccessory.removeService - the path the real validService takes when a service fails validation and the
  // path the controller takes when it prunes a vanished zone's valve.
  public removeService(service: TestService): void {

    const index = this.services.indexOf(service);

    if(index !== -1) {

      this.services.splice(index, 1);
    }
  }
}

/**
 * Build a TestAccessory with a sensible default name and UUID. Pass overrides when a test needs a specific identity.
 *
 * @param displayName - the accessory's display name. Defaults to "Test Controller".
 * @param uuid        - the accessory's UUID. Defaults to the synthetic controller id so tests get reproducible identity by default.
 *
 * @returns a fresh TestAccessory pre-populated with an AccessoryInformation service.
 */
export function makeTestAccessory(displayName = "Test Controller", uuid = "500001"): TestAccessory {

  return new TestAccessory(displayName, uuid);
}
