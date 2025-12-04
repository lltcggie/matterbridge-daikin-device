/**
 * Copyright 2025 lltcggie
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from 'node:crypto';

import AsyncLock from 'async-lock';
import {
  airPurifier,
  bridgedNode,
  MatterbridgeEndpoint,
  powerSource,
  humiditySensor,
  temperatureSensor,
  fanDevice,
  waterLeakDetector,
  modeSelect,
  airQualitySensor,
} from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { ActionContext } from 'matterbridge/matter';
import { OnOff, TemperatureMeasurement, RelativeHumidityMeasurement, FanControl, BooleanState, ModeSelect, AirQuality } from 'matterbridge/matter/clusters';

import { DaikinMatterDevice } from './DaikinMatterDevice.js';
import { DaikinPlatform } from './module.js';
import { queryDevice, sendCommand } from './utils/dsiotRequest.js';
import { DsiotQuery } from './utils/dsiotQuery.js';

const DEVICE_STATUS_REFRESH_INTERVAL_MS = 6000;

const COMMAND_QUERY_WITH_MD =
  '{"requests":[{"op":2,"to":"/dsiot/edge.adp_i?filter=pv"},{"op":2,"to":"/dsiot/edge.adp_d?filter=pv"},{"op":2,"to":"/dsiot/edge.adp_f?filter=pv"},{"op":2,"to":"/dsiot/edge.dev_i?filter=pv"},{"op":2,"to":"/dsiot/edge/adr_0100.dgc_status"},{"op":2,"to":"/dsiot/edge/adr_0200.dgc_status"}]}';

// e_1002/e_3007/p_01(手動加湿OFF時)
// e_1002/e_3007/p_03(手動加湿有効時)
enum DaikinModeAP {
  Auto = 0,
  FlowAuto = 2,
  Eco = 3,
  Pollen = 4,
  Throat = 5,
  Circulator = 6,
  FixedFlow = 1, // 固定風量
}

// e_1002/e_3007/p_13
enum DaikinHumidifyLevelAP {
  Off = 0,
  Low = 1,
  Medium = 2,
  High = 3,
  Auto = 100, // これは手動で設定することはできない(モードによって勝手に設定される)ので値は適当
}

// e_1002/e_3007/p_04(手動加湿OFF時)
// e_1002/e_3007/p_06(手動加湿有効時)
enum DaikinFanSpeedAP {
  Silent = 0,
  Speed1 = 1,
  Speed2 = 2,
  Speed3 = 4,
  Auto = 100, // これは手動で設定することはできない(モードによって勝手に設定される)ので値は適当
}

const DaikinModeAPForceAutoHumidifyMap: Record<DaikinModeAP, boolean> = {
  [DaikinModeAP.Auto]: true,
  [DaikinModeAP.FlowAuto]: false,
  [DaikinModeAP.Eco]: false,
  [DaikinModeAP.Pollen]: false,
  [DaikinModeAP.Throat]: true,
  [DaikinModeAP.Circulator]: false,
  [DaikinModeAP.FixedFlow]: false,
};

// e_1002/e_A002/p_01
// 00: 電源オフ(確定)
// 01: 電源オン(確定)

// e_1002/e_3001/p_3F
// 00: 加湿オフ(確度高い)
// 02: 加湿オン(確度高い)

// 加湿モード？
// e_1002/e_3007/p_03
// 0100: 固定加湿(確度高い)
// 0500: 自動加湿(確度高い)
// 加湿なしのときはなし
class DaikinStateAP {
  public macAddress: string = '';
  public deviceName: string = '';
  public deviceType: string = '';
  public deviceReg: string = '';
  public firmwareVersion: string = '';
  public ssid: string = '';

  public power: boolean = false;
  public mode: DaikinModeAP = DaikinModeAP.Auto;
  public fanSpeed: DaikinFanSpeedAP = DaikinFanSpeedAP.Auto;
  public humidifyLevel: DaikinHumidifyLevelAP = DaikinHumidifyLevelAP.Auto;

  public indoorTemperature: number = 0;
  public indoorHumidity: number = 0;
  public pm25SensorLevel: number = 1; // 1～6
  public dustSensorLevel: number = 1; // 1～6
  public smellSensorLevel: number = 1; // 1～6
  public waterTankEmpty: boolean = false; // 加湿機能を使用しない場合はタンクの状態にかかわらず常にfalseとなる
}
abstract class DaikinDeviceAPAttributes {
  public static getCurrentStatus(response: DsiotQuery, _log: AnsiLogger): DaikinStateAP {
    const state = new DaikinStateAP();
    state.macAddress = this.getMacAddress(response);
    state.deviceName = this.getDeviceName(response);
    state.deviceType = this.getDeviceType(response);
    state.deviceReg = this.getDeviceReg(response);
    state.firmwareVersion = this.getFirmwareVersion(response);
    state.ssid = this.getSSID(response);

    state.power = this.getPowerStatus(response);
    state.mode = this.getOperationMode(response);
    state.fanSpeed = this.getFanSpeed(response);
    state.humidifyLevel = this.getHumidifyLevel(response);

    state.indoorTemperature = this.getIndoorTemperature(response);
    state.indoorHumidity = this.getIndoorHumidity(response);
    state.pm25SensorLevel = this.getPm25SensorLevel(response);
    state.dustSensorLevel = this.getDustSensorLevel(response);
    state.smellSensorLevel = this.getSmellSensorLevel(response);
    state.waterTankEmpty = this.getWaterTankEmpty(response);

    return state;
  }

  private static getMacAddress(response: DsiotQuery): string {
    return response.extractValueString('/dsiot/edge.adp_i', 'mac')!;
  }

  private static getSSID(response: DsiotQuery): string {
    return response.extractValueString('/dsiot/edge.adp_i', 'ssid')!;
  }

  private static getDeviceName(response: DsiotQuery): string {
    return response.extractValueString('/dsiot/edge.adp_d', 'name')!;
  }

  private static getDeviceReg(response: DsiotQuery): string {
    return response.extractValueString('/dsiot/edge.adp_i', 'reg')!;
  }

  private static getDeviceType(response: DsiotQuery): string {
    return response.extractValueString('/dsiot/edge.dev_i', 'type')! + response.extractValueString('/dsiot/edge.adp_i', 'enlv')!;
  }

  private static getFirmwareVersion(response: DsiotQuery): string {
    return response.extractValueString('/dsiot/edge.adp_i', 'ver')!;
  }

  private static getPowerStatus(response: DsiotQuery): boolean {
    return response.extractValueString('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_A002/p_01')! === '01';
  }

  private static getIndoorTemperature(response: DsiotQuery): number {
    return response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_A00B/p_01')!;
  }

  private static getIndoorHumidity(response: DsiotQuery): number {
    return response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_A00B/p_02')!;
  }

  private static getWaterTankEmpty(response: DsiotQuery): boolean {
    return response.extractValueString('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3007/p_20')! === '01';
  }

  private static getOperationMode(response: DsiotQuery): DaikinModeAP {
    const isFixedHumidify = this.getIsFixedHumidify(response);
    const path = !isFixedHumidify ? 'e_1002/e_3007/p_01' : 'e_1002/e_3007/p_03';
    return response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', path)! as DaikinModeAP;
  }

  private static getFanSpeed(response: DsiotQuery): DaikinFanSpeedAP {
    const operationMode = this.getOperationMode(response);
    const forceAutoSpeed = operationMode !== DaikinModeAP.FixedFlow;
    if (forceAutoSpeed) {
      return DaikinFanSpeedAP.Auto;
    }

    const isFixedHumidify = this.getIsFixedHumidify(response);
    const path = !isFixedHumidify ? 'e_1002/e_3007/p_04' : 'e_1002/e_3007/p_06';
    return response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', path)! as DaikinFanSpeedAP;
  }

  private static getIsFixedHumidify(response: DsiotQuery): boolean {
    return response.extractValueString('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/p_3F') !== '00';
  }

  public static setPowerStatus(lastResponse: DsiotQuery, power: boolean): any {
    return [
      {
        pn: 'e_1002',
        pch: [{ pn: 'e_A002', pch: [{ pn: 'p_01', pv: power ? '01' : '00' }] }],
      },
    ];
  }

  public static setOperationModeAndHumidify(lastResponse: DsiotQuery, operationMode: DaikinModeAP, humidify: DaikinHumidifyLevelAP): any {
    const isFixedHumidify = humidify !== DaikinHumidifyLevelAP.Off && humidify !== DaikinHumidifyLevelAP.Auto;
    const forceAutoHumidify = DaikinModeAPForceAutoHumidifyMap[operationMode];

    const modePn = !isFixedHumidify && !forceAutoHumidify ? 'p_01' : 'p_03';
    const enabledHumidifyCode = !isFixedHumidify && !forceAutoHumidify ? 0 : 2;
    const pvModeObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3007/${modePn}`, operationMode);
    const pvEnabledHumidifyObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3001/p_3F`, enabledHumidifyCode);

    const command = DsiotQuery.combineObject(pvModeObj, pvEnabledHumidifyObj);
    if (!forceAutoHumidify && isFixedHumidify) {
      const pvHumidifyLevelObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3007/p_13`, humidify);
      DsiotQuery.combineObject(command, pvHumidifyLevelObj);
    }

    return command;
  }

  public static setFanSpeedAndHumidify(lastResponse: DsiotQuery, speedMode: DaikinFanSpeedAP, humidify: DaikinHumidifyLevelAP): any {
    const isFixedHumidify = humidify !== DaikinHumidifyLevelAP.Off && humidify !== DaikinHumidifyLevelAP.Auto;

    const command = this.setOperationModeAndHumidify(lastResponse, DaikinModeAP.FixedFlow, humidify);

    const speedPn = !isFixedHumidify ? 'p_04' : 'p_06';
    const pvObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3007/${speedPn}`, speedMode);
    DsiotQuery.combineObject(command, pvObj);

    return command;
  }

  private static getPm25SensorLevel(response: DsiotQuery): number {
    return response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3007/p_1D')! + 1;
  }

  private static getDustSensorLevel(response: DsiotQuery): number {
    return response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3007/p_1E')! + 1;
  }

  private static getSmellSensorLevel(response: DsiotQuery): number {
    return response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3007/p_1F')! + 1;
  }

  private static getHumidifyLevel(response: DsiotQuery): DaikinHumidifyLevelAP {
    const operationMode = this.getOperationMode(response);
    const forceAutoHumidify = DaikinModeAPForceAutoHumidifyMap[operationMode];
    if (forceAutoHumidify) {
      return DaikinHumidifyLevelAP.Auto;
    }

    const isFixedHumidify = this.getIsFixedHumidify(response);
    if (!isFixedHumidify) {
      return DaikinHumidifyLevelAP.Off;
    }

    const humidifyLevel = response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3007/p_13')! as DaikinHumidifyLevelAP;
    return humidifyLevel;
  }
}

// FanControl.FanModeとDaikinFanSpeedAPのマップ
const FanModeDaikinFanSpeedAPMap: Record<FanControl.FanMode, DaikinFanSpeedAP | undefined> = {
  [FanControl.FanMode.Off]: DaikinFanSpeedAP.Silent,
  [FanControl.FanMode.Low]: DaikinFanSpeedAP.Speed1,
  [FanControl.FanMode.Medium]: DaikinFanSpeedAP.Speed2,
  [FanControl.FanMode.High]: DaikinFanSpeedAP.Speed3,

  [FanControl.FanMode.Auto]: undefined,
  [FanControl.FanMode.On]: undefined,
  [FanControl.FanMode.Smart]: undefined,
};

const DaikinFanSpeedAPFanModeMap: Record<DaikinFanSpeedAP, FanControl.FanMode> = {
  [DaikinFanSpeedAP.Silent]: FanControl.FanMode.Off,
  [DaikinFanSpeedAP.Speed1]: FanControl.FanMode.Low,
  [DaikinFanSpeedAP.Speed2]: FanControl.FanMode.Medium,
  [DaikinFanSpeedAP.Speed3]: FanControl.FanMode.High,
  [DaikinFanSpeedAP.Auto]: FanControl.FanMode.Auto,
};

// FanControl.FanModeとDaikinHumidifyLevelAPのマップ
const FanModeDaikinHumidifyLevelAPMap: Record<FanControl.FanMode, DaikinHumidifyLevelAP | undefined> = {
  [FanControl.FanMode.Off]: DaikinHumidifyLevelAP.Off,
  [FanControl.FanMode.Low]: DaikinHumidifyLevelAP.Low,
  [FanControl.FanMode.Medium]: DaikinHumidifyLevelAP.Medium,
  [FanControl.FanMode.High]: DaikinHumidifyLevelAP.High,

  [FanControl.FanMode.Auto]: undefined,
  [FanControl.FanMode.On]: undefined,
  [FanControl.FanMode.Smart]: undefined,
};

const DaikinHumidifyLevelAPFanModeMap: Record<DaikinHumidifyLevelAP, FanControl.FanMode> = {
  [DaikinHumidifyLevelAP.Off]: FanControl.FanMode.Off,
  [DaikinHumidifyLevelAP.Low]: FanControl.FanMode.Low,
  [DaikinHumidifyLevelAP.Medium]: FanControl.FanMode.Medium,
  [DaikinHumidifyLevelAP.High]: FanControl.FanMode.High,
  [DaikinHumidifyLevelAP.Auto]: FanControl.FanMode.Auto,
};

function getDaikinFanSpeedAPFromPercent(percent: number): DaikinFanSpeedAP {
  if (percent <= 0) {
    return DaikinFanSpeedAP.Silent;
  } else if (percent <= 33) {
    return DaikinFanSpeedAP.Speed1;
  } else if (percent <= 66) {
    return DaikinFanSpeedAP.Speed2;
  } else {
    return DaikinFanSpeedAP.Speed3;
  }
}

function getPercentFromDaikinFanSpeedAP(speed: DaikinFanSpeedAP): number {
  switch (speed) {
    case DaikinFanSpeedAP.Silent:
      return 0;
    case DaikinFanSpeedAP.Speed1:
      return 33;
    case DaikinFanSpeedAP.Speed2:
      return 66;
    case DaikinFanSpeedAP.Speed3:
      return 100;
    default:
      return 0;
  }
}

function getDaikinHumidifyLevelAPFromPercent(percent: number): DaikinHumidifyLevelAP {
  if (percent <= 0) {
    return DaikinHumidifyLevelAP.Off;
  } else if (percent <= 33) {
    return DaikinHumidifyLevelAP.Low;
  } else if (percent <= 66) {
    return DaikinHumidifyLevelAP.Medium;
  } else {
    return DaikinHumidifyLevelAP.High;
  }
}

function getPercentFromDaikinHumidifyLevelAP(level: DaikinHumidifyLevelAP): number {
  switch (level) {
    case DaikinHumidifyLevelAP.Off:
      return 0;
    case DaikinHumidifyLevelAP.Low:
      return 33;
    case DaikinHumidifyLevelAP.Medium:
      return 66;
    case DaikinHumidifyLevelAP.High:
      return 100;
    default:
      return 0;
  }
}

class DaikinAPMatterDeviceACK70Z implements DaikinMatterDevice {
  private ip: string;
  private log: AnsiLogger;
  public RootEndpoint!: MatterbridgeEndpoint;
  public Endpoint!: MatterbridgeEndpoint;
  public EndpointHumidify!: MatterbridgeEndpoint;
  public EndpointTemperatureSensor!: MatterbridgeEndpoint;
  public EndpointDustSensor!: MatterbridgeEndpoint;
  public EndpointPm25Sensor!: MatterbridgeEndpoint;
  public EndpointSmellSensor!: MatterbridgeEndpoint;

  public name: string = '';
  public currentState: DaikinStateAP | undefined = undefined;
  public lastQueryResponse: DsiotQuery | undefined = undefined;

  private refreshInterval: NodeJS.Timeout | undefined;

  private refreshLock = new AsyncLock({ timeout: 1000 * 4 });

  constructor(ip: string, log: AnsiLogger) {
    this.ip = ip;
    this.log = log;
  }

  private async sendCommand(command: object): Promise<void> {
    const param = { requests: [{ op: 3, to: '/dsiot/edge/adr_0100.dgc_status', pc: { pn: 'dgc_status', pch: command } }] };
    await sendCommand(this.ip, this.log, param);
  }

  private async fetchDeviceStatus(): Promise<void> {
    const queryResponse = await queryDevice(this.ip, this.log, COMMAND_QUERY_WITH_MD);
    if (queryResponse === undefined) {
      throw Error(`Daikin - fetchDeviceStatus(): Error: No response from device`);
    }

    const status = DaikinDeviceAPAttributes.getCurrentStatus(queryResponse, this.log);
    if (!status.macAddress) {
      throw Error(`Daikin - fetchDeviceStatus(): Error: ${this.ip} no MAC address found`);
    }

    this.lastQueryResponse = queryResponse;
    this.currentState = status;
  }

  public async connect() {
    await this.fetchDeviceStatus();

    this.name = this.currentState!.deviceName;

    this.log.info(`Connected to Daikin AP '${this.name}' at ${this.ip}`);
  }

  public async createEndpoint(platform: DaikinPlatform) {
    if (!this.currentState) {
      throw new Error('Daikin AP device is connected but current state is undefined');
    }

    const idKey = `daikin-ap-${this.name}`;

    const hash = createHash('sha256').update(idKey).digest('hex');
    const serial = hash.substring(0, 16);

    this.RootEndpoint = new MatterbridgeEndpoint([bridgedNode], { id: idKey }, platform.config.debug as boolean)
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        `AP ${this.name}`,
        serial,
        platform.matterbridge.aggregatorVendorId,
        platform.matterbridge.aggregatorVendorName,
        `Daikin AP`,
        parseInt(platform.version.replace(/\D/g, '')),
        platform.version === '' ? 'Unknown' : platform.version,
        parseInt(platform.matterbridge.matterbridgeVersion.replace(/\D/g, '')),
        platform.matterbridge.matterbridgeVersion,
      );
    this.RootEndpoint.addRequiredClusterServers();

    this.Endpoint = this.RootEndpoint.addChildDeviceType('main', [airPurifier, powerSource, modeSelect], { id: `${idKey}-main` }, platform.config.debug as boolean);
    this.Endpoint.addRequiredClusterServers();
    this.EndpointHumidify = this.RootEndpoint.addChildDeviceType(
      'humidify',
      [fanDevice, waterLeakDetector, humiditySensor],
      { id: `${idKey}-humidify` },
      platform.config.debug as boolean,
    );
    this.EndpointHumidify.addRequiredClusterServers();
    this.EndpointTemperatureSensor = this.RootEndpoint.addChildDeviceType(
      'temperatureSensor',
      [temperatureSensor],
      { id: `${idKey}-temperatureSensor` },
      platform.config.debug as boolean,
    );
    this.EndpointTemperatureSensor.addRequiredClusterServers();
    this.EndpointDustSensor = this.RootEndpoint.addChildDeviceType('dustSensor', [airQualitySensor], { id: `${idKey}-dustSensor` }, platform.config.debug as boolean);
    this.EndpointDustSensor.addRequiredClusterServers();
    this.EndpointPm25Sensor = this.RootEndpoint.addChildDeviceType('pm25Sensor', [airQualitySensor], { id: `${idKey}-pm25Sensor` }, platform.config.debug as boolean);
    this.EndpointPm25Sensor.addRequiredClusterServers();
    this.EndpointSmellSensor = this.RootEndpoint.addChildDeviceType('smellSensor', [airQualitySensor], { id: `${idKey}-smellSensor` }, platform.config.debug as boolean);
    this.EndpointSmellSensor.addRequiredClusterServers();

    const currentFanMode = DaikinFanSpeedAPFanModeMap[this.currentState!.fanSpeed];

    this.Endpoint.createDefaultGroupsClusterServer()
      .createDeadFrontOnOffClusterServer(this.currentState!.power)
      .createDefaultFanControlClusterServer(currentFanMode, FanControl.FanModeSequence.OffLowMedHighAuto)
      .createDefaultModeSelectClusterServer(
        'Course',
        [
          { label: 'Auto', mode: DaikinModeAP.Auto as number, semanticTags: [] },
          { label: 'FlowAuto', mode: DaikinModeAP.FlowAuto as number, semanticTags: [] },
          { label: 'Eco', mode: DaikinModeAP.Eco as number, semanticTags: [] },
          { label: 'Pollen', mode: DaikinModeAP.Pollen as number, semanticTags: [] },
          { label: 'Throat', mode: DaikinModeAP.Throat as number, semanticTags: [] },
          { label: 'Circulator', mode: DaikinModeAP.Circulator as number, semanticTags: [] },
          { label: 'FixedFlow', mode: DaikinModeAP.FixedFlow as number, semanticTags: [] },
        ],
        0,
        0,
      );

    this.EndpointHumidify.createDefaultGroupsClusterServer()
      .createDefaultFanControlClusterServer(currentFanMode, FanControl.FanModeSequence.OffLowMedHighAuto)
      // .createDefaultBooleanStateClusterServer(this.currentState!.waterTankEmpty)
      .createDefaultBooleanStateConfigurationClusterServer()
      .createDefaultRelativeHumidityMeasurementClusterServer(this.currentState!.indoorHumidity * 100);

    this.EndpointTemperatureSensor.createDefaultGroupsClusterServer().createDefaultTemperatureMeasurementClusterServer(this.currentState!.indoorTemperature * 100);

    this.EndpointDustSensor.createDefaultGroupsClusterServer()
      .createDefaultAirQualityClusterServer(this.currentState!.dustSensorLevel as AirQuality.AirQualityEnum)
      .addFixedLabel('sensorType', 'Dust Sensor');

    this.EndpointPm25Sensor.createDefaultGroupsClusterServer()
      .createDefaultAirQualityClusterServer(this.currentState!.pm25SensorLevel as AirQuality.AirQualityEnum)
      .addFixedLabel('sensorType', 'PM2.5 Sensor');

    this.EndpointSmellSensor.createDefaultGroupsClusterServer()
      .createDefaultAirQualityClusterServer(this.currentState!.smellSensorLevel as AirQuality.AirQualityEnum)
      .addFixedLabel('sensorType', 'Smell Sensor');

    this.Endpoint.addCommandHandler('identify', async ({ request: { identifyTime } }) => {
      this.log.info(`Command identify called identifyTime: ${identifyTime}`);
    });

    this.Endpoint.addCommandHandler('on', async () => {
      const command = DaikinDeviceAPAttributes.setPowerStatus(this.lastQueryResponse!, true);
      await this.sendCommand(command);
      await this.refreshDeviceStatus();
    });

    this.Endpoint.addCommandHandler('off', async () => {
      const command = DaikinDeviceAPAttributes.setPowerStatus(this.lastQueryResponse!, false);
      await this.sendCommand(command);
      await this.refreshDeviceStatus();
    });

    this.Endpoint.subscribeAttribute(
      FanControl.Cluster.id,
      'fanMode',
      async (newValue: FanControl.FanMode, oldValue: FanControl.FanMode, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        let command: any;
        if (newValue === FanControl.FanMode.Auto) {
          // 風量自動モードに切り替える
          command = DaikinDeviceAPAttributes.setOperationModeAndHumidify(this.lastQueryResponse!, DaikinModeAP.FlowAuto, this.currentState!.humidifyLevel);
        } else {
          // 固定風量モードに切り替える
          const speedMode = FanModeDaikinFanSpeedAPMap[newValue] ?? DaikinFanSpeedAP.Silent;
          command = DaikinDeviceAPAttributes.setFanSpeedAndHumidify(this.lastQueryResponse!, speedMode, this.currentState!.humidifyLevel);
        }

        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.Endpoint.log,
    );

    this.Endpoint.subscribeAttribute(
      FanControl.Cluster.id,
      'percentSetting',
      async (newValue: number, oldValue: number, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const speedMode = getDaikinFanSpeedAPFromPercent(newValue);
        if (speedMode === undefined) {
          this.Endpoint.log.error(`DaikinMatterDeviceAP: Unsupported fan speed change requested: ${FanControl.FanMode[newValue]}`);
          this.Endpoint.updateAttribute(FanControl.Cluster.id, 'percentSetting', oldValue, this.Endpoint.log);
          return;
        }

        const command = DaikinDeviceAPAttributes.setFanSpeedAndHumidify(this.lastQueryResponse!, speedMode, this.currentState!.humidifyLevel);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.Endpoint.log,
    );

    this.Endpoint.subscribeAttribute(
      ModeSelect.Cluster.id,
      'currentMode',
      async (newValue: number, oldValue: number, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const mode = newValue as DaikinModeAP;
        if (mode === undefined) {
          this.Endpoint.log.error(`DaikinMatterDeviceAC: Unsupported fan speed change requested: ${FanControl.FanMode[newValue]}`);
          this.Endpoint.updateAttribute(ModeSelect.Cluster.id, 'currentMode', oldValue, this.Endpoint.log);
          return;
        }

        const command = DaikinDeviceAPAttributes.setOperationModeAndHumidify(this.lastQueryResponse!, mode, this.currentState!.humidifyLevel);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.Endpoint.log,
    );

    this.EndpointHumidify.subscribeAttribute(
      FanControl.Cluster.id,
      'fanMode',
      async (newValue: FanControl.FanMode, oldValue: FanControl.FanMode, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const forceAutoHumidify = DaikinModeAPForceAutoHumidifyMap[this.currentState!.mode];
        if (forceAutoHumidify) {
          // 自動加湿モードでは変更不可
          this.EndpointHumidify.updateAttribute(FanControl.Cluster.id, 'fanMode', oldValue, this.EndpointHumidify.log);
          return;
        }

        const speedMode = this.currentState!.fanSpeed;
        const humidifyLevel = FanModeDaikinHumidifyLevelAPMap[newValue];

        // 変更不可の加湿レベルが選択されたので取り消す
        if (humidifyLevel === undefined) {
          this.EndpointHumidify.updateAttribute(FanControl.Cluster.id, 'fanMode', oldValue, this.EndpointHumidify.log);
          return;
        }

        const command = DaikinDeviceAPAttributes.setFanSpeedAndHumidify(this.lastQueryResponse!, speedMode, humidifyLevel!);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.EndpointHumidify.log,
    );

    this.EndpointHumidify.subscribeAttribute(
      FanControl.Cluster.id,
      'percentSetting',
      async (newValue: number, oldValue: number, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const forceAutoHumidify = DaikinModeAPForceAutoHumidifyMap[this.currentState!.mode];
        if (forceAutoHumidify) {
          // 自動加湿モードでは変更不可
          this.EndpointHumidify.updateAttribute(FanControl.Cluster.id, 'percentSetting', 0, this.EndpointHumidify.log);
          return;
        }

        const humidifyLevel = getDaikinHumidifyLevelAPFromPercent(newValue);
        const command = DaikinDeviceAPAttributes.setFanSpeedAndHumidify(this.lastQueryResponse!, this.currentState!.fanSpeed, humidifyLevel);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.EndpointHumidify.log,
    );
  }

  public async registerWithPlatform(platform: DaikinPlatform) {
    platform.setSelectDevice(this.RootEndpoint.serialNumber ?? '', this.RootEndpoint.deviceName ?? '', undefined, 'hub');

    if (platform.validateDevice(this.RootEndpoint.deviceName ?? '')) {
      await platform.registerDevice(this.RootEndpoint);
    }

    await this.refreshDeviceStatus();

    if (!this.refreshInterval) {
      this.refreshInterval = setInterval(this.refreshDeviceStatus.bind(this), DEVICE_STATUS_REFRESH_INTERVAL_MS);
    }
  }

  public async destroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  public async restoreState() {
    this.refreshLock.acquire('refresh', async () => {
      const promises = [];

      const currentState = this.currentState!;

      const power = currentState.power;
      promises.push(this.Endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', power, this.Endpoint.log));

      const mode = currentState.mode;
      promises.push(this.Endpoint.updateAttribute(ModeSelect.Cluster.id, 'currentMode', mode, this.Endpoint.log));

      const fanSpeed = currentState.fanSpeed;
      const fanMode = DaikinFanSpeedAPFanModeMap[fanSpeed];
      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'fanMode', fanMode, this.Endpoint.log));

      const percentCurrent = getPercentFromDaikinFanSpeedAP(fanSpeed);
      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'percentSetting', percentCurrent, this.Endpoint.log));

      const humidifyLevel = currentState.humidifyLevel;
      const humidifyFanMode = DaikinHumidifyLevelAPFanModeMap[humidifyLevel];
      promises.push(this.EndpointHumidify.updateAttribute(FanControl.Cluster.id, 'fanMode', humidifyFanMode, this.EndpointHumidify.log));

      const humidifyPercentCurrent = humidifyLevel !== DaikinHumidifyLevelAP.Auto ? getPercentFromDaikinHumidifyLevelAP(humidifyLevel) : 0;
      promises.push(this.EndpointHumidify.updateAttribute(FanControl.Cluster.id, 'percentSetting', humidifyPercentCurrent, this.EndpointHumidify.log));

      const waterTankEmpty = currentState.waterTankEmpty;
      promises.push(this.EndpointHumidify.updateAttribute(BooleanState.Cluster.id, 'stateValue', waterTankEmpty !== undefined ? waterTankEmpty : false, this.EndpointHumidify.log));

      const indoorHumidity = currentState.indoorHumidity;
      promises.push(this.EndpointHumidify.updateAttribute(RelativeHumidityMeasurement.Cluster.id, 'measuredValue', indoorHumidity * 100, this.EndpointHumidify.log));

      const indoorTemperature = currentState.indoorTemperature;
      promises.push(
        this.EndpointTemperatureSensor.updateAttribute(TemperatureMeasurement.Cluster.id, 'measuredValue', indoorTemperature * 100, this.EndpointTemperatureSensor.log),
      );

      const dustSensorLevel = currentState.dustSensorLevel;
      promises.push(this.EndpointDustSensor.updateAttribute(AirQuality.Cluster.id, 'airQuality', dustSensorLevel as AirQuality.AirQualityEnum, this.EndpointDustSensor.log));

      const pm25SensorLevel = currentState.pm25SensorLevel;
      promises.push(this.EndpointPm25Sensor.updateAttribute(AirQuality.Cluster.id, 'airQuality', pm25SensorLevel as AirQuality.AirQualityEnum, this.EndpointPm25Sensor.log));

      const smellSensorLevel = currentState.smellSensorLevel;
      promises.push(this.EndpointSmellSensor.updateAttribute(AirQuality.Cluster.id, 'airQuality', smellSensorLevel as AirQuality.AirQualityEnum, this.EndpointSmellSensor.log));

      await Promise.all(promises);
    });
  }

  private async refreshDeviceStatus() {
    this.log.debug(`Accessory: Refresh status for device '${this.name}'`);

    await this.fetchDeviceStatus();
    await this.restoreState();
  }
}

export { DaikinAPMatterDeviceACK70Z };
