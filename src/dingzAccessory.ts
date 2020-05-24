import {
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';

import { EventEmitter } from 'events';
import { Policy } from 'cockatiel';
import { Mutex } from 'async-mutex';
import simpleColorConverter from 'simple-color-converter';
import qs from 'qs';

// Internal types
import {
  ButtonAction,
  DingzMotionData,
  DingzDevices,
  DingzDeviceInfo,
  DingzInputInfoItem,
  DingzInputInfo,
  DeviceInfo,
  DimmerTimer,
  DimmerId,
  DimmerState,
  DingzLEDState,
  WindowCoveringId,
  WindowCoveringState,
  WindowCoveringTimer,
  DeviceDingzDimmerConfig,
  DingzDimmerConfigValue,
  ButtonId,
  DingzState,
} from './util/internalTypes';

import { MethodNotImplementedError } from './util/errors';
import { DingzDaHomebridgePlatform } from './platform';
import { DingzEvent } from './util/dingzEventBus';

// Policy for long running tasks, retry every hour
const retrySlow = Policy.handleAll()
  .orWhenResult((retry) => retry === true)
  .retry()
  .exponential({ initialDelay: 10000, maxDelay: 60 * 60 * 1000 });
/**
 * Interfaces
 */

interface Success {
  name: string;
  occupation: string;
}

interface Error {
  code: number;
  errors: string[];
}

/**
  Implemented Characteristics:
  [x] Dimmer (Lightbulb)
  [x] Blinds (WindowCovering)
  [x] Temperature (CurrentTemperature)
  [x] PIR (MotionSensor)
  [x] LED (ColorLightbulb)
  [] Buttons (StatelessProgrammableButton or so)
  [] Light Level (LightSensor/AmbientLightLevel)
*/

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */

export class DingzDaAccessory extends EventEmitter {
  private readonly mutex = new Mutex();

  private services: Service[] = [];

  private _updatedDeviceInfo?: DingzDeviceInfo;
  private _updatedDeviceInputConfig?: DingzInputInfoItem;

  private switchOn = false;
  private device: DeviceInfo;
  private dingzDeviceInfo: DingzDeviceInfo;
  private baseUrl: string;

  // Todo: Make proper internal representation
  private dingzStates = {
    // FIXME: Make structure less hardware-like
    // Outputs
    Dimmers: [] as DimmerState[],
    WindowCovers: [] as WindowCoveringState[],
    LED: {
      on: false,
      hsv: '0;0;100',
      rgb: 'FFFFFF',
      mode: 'hsv',
    } as DingzLEDState,
    // Inputs
    Buttons: {
      '1': ButtonAction.SINGLE_PRESS,
      '2': ButtonAction.SINGLE_PRESS,
      '3': ButtonAction.SINGLE_PRESS,
      '4': ButtonAction.SINGLE_PRESS,
    },
    // Sensors
    Temperature: 0,
    Motion: false,
    Brightness: 0,
  };

  // Take stock of intervals to dispose at the end of the life of the Accessory
  private serviceTimers: NodeJS.Timer[] = [];
  private motionTimer?: NodeJS.Timer;
  private dimmerTimers = {} as DimmerTimer;
  private windowCoveringTimers = {} as WindowCoveringTimer;

  constructor(
    private readonly platform: DingzDaHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    super();

    // Set Base URL
    this.device = this.accessory.context.device;
    this.dingzDeviceInfo = this.device.hwInfo as DingzDeviceInfo;
    this.baseUrl = `http://${this.device.address}`;

    // Sanity check for "empty" SerialNumber
    this.platform.log.debug(
      `Attempting to set SerialNumber (which can not be empty) -> puck_sn: <${this.dingzDeviceInfo.puck_sn}>`,
    );
    const serialNumber: string =
      this.dingzDeviceInfo.puck_sn === ''
        ? this.device.mac // MAC will always be defined for a correct device
        : this.dingzDeviceInfo.puck_sn;
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.ConfiguredName,
        this.device.name,
      )
      .setCharacteristic(this.platform.Characteristic.Name, this.device.name)
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Iolo AG')
      .setCharacteristic(
        this.platform.Characteristic.Model,
        this.device.model as string,
      )
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        this.dingzDeviceInfo.fw_version_puck ?? 'Unknown',
      )
      .setCharacteristic(
        this.platform.Characteristic.HardwareRevision,
        this.dingzDeviceInfo.hw_version_puck ?? 'Unknown',
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        serialNumber,
      );
    /****
     * How to discover Accessories:
     * - Check for UDP Packets and/or use manually configured accessories
     */

    // Add Dimmers, Blinds etc.
    this.platform.log.info('Adding output devices -> [...]');
    this.getDeviceInputConfig()
      .then((data) => {
        if (data.inputs) {
          this.device.dingzInputInfo = data.inputs;
        }
        return this.getDingzDeviceDimmerConfig();
      })
      .then((data) => {
        if (data.dimmers && data.dimmers.length === 4) {
          this.device.dimmerConfig = data;
        }

        // Now we have what we need and can create the services …
        this.addOutputServices();
        setInterval(() => {
          // TODO: Set rechability if call times out too many times
          // Set up an interval to fetch Dimmer states
          this.getDeviceState().then((state) => {
            if (typeof state !== 'undefined') {
              // Outputs
              this.dingzStates.Dimmers = state.dimmers;
              this.dingzStates.LED = state.led;
              this.dingzStates.WindowCovers = state.blinds;
              // Sensors
              this.dingzStates.Temperature = state.sensors.room_temperature;
              this.dingzStates.Brightness = state.sensors.brightness;

              this.platform.eb.emit(DingzEvent.STATE_UPDATE);
            }
          });
        }, 10000);
      })
      .then(() => {
        /**
         * Add auxiliary services (Motion, Temperature)
         */
        if (this.dingzDeviceInfo.has_pir) {
          // Dingz has a Motion sensor -- let's create it
          this.addMotionService();
        } else {
          this.platform.log.info(
            'Your Dingz',
            this.accessory.displayName,
            'has no Motion sensor.',
          );
        }
        // Dingz has a temperature sensor and an LED,
        // make these available here
        this.addTemperatureService();
        this.addLEDService();
        this.addLightSensorService();
        this.addButtonServices();

        this.services.forEach((service) => {
          this.platform.log.info(
            'Service created ->',
            service.getCharacteristic(this.platform.Characteristic.Name).value,
          );
        });

        // Retry at least once every day
        retrySlow.execute(() => {
          this.updateAccessory();
          return true;
        });
      });
  }

  private addTemperatureService() {
    const temperatureService: Service =
      this.accessory.getService(this.platform.Service.TemperatureSensor) ??
      this.accessory.addService(this.platform.Service.TemperatureSensor);
    temperatureService.setCharacteristic(
      this.platform.Characteristic.Name,
      'Temperature',
    );

    // create handlers for required characteristics
    temperatureService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .on(CharacteristicEventTypes.GET, this.getTemperature.bind(this));
    this.services.push(temperatureService);

    this.platform.eb.on(
      DingzEvent.STATE_UPDATE,
      this.updateTemperature.bind(this, temperatureService),
    );
  }

  private updateTemperature(temperatureService: Service) {
    const currentTemperature: number = this.dingzStates.Temperature;

    temperatureService
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .updateValue(currentTemperature);
  }

  /**
   * Handle the "GET" requests from HomeKit
   * to get the current value of the "Current Temperature" characteristic
   */
  private getTemperature(callback: CharacteristicSetCallback) {
    // set this to a valid value for CurrentTemperature
    const currentTemperature: number = this.dingzStates.Temperature;
    callback(null, currentTemperature);
  }

  /**
   * Handle Handle the "GET" requests from HomeKit
   * to get the current value of the "Motion Detected" characteristic
   */
  private getMotionDetected(callback: CharacteristicSetCallback) {
    // set this to a valid value for MotionDetected
    const isMotion = this.dingzStates.Motion;
    callback(null, isMotion);
  }

  /*
   * This method is optional to implement. It is called when HomeKit ask to identify the accessory.
   * Typical this only ever happens at the pairing process.
   */
  identify(): void {
    this.platform.log.info(
      'Identify! -> Who am I? I am',
      this.accessory.displayName,
    );
  }

  private addLightSensorService() {
    // Add the LightSensor that's integrated in the DingZ
    // API: /api/v1/light

    const lightService =
      this.accessory.getService(this.platform.Service.LightSensor) ??
      this.accessory.addService(this.platform.Service.LightSensor);

    lightService.setCharacteristic(this.platform.Characteristic.Name, 'Light');
    this.services.push(lightService);

    this.platform.eb.on(
      DingzEvent.STATE_UPDATE,
      this.updateLightSensor.bind(this, lightService),
    );
  }

  private updateLightSensor(lightService: Service) {
    const intensity: number = this.dingzStates.Brightness;
    lightService
      .getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
      .updateValue(intensity);
  }

  private addOutputServices() {
    // This is the block for the multiple services (Dimmers 1-4 / Blinds 1-2 / Buttons 1-4)
    // If "Input" is set, Dimmer 1 won't work. We have to take this into account

    // Get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    const dimmerServices: Service[] = [];
    const windowCoverServices: Service[] = [];

    const inputConfig: DingzInputInfoItem[] | undefined = this.device
      .dingzInputInfo;
    const dimmerConfig: DeviceDingzDimmerConfig | undefined = this.device
      .dimmerConfig;

    /** DIP Switch
     * 0			M1& M2		(2 blinds)
     * 1			1/2L & M2	(1 blind (M2) and 2 lights)
     * 2			3/4L & M1	(1 blind (M1) and 2 lights)
     * 3			1/2/3/4L		(4 lights)
     */

    switch (this.dingzDeviceInfo.dip_config) {
      case 3:
        // DIP = 0: D0, D1, D2, D3; (Subtypes) (Unless Input, then D1, D2, D3)
        if (inputConfig && !inputConfig[0].active) {
          // D0
          dimmerServices.push(
            this.addDimmerService({
              name: dimmerConfig?.dimmers[0].name,
              output: dimmerConfig?.dimmers[0].output,
              id: 'D1',
              index: 0,
            }),
          );
        }
        // D1, D2, D3
        dimmerServices.push(
          this.addDimmerService({
            name: dimmerConfig?.dimmers[1].name,
            output: dimmerConfig?.dimmers[1].output,
            id: 'D2',
            index: 1,
          }),
        );
        dimmerServices.push(
          this.addDimmerService({
            name: dimmerConfig?.dimmers[2].name,
            output: dimmerConfig?.dimmers[2].output,
            id: 'D3',
            index: 2,
          }),
        );
        dimmerServices.push(
          this.addDimmerService({
            name: dimmerConfig?.dimmers[3].name,
            output: dimmerConfig?.dimmers[3].output,
            id: 'D4',
            index: 3,
          }),
        );
        break;
      case 2:
        // DIP = 1: M0, D2, D3;
        windowCoverServices.push(this.addWindowCoveringService('Blind', 0));
        // Dimmers are always 0 based
        // i.e. if outputs 1 / 2 are for blinds, outputs 3/4 will be dimmer 0/1
        // We use the "index" value of the DingZ to determine what to use
        dimmerServices.push(
          this.addDimmerService({
            name: dimmerConfig?.dimmers[0].name,
            output: dimmerConfig?.dimmers[0].output,
            id: 'D3',
            index: 0,
          }),
        );
        dimmerServices.push(
          this.addDimmerService({
            name: dimmerConfig?.dimmers[1].name,
            output: dimmerConfig?.dimmers[1].output,
            id: 'D4',
            index: 1,
          }),
        );
        break;
      case 1:
        // DIP = 2: D0, D1, M1; (Unless Input, then D1, M1);
        if (inputConfig && !inputConfig[0].active) {
          // D0
          dimmerServices.push(
            this.addDimmerService({
              name: dimmerConfig?.dimmers[0].name,
              output: dimmerConfig?.dimmers[0].output,
              id: 'D1',
              index: 0,
            }),
          );
        }
        dimmerServices.push(
          this.addDimmerService({
            name: dimmerConfig?.dimmers[1].name,
            output: dimmerConfig?.dimmers[1].output,
            id: 'D2',
            index: 1,
          }),
        );
        windowCoverServices.push(this.addWindowCoveringService('Blind', 0));
        break;
      case 0:
        // DIP = 3: M0, M1;
        windowCoverServices.push(this.addWindowCoveringService('Blind', 0));
        windowCoverServices.push(this.addWindowCoveringService('Blind', 1));
        break;
      default:
        break;
    }

    windowCoverServices.forEach((service) => {
      this.services.push(service);
    });

    dimmerServices.forEach((service) => {
      this.services.push(service);
    });
  }

  private addButtonServices() {
    // Create Buttons
    // Add Event Listeners
    this.addButtonService('Button 1', '1');
    this.addButtonService('Button 2', '2');
    this.addButtonService('Button 3', '3');
    this.addButtonService('Button 4', '4');

    this.platform.eb.on(
      DingzEvent.BTN_PRESS,
      (mac: string, button: ButtonId, action: ButtonAction) => {
        if (mac === this.device.mac) {
          this.dingzStates.Buttons[button] = action ?? 1;
          const service = this.accessory.getServiceById(
            this.platform.Service.StatelessProgrammableSwitch,
            button,
          );

          const ProgrammableSwitchEvent = this.platform.Characteristic
            .ProgrammableSwitchEvent;
          if (service) {
            this.platform.log.warn(
              `Button ${button} of ${this.device.name} (${service.displayName}) pressed -> ${action}`,
            );
            switch (action) {
              case ButtonAction.SINGLE_PRESS:
                service
                  .getCharacteristic(ProgrammableSwitchEvent)
                  .updateValue(ProgrammableSwitchEvent.SINGLE_PRESS);
                this.platform.log.warn('SINGLE_PRESS');
                break;
              case ButtonAction.DOUBLE_PRESS:
                service
                  .getCharacteristic(ProgrammableSwitchEvent)
                  .updateValue(ProgrammableSwitchEvent.DOUBLE_PRESS);
                this.platform.log.warn('DOUBLE_PRESS');
                break;
              case ButtonAction.LONG_PRESS:
                service
                  .getCharacteristic(ProgrammableSwitchEvent)
                  .updateValue(ProgrammableSwitchEvent.LONG_PRESS);
                this.platform.log.warn('LONG_PRESS');
                break;
            }
          }
        }
      },
    );
  }

  private addButtonService(name: string, button: ButtonId): Service {
    this.platform.log.debug('Adding Button Service ->', name, ' -> ', button);

    const newService =
      this.accessory.getServiceById(
        this.platform.Service.StatelessProgrammableSwitch,
        button,
      ) ??
      this.accessory.addService(
        this.platform.Service.StatelessProgrammableSwitch,
        name ?? `Button ${button}`, // Name Dimmers according to WebUI, not API info
        button,
      );

    newService
      .getCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent)
      .on(CharacteristicEventTypes.GET, this.getButtonState.bind(this, button));

    return newService;
  }

  private getButtonState(
    button: ButtonId,
    callback: CharacteristicGetCallback,
  ) {
    const currentState = this.dingzStates.Buttons[button];
    callback(null, currentState);
  }

  private addDimmerService({
    name,
    output,
    id,
    index,
  }: {
    name?: string;
    output?: DingzDimmerConfigValue;
    id: 'D1' | 'D2' | 'D3' | 'D4';
    index: DimmerId;
  }) {
    // Service doesn't yet exist, create new one
    // FIXME can be done more beautifully I guess
    const newService =
      this.accessory.getServiceById(this.platform.Service.Lightbulb, id) ??
      this.accessory.addService(
        this.platform.Service.Lightbulb,
        name ?? `Dimmer ${id}`, // Name Dimmers according to WebUI, not API info
        id,
      );
    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    newService
      .getCharacteristic(this.platform.Characteristic.On)
      .on(CharacteristicEventTypes.SET, this.setOn.bind(this, index)) // SET - bind to the `setOn` method below
      .on(CharacteristicEventTypes.GET, this.getOn.bind(this, index)); // GET - bind to the `getOn` method below

    // register handlers for the Brightness Characteristic but only if not dimmable
    if (output && output !== 'non_dimmable') {
      newService
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .on(CharacteristicEventTypes.SET, this.setBrightness.bind(this, index)); // SET - bind to the 'setBrightness` method below
    }

    // Update State
    this.platform.eb.on(
      DingzEvent.STATE_UPDATE,
      this.updateDimmerState.bind(this, index, output, newService, id),
    );
    return newService;
  }

  private updateDimmerState(
    index: number,
    output: string | undefined,
    newService: Service,
    id: string,
  ) {
    if (index) {
      // index set
      const state = this.dingzStates.Dimmers[index];
      // Check that "state" is valid
      if (state) {
        if (output && output !== 'non_dimmable') {
          newService
            .getCharacteristic(this.platform.Characteristic.Brightness)
            .updateValue(state.value);
        }
        newService
          .getCharacteristic(this.platform.Characteristic.On)
          .updateValue(state.on);
      } else {
        this.platform.log.warn(
          'We have an issue here: state should be non-empty but is undefined.',
          `Continue here, not killing myself anymore. For the records, id: ${id},  index: ${index} and output is: `,
          JSON.stringify(this.dingzStates),
        );
      }
    }
  }

  private removeDimmerService(id: 'D1' | 'D2' | 'D3' | 'D4') {
    // Remove motionService
    const service: Service | undefined = this.accessory.getServiceById(
      this.platform.Service.Lightbulb,
      id,
    );
    if (service) {
      this.platform.log.debug('Removing Dimmer ->', service.displayName);
      clearTimeout(this.dimmerTimers[id]);
      this.accessory.removeService(service);
    }
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  private setOn(
    index: DimmerId,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) {
    this.dingzStates.Dimmers[index].on = value as boolean;
    try {
      this.setDeviceDimmer(index, value as boolean);
    } catch (e) {
      this.platform.log.error(
        'Error ->',
        e.name,
        ', unable to set Dimmer data ',
        index,
      );
    }
    // you must call the callback function
    callback(null);
  }

  /**
   * Handle the "GET" requests from HomeKit
   */
  private getOn(index: DimmerId, callback: CharacteristicGetCallback) {
    const isOn: boolean = this.dingzStates.Dimmers[index]?.on ?? false;
    // you must call the callback function
    // the first argument should be null if there were no errors
    // the second argument should be the value to return
    callback(null, isOn);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  private async setBrightness(
    index: DimmerId,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) {
    // implement your own code to set the brightness
    const isOn: boolean = value > 0 ? true : false;
    this.dingzStates.Dimmers[index].value = value as number;
    this.dingzStates.Dimmers[index].on = isOn;

    await this.setDeviceDimmer(index, isOn, value as number);
    // you must call the callback function
    callback(null);
  }

  // Add WindowCovering (Blinds)
  private addWindowCoveringService(name: string, id?: WindowCoveringId) {
    let service: Service;
    if (id) {
      service =
        this.accessory.getServiceById(
          this.platform.Service.WindowCovering,
          id.toString(),
        ) ??
        this.accessory.addService(
          this.platform.Service.WindowCovering,
          `${name} B${id}`,
          id.toString(),
        );
    } else {
      service =
        this.accessory.getService(this.platform.Service.WindowCovering) ??
        this.accessory.addService(this.platform.Service.WindowCovering, name);
    }
    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    service
      .getCharacteristic(this.platform.Characteristic.TargetPosition)
      .on(
        CharacteristicEventTypes.SET,
        this.setPosition.bind(this, id as WindowCoveringId),
      );

    // Set min/max Values
    service
      .getCharacteristic(this.platform.Characteristic.TargetHorizontalTiltAngle)
      .setProps({ minValue: 0, maxValue: 90 }) // Dingz Maximum values
      .on(
        CharacteristicEventTypes.SET,
        this.setTiltAngle.bind(this, id as WindowCoveringId),
      );

    service
      .getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .on(
        CharacteristicEventTypes.GET,
        this.getPosition.bind(this, id as WindowCoveringId),
      );
    service
      .getCharacteristic(
        this.platform.Characteristic.CurrentHorizontalTiltAngle,
      )
      .on(
        CharacteristicEventTypes.GET,
        this.getTiltAngle.bind(this, id as WindowCoveringId),
      );

    this.platform.eb.on(
      DingzEvent.STATE_UPDATE,
      this.updateWindowCoveringState.bind(
        this,
        id as WindowCoveringId,
        service,
      ),
    );
    return service;
  }

  private updateWindowCoveringState(id: WindowCoveringId, service: Service) {
    const state: WindowCoveringState = this.dingzStates.WindowCovers[id];
    service
      .getCharacteristic(this.platform.Characteristic.TargetPosition)
      .updateValue(state.target.blind);
    service
      .getCharacteristic(this.platform.Characteristic.TargetHorizontalTiltAngle)
      .updateValue(state.target.lamella);
    service
      .getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .updateValue(state.current.blind);
    service
      .getCharacteristic(
        this.platform.Characteristic.CurrentHorizontalTiltAngle,
      )
      .updateValue(state.current.lamella);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  private async setPosition(
    id: WindowCoveringId,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) {
    // implement your own code to set the brightness
    const blind: number = value as number;
    const lamella: number = this.dingzStates.WindowCovers[id].target.lamella;
    this.dingzStates.WindowCovers[id].target.blind = blind;

    await this.setWindowCovering(id, blind, lamella);
    // you must call the callback function
    callback(null);
  }

  /**
   * Handle the "GET" requests from HomeKit
   */
  private getPosition(
    id: WindowCoveringId,
    callback: CharacteristicGetCallback,
  ) {
    this.platform.log.debug(
      'WindowCoverings: ',
      JSON.stringify(this.dingzStates.WindowCovers),
    );
    const position: number = this.dingzStates.WindowCovers[id].current.blind;

    this.platform.log.debug(
      'Get Characteristic for WindowCovering',
      id,
      'Current Position ->',
      position,
    );

    // you must call the callback function
    // the first argument should be null if there were no errors
    // the second argument should be the value to return
    callback(null, position);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  private async setTiltAngle(
    id: WindowCoveringId,
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) {
    // implement your own code to set the brightness
    const blind: number = this.dingzStates.WindowCovers[id].target.blind;
    const lamella: number = value as number;
    this.dingzStates.WindowCovers[id].target.lamella = lamella;

    this.platform.log.debug(
      'Set Characteristic TargetHorizontalTiltAngle on ',
      id,
      '->',
      value,
    );
    await this.setWindowCovering(id, blind, lamella);
    // you must call the callback function
    callback(null);
  }

  /**
   * Handle the "GET" requests from HomeKit
   */
  private getTiltAngle(
    id: WindowCoveringId,
    callback: CharacteristicGetCallback,
  ) {
    this.platform.log.debug(
      'WindowCoverings: ',
      JSON.stringify(this.dingzStates.WindowCovers),
    );
    const tiltAngle: number = this.dingzStates.WindowCovers[id].current.lamella;

    this.platform.log.debug(
      'Get Characteristic for WindowCovering',
      id,
      'Current TiltAngle ->',
      tiltAngle,
    );

    // you must call the callback function
    // the first argument should be null if there were no errors
    // the second argument should be the value to return
    callback(null, tiltAngle);
  }

  /**
   * Motion Service Methods
   */
  private addMotionService() {
    let service: Service | undefined = undefined;

    service =
      this.accessory.getService(this.platform.Service.MotionSensor) ??
      this.accessory.addService(this.platform.Service.MotionSensor);
    service.setCharacteristic(this.platform.Characteristic.Name, 'Motion');
    this.services.push(service);
    // Only check for motion if we have a PIR and set the Interval
    const motionInterval: NodeJS.Timer = setInterval(() => {
      try {
        this.getDeviceMotion().then((data) => {
          if (data.success) {
            const isMotion: boolean = data.motion;

            // Only update if motionService exists *and* if there's a change in motion'
            if (service && this.dingzStates.Motion !== isMotion) {
              this.dingzStates.Motion = isMotion;
              service
                .getCharacteristic(this.platform.Characteristic.MotionDetected)
                .updateValue(isMotion);
            }
          }
        });
      } catch (e) {
        this.platform.log.error(
          'Error ->',
          e.name,
          ', unable to fetch DeviceMotion data',
        );
      }
    }, 2000); // Shorter term updates for motion sensor
    this.motionTimer = motionInterval;
  }

  // Remove motion service
  private removeMotionService() {
    // Remove motionService & motionTimer
    if (this.motionTimer) {
      clearTimeout(this.motionTimer);
      this.motionTimer = undefined;
    }
    const service: Service | undefined = this.accessory.getService(
      this.platform.Service.MotionSensor,
    );
    if (service) {
      this.platform.log.info('Removing Motion service ->', service.displayName);
      this.accessory.removeService(service);
    }
  }

  // Updates the Accessory (e.g. if the config has changed)
  private async updateAccessory(): Promise<void> {
    this.platform.log.info('Update accessory -> Check for changed config.');

    this.getDeviceInputConfig().then((inputConfig) => {
      if (inputConfig && inputConfig.inputs[0]) {
        this._updatedDeviceInputConfig = inputConfig.inputs[0];
      }
    });

    this.getDingzDeviceInfo().then((deviceInfo) => {
      this._updatedDeviceInfo = deviceInfo;
    });

    this.getDingzDeviceDimmerConfig().then((dimmerConfig) => {
      this.device.dimmerConfig = dimmerConfig;
    });

    const currentDingzDeviceInfo: DingzDeviceInfo = this.accessory.context
      .device.dingzDeviceInfo;
    const updatedDingzDeviceInfo: DingzDeviceInfo =
      this._updatedDeviceInfo ?? currentDingzDeviceInfo;

    const currentDingzInputInfo: DingzInputInfoItem = this.accessory.context
      .device.dingzInputInfo[0];
    const updatedDingzInputInfo: DingzInputInfoItem =
      this._updatedDeviceInputConfig ?? currentDingzInputInfo;

    const dimmerConfig: DeviceDingzDimmerConfig | undefined = this.device
      .dimmerConfig;

    try {
      // FIXME: Crashes occasionally
      if (
        currentDingzDeviceInfo &&
        currentDingzDeviceInfo.has_pir !== updatedDingzDeviceInfo.has_pir
      ) {
        // Update PIR Service
        this.platform.log.warn('Update accessory -> PIR config changed.');
        if (updatedDingzDeviceInfo.has_pir) {
          // Add PIR service
          this.addMotionService();
        } else {
          // Remove PIR service
          this.removeMotionService();
        }
      }

      // Something about the Input config changed -- either remove or add the Dimmer,
      // but only if DIP is not set to WindowCovers
      // Update PIR Service
      if (updatedDingzInputInfo.active || currentDingzInputInfo.active) {
        if (
          this.accessory.getServiceById(this.platform.Service.Lightbulb, 'D1')
        ) {
          this.platform.log.warn(
            'Input active. Dimmer Service 0 can not exist -> remove',
          );
          this.removeDimmerService('D1');
        }
      } else if (
        !updatedDingzInputInfo.active &&
        !this.accessory.getServiceById(this.platform.Service.Lightbulb, 'D1') &&
        (updatedDingzDeviceInfo.dip_config === 1 ||
          updatedDingzDeviceInfo.dip_config === 3)
      ) {
        // Only add Dimmer 0 if we're not in "WindowCover" mode
        this.platform.log.warn(
          'No Input defined. Attempting to add Dimmer Service D1.',
        );
        this.addDimmerService({
          name: dimmerConfig?.dimmers[0].name,
          output: dimmerConfig?.dimmers[0].output,
          id: 'D1',
          index: 0,
        });
      }
      // DIP overrides Input
      if (
        currentDingzDeviceInfo &&
        currentDingzDeviceInfo.dip_config !== updatedDingzDeviceInfo.dip_config
      ) {
        // Update Dimmer & Blinds Services
        throw new MethodNotImplementedError(
          'Update Dimmer accessories not yet implemented -> ' +
            this.accessory.displayName,
        );
      }

      this.updateDimmerServices();
    } finally {
      this.accessory.context.device.dingzDeviceInfo = updatedDingzDeviceInfo;
      this.accessory.context.device.dingzInputInfo = [updatedDingzInputInfo];
    }
  }

  // Updates the Dimemr Services with their correct name
  private updateDimmerServices() {
    // Figure out what we have here
    switch (this.dingzDeviceInfo.dip_config) {
      case 3:
        this.setDimmerConfig('D1', 0);
        this.setDimmerConfig('D2', 1);
        this.setDimmerConfig('D3', 2);
        this.setDimmerConfig('D4', 3);
        break;
      case 2:
      case 1:
        this.setDimmerConfig('D1', 0);
        this.setDimmerConfig('D2', 1);
        break;
      case 0:
      default:
        break;
    }
  }

  private setDimmerConfig(id: 'D1' | 'D2' | 'D3' | 'D4', index: DimmerId) {
    const service: Service | undefined = this.accessory.getServiceById(
      this.platform.Service.Lightbulb,
      id,
    );
    if (service) {
      const dimmerConfig = this.device.dimmerConfig;
      service.setCharacteristic(
        this.platform.Characteristic.Name,
        dimmerConfig?.dimmers[index].name ?? `Dimmer ${id}`,
      );
      if (dimmerConfig?.dimmers[index].output === 'non_dimmable') {
        service.removeCharacteristic(
          service.getCharacteristic(this.platform.Characteristic.Brightness),
        );
      } else {
        service
          .getCharacteristic(this.platform.Characteristic.Brightness)
          .on(
            CharacteristicEventTypes.SET,
            this.setBrightness.bind(this, index),
          ); // SET - bind to the 'setBrightness` method below
      }
    }
  }

  private addLEDService() {
    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    const ledService =
      this.accessory.getServiceById(this.platform.Service.Lightbulb, 'LED') ??
      this.accessory.addService(this.platform.Service.Lightbulb, 'LED', 'LED');

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    ledService.setCharacteristic(this.platform.Characteristic.Name, 'LED');

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    ledService
      .getCharacteristic(this.platform.Characteristic.On)
      .on(CharacteristicEventTypes.SET, this.setLEDOn.bind(this)) // SET - bind to the `setOn` method below
      .on(CharacteristicEventTypes.GET, this.getLEDOn.bind(this)); // GET - bind to the `getOn` method below

    // register handlers for the Brightness Characteristic
    ledService
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .on(CharacteristicEventTypes.SET, this.setLEDBrightness.bind(this)); // SET - bind to the 'setBrightness` method below

    // register handlers for the Brightness Characteristic
    ledService
      .getCharacteristic(this.platform.Characteristic.Hue)
      .on(CharacteristicEventTypes.SET, this.setLEDHue.bind(this)); // SET - bind to the 'setBrightness` method below

    // register handlers for the Brightness Characteristic
    ledService
      .getCharacteristic(this.platform.Characteristic.Saturation)
      .on(CharacteristicEventTypes.SET, this.setLEDSaturation.bind(this)); // SET - bind to the 'setBrightness` method below

    this.services.push(ledService);
    // Here we change update the brightness to a random value every 5 seconds using
    // the `updateCharacteristic` method.
    this.platform.eb.on(
      DingzEvent.STATE_UPDATE,
      this.updateLEDState.bind(this, ledService),
    );
  }

  private updateLEDState(ledService: Service) {
    const state: DingzLEDState = this.dingzStates.LED;
    if (state.mode === 'hsv') {
      const hsv = state.hsv.split(';');
      this.dingzStates.LED.hue = parseInt(hsv[0]);
      this.dingzStates.LED.saturation = parseInt(hsv[1]);
      this.dingzStates.LED.value = parseInt(hsv[2]);
    } else {
      // rgbw
      const hsv = new simpleColorConverter({
        color: `hex #${state.rgb}`,
        to: 'hsv',
      });
      this.dingzStates.LED.hue = hsv.c;
      this.dingzStates.LED.saturation = hsv.s;
      this.dingzStates.LED.value = hsv.i;
    }

    ledService
      .getCharacteristic(this.platform.Characteristic.Hue)
      .setValue(this.dingzStates.LED.hue);
    ledService
      .getCharacteristic(this.platform.Characteristic.Saturation)
      .setValue(this.dingzStates.LED.saturation);
    ledService
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .setValue(this.dingzStates.LED.value);
    ledService
      .getCharacteristic(this.platform.Characteristic.On)
      .setValue(this.dingzStates.LED.on);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  private setLEDOn(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) {
    // implement your own code to turn your device on/off
    this.dingzStates.LED.on = value as boolean;
    const state = this.dingzStates.LED;
    this.setDeviceLED({ isOn: state.on });
    // you must call the callback function
    callback(null);
  }

  /**
   * Handle the "GET" requests from HomeKit
   */
  private getLEDOn(callback: CharacteristicGetCallback) {
    // implement your own code to check if the device is on
    const isOn = this.dingzStates.LED.on;
    callback(null, isOn);
  }

  private setLEDHue(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) {
    // implement your own code to set the brightness    const isOn: boolean = value > 0 ? true : false;
    this.dingzStates.LED.hue = value as number;

    const state: DingzLEDState = this.dingzStates.LED;
    const color = `${state.hue};${state.saturation};${state.value}`;
    this.setDeviceLED({
      isOn: state.on,
      color: color,
    });
    callback(null);
  }

  private setLEDSaturation(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) {
    // implement your own code to set the brightness
    this.dingzStates.LED.saturation = value as number;

    const state: DingzLEDState = this.dingzStates.LED;
    const color = `${state.hue};${state.saturation};${state.value}`;
    this.setDeviceLED({
      isOn: state.on,
      color: color,
    });
    callback(null);
  }

  private setLEDBrightness(
    value: CharacteristicValue,
    callback: CharacteristicSetCallback,
  ) {
    // implement your own code to set the brightness
    this.dingzStates.LED.value = value as number;

    const state: DingzLEDState = this.dingzStates.LED;
    const color = `${state.hue};${state.saturation};${state.value}`;
    this.setDeviceLED({
      isOn: state.on,
      color: color,
    });
    callback(null);
  }

  /**
   * Device Methods -- these are used to retrieve the data from the Dingz
   * TODO: Refactor duplicate code into proper API caller
   */

  private async getDingzDeviceInfo(): Promise<DingzDeviceInfo> {
    const dingzDevices = await this.platform.getDingzDeviceInfo({
      address: this.device.address,
      token: this.device.token,
    });
    try {
      const dingzDeviceInfo: DingzDeviceInfo = (dingzDevices as DingzDevices)[
        this.device.mac
      ];
      if (dingzDeviceInfo) {
        return dingzDeviceInfo;
      }
    } catch (e) {
      this.platform.log.error('Error in getting Device Info ->', e.message);
    }
    throw new Error('Dingz Device update failed -> Empty data.');
  }

  private async getDeviceMotion(): Promise<DingzMotionData> {
    const getMotionUrl = `${this.baseUrl}/api/v1/motion`;
    const release = await this.mutex.acquire();
    try {
      return await this.platform.fetch({
        url: getMotionUrl,
        returnBody: true,
        token: this.device.token,
      });
    } finally {
      release();
    }
  }

  // Set individual dimmer
  private async setDeviceDimmer(
    index: DimmerId,
    isOn?: boolean,
    level?: number,
  ): Promise<void> {
    // /api/v1/dimmer/<DIMMER>/on/?value=<value>
    const setDimmerUrl = `${this.baseUrl}/api/v1/dimmer/${index}/${
      isOn ? 'on' : 'off'
    }/${level ? '?value=' + level : ''}`;
    await this.platform.fetch({
      url: setDimmerUrl,
      method: 'POST',
      token: this.device.token,
    });
  }

  // Set individual dimmer
  private async setWindowCovering(
    id: WindowCoveringId,
    blind?: number,
    lamella?: number,
  ): Promise<void> {
    // {{ip}}/api/v1/shade/0?blind=<value>&lamella=<value>
    const setWindowCoveringUrl = `${this.baseUrl}/api/v1/shade/${id}/`;
    await this.platform.fetch({
      url: setWindowCoveringUrl,
      method: 'POST',
      token: this.device.token,
      body: qs.stringify(
        {
          blind: blind ?? undefined,
          lamella: lamella ?? undefined,
        },
        { encode: false },
      ),
    });
  }

  // TODO: Feedback on API doc
  private async setDeviceLED({
    isOn,
    color,
  }: {
    isOn: boolean;
    color?: string;
  }): Promise<void> {
    const setLEDUrl = `${this.baseUrl}/api/v1/led/set`;
    await this.platform.fetch({
      url: setLEDUrl,
      method: 'POST',
      token: this.device.token,
      body: qs.stringify(
        {
          action: isOn ? 'on' : 'off',
          color: color ?? undefined,
          mode: color ? 'hsv' : undefined,
          ramp: 150,
        },
        { encode: false },
      ),
    });
  }

  private async getDingzDeviceDimmerConfig(): Promise<DeviceDingzDimmerConfig> {
    const getDimmerConfigUrl = `${this.baseUrl}/api/v1/dimmer_config`; // /api/v1/dimmer/<DIMMER>/on/?value=<value>
    return await this.platform.fetch({
      url: getDimmerConfigUrl,
      returnBody: true,
      token: this.device.token,
    });
  }

  private async getDeviceInputConfig(): Promise<DingzInputInfo> {
    const getInputConfigUrl = `${this.baseUrl}/api/v1/input_config`; // /api/v1/dimmer/<DIMMER>/on/?value=<value>

    const release = await this.mutex.acquire();
    try {
      return await this.platform.fetch({
        url: getInputConfigUrl,
        returnBody: true,
        token: this.device.token,
      });
    } finally {
      release();
    }
  }

  private async getDeviceState(): Promise<DingzState> {
    const getDeviceStateUrl = `${this.baseUrl}/api/v1/state`;
    const release = await this.mutex.acquire();
    try {
      return await this.platform.fetch({
        url: getDeviceStateUrl,
        returnBody: true,
        token: this.device.token,
      });
    } finally {
      release();
    }
  }
}