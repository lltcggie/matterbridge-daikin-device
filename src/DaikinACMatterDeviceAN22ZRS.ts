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
import { airConditioner, bridgedNode, MatterbridgeEndpoint, powerSource, humiditySensor, temperatureSensor, modeSelect, fanDevice } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { ActionContext } from 'matterbridge/matter';
import { OnOff, TemperatureMeasurement, RelativeHumidityMeasurement, Thermostat, FanControl, ModeSelect } from 'matterbridge/matter/clusters';

import { DaikinMatterDevice } from './DaikinMatterDevice.js';
import { DaikinPlatform } from './module.js';
import { queryDevice, sendCommand } from './utils/dsiotRequest.js';
import { DsiotQuery } from './utils/dsiotQuery.js';

const DEVICE_STATUS_REFRESH_INTERVAL_MS = 6000;

const COMMAND_QUERY_WITH_MD =
  '{"requests":[{"op":2,"to":"/dsiot/edge.adp_i?filter=pv"},{"op":2,"to":"/dsiot/edge.adp_d?filter=pv"},{"op":2,"to":"/dsiot/edge.adp_f?filter=pv"},{"op":2,"to":"/dsiot/edge.dev_i?filter=pv"},{"op":2,"to":"/dsiot/edge/adr_0100.dgc_status"},{"op":2,"to":"/dsiot/edge/adr_0200.dgc_status"}]}';

enum DaikinOperationSoundAC {
  ControlFromSmartphoneAndStart = 0, // スマートフォンから操作されました。運転を開始します
  ControlFromSmartphoneAndStop = 1, // スマートフォンから操作されました。運転を停止します
  ControlFromSmartphone = 2, // スマートフォンから操作されました
  Silent = 3, // サイレントモード
  RemoconSoundOnly = 4, // リモコン音のみ
}

enum DaikinModeAC {
  Auto = 3, // '0300',
  Dry = 5, // '0500',
  Cool = 2, // '0200',
  Heat = 1, // '0100',
  Humidify = 8, // '0800',
  FanOnly = 0, // '0000',
}

const TargetTemperaturePnMap: Record<DaikinModeAC, string | undefined> = {
  [DaikinModeAC.Heat]: 'p_03',
  [DaikinModeAC.Cool]: 'p_02',
  [DaikinModeAC.Auto]: 'p_1F',
  [DaikinModeAC.Dry]: undefined,
  [DaikinModeAC.Humidify]: undefined,
  [DaikinModeAC.FanOnly]: undefined,
};

const FanSpeedPnMap: Record<DaikinModeAC, string> = {
  [DaikinModeAC.FanOnly]: 'p_28',
  [DaikinModeAC.Dry]: 'p_27',
  [DaikinModeAC.Auto]: 'p_26',
  [DaikinModeAC.Heat]: 'p_0A',
  [DaikinModeAC.Cool]: 'p_09',
  [DaikinModeAC.Humidify]: 'p_27',
};

enum DaikinFanSpeedAC {
  Auto = 10, // '0A00',
  Silent = 11, // '0B00',
  Speed1 = 3, // '0300',
  Speed2 = 4, // '0400',
  Speed3 = 5, // '0500',
  Speed4 = 6, // '0600',
  Speed5 = 7, // '0700',
}

enum DaikinHumidityModeAC {
  Off = 0, // '00',
  TargetHumidity = 1, // '01',
  Low = 4, // '04',
  Medium = 2, // '02',
  High = 3, // '03',
  Continuous = 6, // '06',
}

const HumidityModePnMap: Record<DaikinModeAC, string | undefined> = {
  [DaikinModeAC.Auto]: 'p_2F', // これだけ特殊で00(OFF)～03(高め)の4段階
  [DaikinModeAC.Dry]: 'p_31',
  [DaikinModeAC.Cool]: 'p_0C',
  [DaikinModeAC.Heat]: 'p_2D',
  [DaikinModeAC.Humidify]: 'p_33',
  [DaikinModeAC.FanOnly]: undefined,
};

const HumidityValuePnMap: Record<DaikinModeAC, string | undefined> = {
  [DaikinModeAC.Auto]: undefined,
  [DaikinModeAC.Dry]: 'p_30',
  [DaikinModeAC.Cool]: 'p_0B',
  [DaikinModeAC.Heat]: 'p_2C',
  [DaikinModeAC.Humidify]: 'p_32',
  [DaikinModeAC.FanOnly]: undefined,
};

enum DaikinVentilationSpeedAC {
  Off = 0, // MEMO: Offの場合はコマンド自体が違うので注意
  Auto = 2,
  Max = 1,
}

enum DaikinFanUpDownDirection {
  Auto = 16, // '100000', // モードによっては存在しない
  Swing = 15, // '0F0000',
  Circulation = 20, // '140000',
  Dir1 = 1, // '010000', // 上
  Dir2 = 2, // '020000',
  Dir3 = 3, // '030000',
  Dir4 = 4, // '040000',
  Dir5 = 5, // '050000',
  Dir6 = 6, // '060000', // 下
}

const FanUpDownDirectionAutoEnableMap: Record<DaikinModeAC, boolean> = {
  [DaikinModeAC.Auto]: true,
  [DaikinModeAC.Dry]: true,
  [DaikinModeAC.Cool]: true,
  [DaikinModeAC.Heat]: true,
  [DaikinModeAC.Humidify]: true,
  [DaikinModeAC.FanOnly]: false,
};

const FanUpDownDirectionPnMap: Record<DaikinModeAC, string | undefined> = {
  [DaikinModeAC.Auto]: 'p_20',
  [DaikinModeAC.Dry]: 'p_22',
  [DaikinModeAC.Cool]: 'p_05',
  [DaikinModeAC.Heat]: 'p_07',
  [DaikinModeAC.Humidify]: 'p_29',
  [DaikinModeAC.FanOnly]: 'p_24',
};

// MEMO: 検証してないけど、エアコンの設置位置設定でDir*の値が変わる可能性はありそう
enum DaikinFanLeftRightDirection {
  Auto = 16, // '100000',
  Swing = 15, // '0F0000',
  Dir1 = 10, // '0A0000', // 左
  Dir2 = 11, // '0B0000',
  Dir3 = 12, // '0C0000',
  Dir4 = 13, // '0D0000',
  Dir5 = 14, // '0E0000', // 右
}

const FanLeftRightDirectionPnMap: Record<DaikinModeAC, string | undefined> = {
  [DaikinModeAC.Auto]: 'p_21',
  [DaikinModeAC.Dry]: 'p_23',
  [DaikinModeAC.Cool]: 'p_06',
  [DaikinModeAC.Heat]: 'p_08',
  [DaikinModeAC.Humidify]: 'p_2A',
  [DaikinModeAC.FanOnly]: 'p_25',
};

class DaikinStateAC {
  public macAddress: string = '';
  public deviceName: string = '';
  public deviceType: string = '';
  public deviceReg: string = '';
  public firmwareVersion: string = '';
  public ssid: string = '';
  public targetTemperatureLimitMinMaxMap: Map<DaikinModeAC, number[]> = new Map();
  public targetHumidityLimitMinMaxMap: Map<DaikinModeAC, number[]> = new Map();

  public power: boolean = false;
  public mode: DaikinModeAC = DaikinModeAC.Auto;
  public targetTemperatureMap: Map<DaikinModeAC, number> = new Map();
  public targetHumidityMap: Map<DaikinModeAC, [DaikinHumidityModeAC, number | null]> = new Map();
  public fanSpeed: DaikinFanSpeedAC = DaikinFanSpeedAC.Auto;
  public ventilationSpeed: DaikinVentilationSpeedAC = DaikinVentilationSpeedAC.Off; // メモ: AN22ZRSでは吸気か排気かをアプリでは取得できない
  public fanUpDownDirectionMap: Map<DaikinModeAC, DaikinFanUpDownDirection> = new Map();
  public fanRightLeftDirectionMap: Map<DaikinModeAC, DaikinFanLeftRightDirection> = new Map();
  public motionDetection: boolean = false;
  public indoorTemperature: number = 0;
  public indoorHumidity: number = 0;
  public outdoorTemperature: number = 0;
}

abstract class DaikinDeviceACAttributes {
  public static getCurrentStatus(response: DsiotQuery, _log: AnsiLogger): DaikinStateAC {
    const state = new DaikinStateAC();
    state.macAddress = this.getMacAddress(response);
    state.deviceName = this.getDeviceName(response);
    state.deviceType = this.getDeviceType(response);
    state.deviceReg = this.getDeviceReg(response);
    state.firmwareVersion = this.getFirmwareVersion(response);
    state.ssid = this.getSSID(response);
    state.targetTemperatureLimitMinMaxMap = this.getTargetTemperatureLimitMinMaxMap(response);
    state.targetHumidityLimitMinMaxMap = this.getTargetHumidityLimitMinMaxMap(response);

    state.power = this.getPowerStatus(response);
    state.mode = this.getOperationMode(response);
    state.targetTemperatureMap = this.getTargetTemperatureMap(response);
    Object.entries(DaikinModeAC).forEach(([key, _value]) => {
      const n = Number(key);
      if (isNaN(n)) {
        return;
      }
      const mode = n as DaikinModeAC;
      const targetHumidity = this.getTargetHumidity(response, mode);
      if (targetHumidity === undefined) {
        return;
      }
      state.targetHumidityMap.set(mode, targetHumidity);
    });
    state.fanSpeed = this.getFanSpeed(response);
    state.ventilationSpeed = this.getVentilationSpeed(response);
    state.fanUpDownDirectionMap = this.getFanUpDownDirectionMap(response);
    state.fanRightLeftDirectionMap = this.getFanRightLeftDirectionMap(response);
    state.motionDetection = this.getMotionDetection(response);

    state.indoorTemperature = this.getIndoorTemperature(response);
    state.indoorHumidity = this.getIndoorHumidity(response);
    state.outdoorTemperature = this.getOutdoorTemperature(response);

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

  private static getOutdoorTemperature(response: DsiotQuery): number {
    return response.extractValueInt('/dsiot/edge/adr_0200.dgc_status', 'e_1003/e_A00D/p_01')!;
  }

  private static getOperationMode(response: DsiotQuery): DaikinModeAC {
    const mode = response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/p_01')! as DaikinModeAC;
    return mode;
  }

  private static getTargetTemperatureMap(response: DsiotQuery): Map<DaikinModeAC, number> {
    const map: Map<DaikinModeAC, number> = new Map();
    Object.entries(DaikinModeAC).forEach(([key, _value]) => {
      const n = Number(key);
      if (isNaN(n)) {
        return;
      }
      const mode = n as DaikinModeAC;
      const pn = TargetTemperaturePnMap[mode];
      if (pn === undefined) {
        return;
      }
      const targetTemperature = response.extractValueFloat('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3001/${pn}`)!;
      if (targetTemperature === undefined) {
        return;
      }
      map.set(mode, targetTemperature);
    });
    return map;
  }

  private static getTargetHumidity(response: DsiotQuery, mode: DaikinModeAC): [DaikinHumidityModeAC, number | null] | undefined {
    const humidityModePn = HumidityModePnMap[mode];
    if (humidityModePn === undefined) {
      return undefined;
    }

    const humidityMode = response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/' + humidityModePn) as DaikinHumidityModeAC;
    switch (humidityMode) {
      case DaikinHumidityModeAC.Off:
      case DaikinHumidityModeAC.Low:
      case DaikinHumidityModeAC.Medium:
      case DaikinHumidityModeAC.High:
      case DaikinHumidityModeAC.Continuous:
        return [humidityMode, null];
      case DaikinHumidityModeAC.TargetHumidity: {
        const n = response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/' + HumidityValuePnMap[mode]!);
        return [DaikinHumidityModeAC.TargetHumidity, n!];
      }
      default:
        return undefined;
    }
  }

  private static getTargetTemperatureLimitMinMaxMap(response: DsiotQuery): Map<DaikinModeAC, number[]> {
    const map: Map<DaikinModeAC, number[]> = new Map();
    Object.entries(DaikinModeAC).forEach(([key, _value]) => {
      const n = Number(key);
      if (isNaN(n)) {
        return;
      }
      const mode = n as DaikinModeAC;
      const pn = TargetTemperaturePnMap[mode];
      if (pn === undefined) {
        return;
      }
      const targetTemperature = response.extractMinMax('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/' + pn);
      if (targetTemperature === undefined) {
        return;
      }
      map.set(mode, [targetTemperature![0]!, targetTemperature![1]!]);
    });
    return map;
  }

  private static getTargetHumidityLimitMinMaxMap(response: DsiotQuery): Map<DaikinModeAC, number[]> {
    const map: Map<DaikinModeAC, number[]> = new Map();
    Object.entries(DaikinModeAC).forEach(([key, _value]) => {
      const n = Number(key);
      if (isNaN(n)) {
        return;
      }
      const mode = n as DaikinModeAC;
      const pn = HumidityValuePnMap[mode];
      if (pn === undefined) {
        return;
      }
      const targetHumidity = response.extractMinMax('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/' + pn);
      if (targetHumidity === undefined) {
        return;
      }
      map.set(mode, [targetHumidity![0]!, targetHumidity![1]!]);
    });
    return map;
  }

  private static getFanSpeed(response: DsiotQuery): DaikinFanSpeedAC {
    const mode = this.getOperationMode(response);
    const pn = FanSpeedPnMap[mode];
    const fanSpeed = response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/' + pn)! as DaikinFanSpeedAC;
    return fanSpeed;
  }

  private static getVentilationSpeed(response: DsiotQuery): DaikinVentilationSpeedAC {
    const isVentilationOn = response.extractValueString('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/p_36')! !== '00';
    if (!isVentilationOn) {
      return DaikinVentilationSpeedAC.Off;
    }

    const ventilationSpeedCode = response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/p_1C')! as DaikinVentilationSpeedAC;
    return ventilationSpeedCode;
  }

  private static getFanUpDownDirectionMap(response: DsiotQuery): Map<DaikinModeAC, DaikinFanUpDownDirection> {
    const map: Map<DaikinModeAC, DaikinFanUpDownDirection> = new Map();
    Object.entries(DaikinModeAC).forEach(([key, _value]) => {
      const n = Number(key);
      if (isNaN(n)) {
        return;
      }
      const mode = n as DaikinModeAC;
      const pn = FanUpDownDirectionPnMap[mode];
      if (pn === undefined) {
        return;
      }
      const direction = response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/' + pn);
      if (direction === undefined) {
        return;
      }
      map.set(mode, direction!);
    });
    return map;
  }

  private static getFanRightLeftDirectionMap(response: DsiotQuery): Map<DaikinModeAC, DaikinFanLeftRightDirection> {
    const map: Map<DaikinModeAC, DaikinFanLeftRightDirection> = new Map();
    Object.entries(DaikinModeAC).forEach(([key, _value]) => {
      const n = Number(key);
      if (isNaN(n)) {
        return;
      }
      const mode = n as DaikinModeAC;
      const pn = FanLeftRightDirectionPnMap[mode];
      if (pn === undefined) {
        return;
      }
      const direction = response.extractValueInt('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3001/' + pn);
      if (direction === undefined) {
        return;
      }
      map.set(mode, direction!);
    });
    return map;
  }

  private static getMotionDetection(response: DsiotQuery): boolean {
    return response.extractValueString('/dsiot/edge/adr_0100.dgc_status', 'e_1002/e_3003/p_27')! === '01';
  }

  public static setMotionDetection(lastResponse: DsiotQuery, bEnable: boolean): any {
    return [
      {
        pn: 'e_1002',
        pch: [{ pn: 'e_3003', pch: [{ pn: 'p_27', pv: bEnable ? '01' : '00' }] }],
      },
    ];
  }

  public static setPowerStatus(lastResponse: DsiotQuery, power: boolean, operationSound: DaikinOperationSoundAC = DaikinOperationSoundAC.RemoconSoundOnly): any {
    const pvOperationSoundObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3003/p_2D`, operationSound);
    return DsiotQuery.combineObject(
      [
        {
          pn: 'e_1002',
          pch: [{ pn: 'e_A002', pch: [{ pn: 'p_01', pv: power ? '01' : '00' }] }],
        },
      ],
      pvOperationSoundObj,
    );
  }

  public static setOperationMode(lastResponse: DsiotQuery, operationMode: DaikinModeAC, operationSound: DaikinOperationSoundAC = DaikinOperationSoundAC.RemoconSoundOnly): any {
    const pvOperationSoundObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3003/p_2D`, operationSound);
    const pvObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3001/p_01`, operationMode);
    return DsiotQuery.combineObject(pvOperationSoundObj, pvObj);
  }

  public static setTargetTemperature(
    lastResponse: DsiotQuery,
    operationMode: DaikinModeAC,
    temperature: number,
    operationSound: DaikinOperationSoundAC = DaikinOperationSoundAC.RemoconSoundOnly,
  ): any {
    const pn = TargetTemperaturePnMap[operationMode];
    if (!pn) {
      return undefined;
    }

    const pvOperationSoundObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3003/p_2D`, operationSound);
    const pvObj = lastResponse.encodePvFloat('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3001/${pn}`, temperature);
    return DsiotQuery.combineObject(pvOperationSoundObj, pvObj);
  }

  public static setTargetHumidity(
    lastResponse: DsiotQuery,
    mode: DaikinModeAC,
    humiditySetting: [DaikinHumidityModeAC, number | undefined],
    operationSound: DaikinOperationSoundAC = DaikinOperationSoundAC.RemoconSoundOnly,
  ): any {
    const humidityModePn = HumidityModePnMap[mode];
    if (humidityModePn === undefined) {
      return undefined;
    }

    const pvOperationSoundObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3003/p_2D`, operationSound);
    const pvObj = lastResponse.encodePvFloat('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3001/${humidityModePn}`, humiditySetting[0]);
    const command = DsiotQuery.combineObject(pvOperationSoundObj, pvObj);

    const humidityValuePn = HumidityValuePnMap[mode];
    if (humidityValuePn !== undefined && humiditySetting[1] !== undefined) {
      const path = `e_1002/e_3001/${humidityValuePn}`;
      const pvObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', path, humiditySetting[1]!);
      DsiotQuery.combineObject(command, pvObj);
    }

    return command;
  }

  public static setFanSpeed(
    lastResponse: DsiotQuery,
    operationMode: DaikinModeAC,
    speedMode: DaikinFanSpeedAC,
    operationSound: DaikinOperationSoundAC = DaikinOperationSoundAC.RemoconSoundOnly,
  ): any {
    const pvOperationSoundObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3003/p_2D`, operationSound);
    const pn = FanSpeedPnMap[operationMode];
    const pvObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3001/${pn}`, speedMode);
    return DsiotQuery.combineObject(pvOperationSoundObj, pvObj);
  }

  public static setVentilationSpeed(
    lastResponse: DsiotQuery,
    speed: DaikinVentilationSpeedAC,
    operationSound: DaikinOperationSoundAC = DaikinOperationSoundAC.RemoconSoundOnly,
  ): any {
    const pvOperationSoundObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3003/p_2D`, operationSound);
    const command = DsiotQuery.combineObject(
      [
        {
          pn: 'e_1002',
          pch: [{ pn: 'e_3001', pch: [{ pn: 'p_36', pv: speed === DaikinVentilationSpeedAC.Off ? '00' : '01' }] }],
        },
      ],
      pvOperationSoundObj,
    );

    if (speed !== DaikinVentilationSpeedAC.Off) {
      const pvObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3001/p_1C`, speed);
      DsiotQuery.combineObject(command, pvObj);
    }

    return command;
  }

  public static setFanUpDownDirection(
    lastResponse: DsiotQuery,
    mode: DaikinModeAC,
    direction: DaikinFanUpDownDirection,
    operationSound: DaikinOperationSoundAC = DaikinOperationSoundAC.RemoconSoundOnly,
  ): any {
    if (direction === DaikinFanUpDownDirection.Auto && !FanUpDownDirectionAutoEnableMap[mode]) {
      // Autoが無効なモードの場合はSwingにする
      direction = DaikinFanUpDownDirection.Swing;
    }

    const pvOperationSoundObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3003/p_2D`, operationSound);
    const pn = FanUpDownDirectionPnMap[mode];
    const pvObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3001/${pn}`, direction);
    return DsiotQuery.combineObject(pvOperationSoundObj, pvObj);
  }

  public static setFanRightLeftDirection(
    lastResponse: DsiotQuery,
    mode: DaikinModeAC,
    direction: DaikinFanLeftRightDirection,
    operationSound: DaikinOperationSoundAC = DaikinOperationSoundAC.RemoconSoundOnly,
  ): any {
    const pvOperationSoundObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3003/p_2D`, operationSound);
    const pn = FanLeftRightDirectionPnMap[mode];
    const pvObj = lastResponse.encodePvInt('/dsiot/edge/adr_0100.dgc_status', `e_1002/e_3001/${pn}`, direction);
    return DsiotQuery.combineObject(pvOperationSoundObj, pvObj);
  }
}

// FanControl.FanModeとDaikinFanSpeedACのマップ
const FanModeDaikinFanSpeedACMap: Record<FanControl.FanMode, DaikinFanSpeedAC | undefined> = {
  [FanControl.FanMode.Auto]: DaikinFanSpeedAC.Auto,
  [FanControl.FanMode.Low]: DaikinFanSpeedAC.Silent,
  [FanControl.FanMode.Medium]: DaikinFanSpeedAC.Speed3,
  [FanControl.FanMode.High]: DaikinFanSpeedAC.Speed5,

  [FanControl.FanMode.Off]: undefined,
  [FanControl.FanMode.On]: undefined,
  [FanControl.FanMode.Smart]: undefined,
};

const DaikinFanSpeedACFanModeMap: Record<DaikinFanSpeedAC, FanControl.FanMode> = {
  [DaikinFanSpeedAC.Auto]: FanControl.FanMode.Auto,
  [DaikinFanSpeedAC.Silent]: FanControl.FanMode.Low,
  [DaikinFanSpeedAC.Speed1]: FanControl.FanMode.Low,
  [DaikinFanSpeedAC.Speed2]: FanControl.FanMode.Medium,
  [DaikinFanSpeedAC.Speed3]: FanControl.FanMode.Medium,
  [DaikinFanSpeedAC.Speed4]: FanControl.FanMode.Medium,
  [DaikinFanSpeedAC.Speed5]: FanControl.FanMode.High,
};

// DaikinFanSpeedACとSpeedSettingのマップ
const DaikinFanSpeedACSpeedSettingMap: Record<DaikinFanSpeedAC, number | undefined> = {
  [DaikinFanSpeedAC.Auto]: undefined,
  [DaikinFanSpeedAC.Silent]: 1,
  [DaikinFanSpeedAC.Speed1]: 2,
  [DaikinFanSpeedAC.Speed2]: 3,
  [DaikinFanSpeedAC.Speed3]: 4,
  [DaikinFanSpeedAC.Speed4]: 5,
  [DaikinFanSpeedAC.Speed5]: 6,
};

const SpeedSettingDaikinFanSpeedACRevMap: Record<number, DaikinFanSpeedAC> = Object.fromEntries(
  Object.entries(DaikinFanSpeedACSpeedSettingMap).map(([k, v]) => [Number(v), Number(k)]),
);

function getDaikinFanSpeedACFromPercent(percent: number): DaikinFanSpeedAC {
  if (percent <= 0) {
    return DaikinFanSpeedAC.Auto;
  } else if (percent <= 10) {
    return DaikinFanSpeedAC.Silent;
  } else if (percent <= 20) {
    return DaikinFanSpeedAC.Speed1;
  } else if (percent <= 30) {
    return DaikinFanSpeedAC.Speed2;
  } else if (percent <= 40) {
    return DaikinFanSpeedAC.Speed3;
  } else if (percent <= 50) {
    return DaikinFanSpeedAC.Speed4;
  } else {
    return DaikinFanSpeedAC.Speed5;
  }
}

function getPercentFromDaikinFanSpeedAC(speed: DaikinFanSpeedAC): number {
  switch (speed) {
    case DaikinFanSpeedAC.Auto:
      return 0;
    case DaikinFanSpeedAC.Silent:
      return 10;
    case DaikinFanSpeedAC.Speed1:
      return 20;
    case DaikinFanSpeedAC.Speed2:
      return 30;
    case DaikinFanSpeedAC.Speed3:
      return 40;
    case DaikinFanSpeedAC.Speed4:
      return 50;
    case DaikinFanSpeedAC.Speed5:
      return 100;
    default:
      return 0;
  }
}

// FanControl.FanModeとDaikinVentilationSpeedACのマップ
const FanModeDaikinVentilationSpeedACMap: Record<FanControl.FanMode, DaikinVentilationSpeedAC | undefined> = {
  [FanControl.FanMode.Auto]: DaikinVentilationSpeedAC.Auto,
  [FanControl.FanMode.Low]: DaikinVentilationSpeedAC.Auto,
  [FanControl.FanMode.Medium]: DaikinVentilationSpeedAC.Auto,
  [FanControl.FanMode.High]: DaikinVentilationSpeedAC.Max,

  [FanControl.FanMode.Off]: DaikinVentilationSpeedAC.Off,
  [FanControl.FanMode.On]: undefined,
  [FanControl.FanMode.Smart]: undefined,
};

const DaikinVentilationSpeedACFanModeMap: Record<DaikinVentilationSpeedAC, FanControl.FanMode> = {
  [DaikinVentilationSpeedAC.Off]: FanControl.FanMode.Off,
  [DaikinVentilationSpeedAC.Auto]: FanControl.FanMode.Auto,
  [DaikinVentilationSpeedAC.Max]: FanControl.FanMode.High,
};

class DaikinACMatterDeviceAN22ZRS implements DaikinMatterDevice {
  private ip: string;
  private log: AnsiLogger;
  public RootEndpoint!: MatterbridgeEndpoint;
  public Endpoint!: MatterbridgeEndpoint;
  public EndpointHumiditySensor!: MatterbridgeEndpoint;
  public EndpointModeChange!: MatterbridgeEndpoint;
  public EndpointHumidity!: MatterbridgeEndpoint;
  public EndpointVentilation!: MatterbridgeEndpoint;
  public EndpointFanUpDownDirection!: MatterbridgeEndpoint;
  public EndpointFanRightLeftDirection!: MatterbridgeEndpoint;
  // エアコンがoutdoorTemperatureを持ってるので本来は不要だけどoutdoorTemperatureを読まないコントローラーが多すぎるので追加しておく
  public EndpointOutsideTemperatureSensor!: MatterbridgeEndpoint;

  public name: string = '';
  public currentState: DaikinStateAC | undefined = undefined;
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

    const status = DaikinDeviceACAttributes.getCurrentStatus(queryResponse, this.log);
    if (!status.macAddress) {
      throw Error(`Daikin - fetchDeviceStatus(): Error: ${this.ip} no MAC address found`);
    }

    this.lastQueryResponse = queryResponse;
    this.currentState = status;
  }

  public async connect() {
    await this.fetchDeviceStatus();

    this.name = this.currentState!.deviceName;

    this.log.info(`Connected to Daikin AC '${this.name}' at ${this.ip}`);
  }

  public async createEndpoint(platform: DaikinPlatform) {
    if (!this.currentState) {
      throw new Error('Daikin AC device is connected but current state is undefined');
    }

    const idKey = `daikin-ac-${this.name}`;

    const hash = createHash('sha256').update(idKey).digest('hex');
    const serial = hash.substring(0, 16);

    this.RootEndpoint = new MatterbridgeEndpoint([bridgedNode], { id: idKey }, platform.config.debug as boolean)
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        `AC ${this.name}`,
        serial,
        platform.matterbridge.aggregatorVendorId,
        platform.matterbridge.aggregatorVendorName,
        `Daikin AC`,
        parseInt(platform.version.replace(/\D/g, '')),
        platform.version === '' ? 'Unknown' : platform.version,
        parseInt(platform.matterbridge.matterbridgeVersion.replace(/\D/g, '')),
        platform.matterbridge.matterbridgeVersion,
      );
    this.RootEndpoint.addRequiredClusterServers();

    this.Endpoint = this.RootEndpoint.addChildDeviceType('main', [airConditioner, powerSource, modeSelect], { id: `${idKey}-main` }, platform.config.debug as boolean);
    this.Endpoint.addRequiredClusterServers();
    this.EndpointHumiditySensor = this.RootEndpoint.addChildDeviceType('humiditySensor', [humiditySensor], { id: `${idKey}-humiditySensor` }, platform.config.debug as boolean);
    this.EndpointHumiditySensor.addRequiredClusterServers();
    this.EndpointModeChange = this.RootEndpoint.addChildDeviceType('modeChange', [modeSelect], { id: `${idKey}-modeChange` }, platform.config.debug as boolean);
    this.EndpointModeChange.addRequiredClusterServers();
    this.EndpointHumidity = this.RootEndpoint.addChildDeviceType('humidity', [fanDevice], { id: `${idKey}-humidity` }, platform.config.debug as boolean);
    this.EndpointHumidity.addRequiredClusterServers();
    this.EndpointVentilation = this.RootEndpoint.addChildDeviceType('ventilation', [fanDevice], { id: `${idKey}-ventilation` }, platform.config.debug as boolean);
    this.EndpointVentilation.addRequiredClusterServers();
    this.EndpointFanUpDownDirection = this.RootEndpoint.addChildDeviceType(
      'fanUpDownDirection',
      [modeSelect],
      { id: `${idKey}-fanUpDownDirection` },
      platform.config.debug as boolean,
    );
    this.EndpointFanUpDownDirection.addRequiredClusterServers();
    this.EndpointFanRightLeftDirection = this.RootEndpoint.addChildDeviceType(
      'fanRightLeftDirection',
      [modeSelect],
      { id: `${idKey}-fanRightLeftDirection` },
      platform.config.debug as boolean,
    );
    this.EndpointFanRightLeftDirection.addRequiredClusterServers();
    this.EndpointOutsideTemperatureSensor = this.RootEndpoint.addChildDeviceType(
      'outsideTemperatureSensor',
      [temperatureSensor],
      { id: `${idKey}-outsideTemperatureSensor` },
      platform.config.debug as boolean,
    );
    this.EndpointOutsideTemperatureSensor.addRequiredClusterServers();

    const currentFanMode = DaikinFanSpeedACFanModeMap[this.currentState.fanSpeed];
    const currentFanSpeedSetting = DaikinFanSpeedACSpeedSettingMap[this.currentState.fanSpeed];
    const currentFanSpeedPercent = getPercentFromDaikinFanSpeedAC(this.currentState.fanSpeed);
    const currentVentilationFanSpeed = DaikinVentilationSpeedACFanModeMap[this.currentState.ventilationSpeed!];

    this.Endpoint.createDefaultGroupsClusterServer()
      .createDefaultThermostatClusterServer(
        this.currentState.indoorTemperature,
        this.currentState.targetTemperatureMap.get(DaikinModeAC.Heat)!,
        this.currentState.targetTemperatureMap.get(DaikinModeAC.Cool)!,
        0.5,
        this.currentState.targetHumidityLimitMinMaxMap.get(DaikinModeAC.Heat)![0],
        this.currentState.targetHumidityLimitMinMaxMap.get(DaikinModeAC.Heat)![1],
        this.currentState.targetHumidityLimitMinMaxMap.get(DaikinModeAC.Cool)![0],
        this.currentState.targetHumidityLimitMinMaxMap.get(DaikinModeAC.Cool)![1],
        undefined,
        undefined,
        undefined,
        this.currentState.outdoorTemperature,
      )
      .createDefaultThermostatUserInterfaceConfigurationClusterServer()
      .createMultiSpeedFanControlClusterServer(
        currentFanMode,
        FanControl.FanModeSequence.OffLowMedHighAuto,
        currentFanSpeedPercent,
        currentFanSpeedPercent,
        6,
        currentFanSpeedSetting,
        currentFanSpeedSetting,
      )
      .createDefaultModeSelectClusterServer(
        'fanSpeed',
        [
          { label: 'Auto', mode: DaikinFanSpeedAC.Auto as number, semanticTags: [] },
          { label: 'Silent', mode: DaikinFanSpeedAC.Silent as number, semanticTags: [] },
          { label: 'Speed1', mode: DaikinFanSpeedAC.Speed1 as number, semanticTags: [] },
          { label: 'Speed2', mode: DaikinFanSpeedAC.Speed2 as number, semanticTags: [] },
          { label: 'Speed3', mode: DaikinFanSpeedAC.Speed3 as number, semanticTags: [] },
          { label: 'Speed4', mode: DaikinFanSpeedAC.Speed4 as number, semanticTags: [] },
          { label: 'Speed5', mode: DaikinFanSpeedAC.Speed5 as number, semanticTags: [] },
        ],
        this.currentState.fanSpeed,
        this.currentState.fanSpeed,
      );

    this.EndpointHumiditySensor.createDefaultGroupsClusterServer().createDefaultRelativeHumidityMeasurementClusterServer(this.currentState.indoorHumidity * 100);

    this.EndpointModeChange.createDefaultGroupsClusterServer().createDefaultModeSelectClusterServer(
      'mode',
      [
        { label: 'Auto', mode: DaikinModeAC.Auto as number, semanticTags: [] },
        { label: 'Dry', mode: DaikinModeAC.Dry as number, semanticTags: [] },
        { label: 'Cool', mode: DaikinModeAC.Cool as number, semanticTags: [] },
        { label: 'Heat', mode: DaikinModeAC.Heat as number, semanticTags: [] },
        { label: 'Humidify', mode: DaikinModeAC.Humidify as number, semanticTags: [] },
        { label: 'FanOnly', mode: DaikinModeAC.FanOnly as number, semanticTags: [] },
      ],
      this.currentState.mode,
      this.currentState.mode,
    );

    const humidityFanMode = DaikinACMatterDeviceAN22ZRS.getFanModeFromTargetHumidity(this.currentState?.mode, this.currentState?.targetHumidityMap);
    this.EndpointHumidity.createDefaultGroupsClusterServer()
      .createDefaultFanControlClusterServer(humidityFanMode, FanControl.FanModeSequence.OffLowMedHighAuto, undefined, undefined)
      .addFixedLabel('deviceName', 'Humidity Control');

    this.EndpointVentilation.createDefaultGroupsClusterServer()
      .createDefaultFanControlClusterServer(currentVentilationFanSpeed, FanControl.FanModeSequence.OffHighAuto, undefined, undefined)
      .addFixedLabel('deviceName', 'Ventilation Fan');

    this.EndpointFanUpDownDirection.createDefaultGroupsClusterServer().createDefaultModeSelectClusterServer(
      'fanUpDownDirection',
      [
        { label: 'Auto', mode: DaikinFanUpDownDirection.Auto as number, semanticTags: [] },
        { label: 'Swing', mode: DaikinFanUpDownDirection.Swing as number, semanticTags: [] },
        { label: 'Circulation', mode: DaikinFanUpDownDirection.Circulation as number, semanticTags: [] },
        { label: 'Dir1', mode: DaikinFanUpDownDirection.Dir1 as number, semanticTags: [] },
        { label: 'Dir2', mode: DaikinFanUpDownDirection.Dir2 as number, semanticTags: [] },
        { label: 'Dir3', mode: DaikinFanUpDownDirection.Dir3 as number, semanticTags: [] },
        { label: 'Dir4', mode: DaikinFanUpDownDirection.Dir4 as number, semanticTags: [] },
        { label: 'Dir5', mode: DaikinFanUpDownDirection.Dir5 as number, semanticTags: [] },
      ],
      this.currentState?.fanUpDownDirectionMap.get(this.currentState?.mode) as number,
      this.currentState?.fanUpDownDirectionMap.get(this.currentState?.mode) as number,
    );

    this.EndpointFanRightLeftDirection.createDefaultGroupsClusterServer().createDefaultModeSelectClusterServer(
      'fanRightLeftDirection',
      [
        { label: 'Auto', mode: DaikinFanLeftRightDirection.Auto as number, semanticTags: [] },
        { label: 'Swing', mode: DaikinFanLeftRightDirection.Swing as number, semanticTags: [] },
        { label: 'Dir1', mode: DaikinFanLeftRightDirection.Dir1 as number, semanticTags: [] },
        { label: 'Dir2', mode: DaikinFanLeftRightDirection.Dir2 as number, semanticTags: [] },
        { label: 'Dir3', mode: DaikinFanLeftRightDirection.Dir3 as number, semanticTags: [] },
        { label: 'Dir4', mode: DaikinFanLeftRightDirection.Dir4 as number, semanticTags: [] },
        { label: 'Dir5', mode: DaikinFanLeftRightDirection.Dir5 as number, semanticTags: [] },
      ],
      this.currentState?.fanRightLeftDirectionMap.get(this.currentState?.mode) as number,
      this.currentState?.fanRightLeftDirectionMap.get(this.currentState?.mode) as number,
    );

    this.EndpointOutsideTemperatureSensor.createDefaultGroupsClusterServer().createDefaultTemperatureMeasurementClusterServer(this.currentState.outdoorTemperature * 100);

    this.RootEndpoint.addCommandHandler('identify', async ({ request: { identifyTime } }) => {
      this.log.info(`Command identify called identifyTime: ${identifyTime}`);
    });

    this.Endpoint.subscribeAttribute(
      FanControl.Cluster.id,
      'fanMode',
      async (newValue: FanControl.FanMode, oldValue: FanControl.FanMode, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const speedMode = FanModeDaikinFanSpeedACMap[newValue] ?? DaikinFanSpeedAC.Auto;

        const command = DaikinDeviceACAttributes.setFanSpeed(this.lastQueryResponse!, this.currentState!.mode!, speedMode);
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

        const speedMode = getDaikinFanSpeedACFromPercent(newValue);
        if (speedMode === undefined) {
          this.log.info(`DaikinMatterDeviceAC: Unsupported fan speed change requested: ${FanControl.FanMode[newValue]}`);
          this.Endpoint.updateAttribute(FanControl.Cluster.id, 'percentSetting', oldValue, this.Endpoint.log);
          return;
        }

        const command = DaikinDeviceACAttributes.setFanSpeed(this.lastQueryResponse!, this.currentState!.mode!, speedMode);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.Endpoint.log,
    );

    this.Endpoint.subscribeAttribute(
      FanControl.Cluster.id,
      'speedSetting',
      async (newValue: number, oldValue: number, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const speedMode = SpeedSettingDaikinFanSpeedACRevMap[newValue];
        if (speedMode === undefined) {
          this.log.info(`DaikinMatterDeviceAC: Unsupported fan speed change requested: ${FanControl.FanMode[newValue]}`);
          this.Endpoint.updateAttribute(FanControl.Cluster.id, 'speedSetting', oldValue, this.Endpoint.log);
          return;
        }

        const command = DaikinDeviceACAttributes.setFanSpeed(this.lastQueryResponse!, this.currentState!.mode!, speedMode);
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

        const speedMode = newValue as DaikinFanSpeedAC;
        if (speedMode === undefined) {
          this.log.info(`DaikinMatterDeviceAC: Unsupported fan speed change requested: ${FanControl.FanMode[newValue]}`);
          this.Endpoint.updateAttribute(ModeSelect.Cluster.id, 'currentMode', oldValue, this.Endpoint.log);
          return;
        }

        const command = DaikinDeviceACAttributes.setFanSpeed(this.lastQueryResponse!, this.currentState!.mode!, speedMode);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.Endpoint.log,
    );

    this.Endpoint.addCommandHandler('on', async () => {
      const command = DaikinDeviceACAttributes.setPowerStatus(this.lastQueryResponse!, true);
      await this.sendCommand(command);
      await this.refreshDeviceStatus();
    });

    this.Endpoint.addCommandHandler('off', async () => {
      const command = DaikinDeviceACAttributes.setPowerStatus(this.lastQueryResponse!, false);
      await this.sendCommand(command);
      await this.refreshDeviceStatus();
    });

    this.Endpoint.subscribeAttribute(
      Thermostat.Cluster.id,
      'occupiedCoolingSetpoint',
      async (newValue: number, oldValue: number, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const command = DaikinDeviceACAttributes.setTargetTemperature(this.lastQueryResponse!, DaikinModeAC.Cool, newValue / 100);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.Endpoint.log,
    );

    this.Endpoint.subscribeAttribute(
      Thermostat.Cluster.id,
      'occupiedHeatingSetpoint',
      async (newValue: number, oldValue: number, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const command = DaikinDeviceACAttributes.setTargetTemperature(this.lastQueryResponse!, DaikinModeAC.Heat, newValue / 100);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.Endpoint.log,
    );

    this.Endpoint.subscribeAttribute(
      Thermostat.Cluster.id,
      'systemMode',
      async (newValue: Thermostat.SystemMode, oldValue: Thermostat.SystemMode, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        await this.fetchDeviceStatus();

        // ダイキンのエアコンにOffモードは存在しないので、MatterのOffモードが設定された場合は電源オフコマンドを送信する
        if (this.currentState?.power && newValue === Thermostat.SystemMode.Off) {
          const command = DaikinDeviceACAttributes.setPowerStatus(this.lastQueryResponse!, false);
          await this.sendCommand(command);
          await this.refreshDeviceStatus();
          return;
        }

        const mode = this.mapMatterModeToDaikin(newValue);
        if (mode === undefined) {
          this.log.error(`DaikinMatterDeviceAC: Unsupported mode change requested: ${Thermostat.SystemMode[newValue]}`);
          this.Endpoint.updateAttribute(Thermostat.Cluster.id, 'systemMode', oldValue, this.Endpoint.log);
          return;
        }

        // 電源がオフの場合は、まず電源オンコマンドを送信する
        if (this.currentState?.power === false) {
          const powerCommand = DaikinDeviceACAttributes.setPowerStatus(this.lastQueryResponse!, true);
          await this.sendCommand(powerCommand);
        }

        const command = DaikinDeviceACAttributes.setOperationMode(this.lastQueryResponse!, mode);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.Endpoint.log,
    );

    this.EndpointModeChange.subscribeAttribute(
      ModeSelect.Cluster.id,
      'currentMode',
      async (newValue: number, oldValue: number, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const mode = newValue as DaikinModeAC;
        if (mode === undefined) {
          this.log.info(`DaikinMatterDeviceAC: Unsupported fan speed change requested: ${newValue}`);
          this.EndpointModeChange.updateAttribute(ModeSelect.Cluster.id, 'currentMode', oldValue, this.EndpointModeChange.log);
          return;
        }

        const command = DaikinDeviceACAttributes.setOperationMode(this.lastQueryResponse!, mode);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.EndpointModeChange.log,
    );

    this.EndpointVentilation.subscribeAttribute(
      FanControl.Cluster.id,
      'fanMode',
      async (newValue: FanControl.FanMode, oldValue: FanControl.FanMode, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const speedMode = FanModeDaikinVentilationSpeedACMap[newValue] ?? DaikinVentilationSpeedAC.Auto;

        const command = DaikinDeviceACAttributes.setVentilationSpeed(this.lastQueryResponse!, speedMode);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.EndpointVentilation.log,
    );

    this.EndpointHumidity.subscribeAttribute(
      FanControl.Cluster.id,
      'fanMode',
      async (newValue: FanControl.FanMode, oldValue: FanControl.FanMode, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        await this.fetchDeviceStatus();

        const humiditySetting = DaikinACMatterDeviceAN22ZRS.getTargetHumidityFromFanMode(this.currentState!.mode, newValue);
        if (humiditySetting === undefined) {
          this.log.info(`DaikinMatterDeviceAC: Unsupported humidity fan mode change requested: ${newValue}`);
          this.EndpointHumidity.updateAttribute(FanControl.Cluster.id, 'fanMode', oldValue, this.EndpointHumidity.log);
          return;
        }

        const command = DaikinDeviceACAttributes.setTargetHumidity(this.lastQueryResponse!, this.currentState!.mode, humiditySetting);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.Endpoint.log,
    );

    this.EndpointFanUpDownDirection.subscribeAttribute(
      ModeSelect.Cluster.id,
      'currentMode',
      async (newValue: number, oldValue: number, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const mode = newValue as DaikinFanUpDownDirection;
        if (mode === undefined) {
          this.log.info(`DaikinMatterDeviceAC: Unsupported fan speed change requested: ${newValue}`);
          this.EndpointFanUpDownDirection.updateAttribute(ModeSelect.Cluster.id, 'currentMode', oldValue, this.EndpointFanUpDownDirection.log);
          return;
        }

        const command = DaikinDeviceACAttributes.setFanUpDownDirection(this.lastQueryResponse!, this.currentState!.mode, mode);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.EndpointFanUpDownDirection.log,
    );

    this.EndpointFanRightLeftDirection.subscribeAttribute(
      ModeSelect.Cluster.id,
      'currentMode',
      async (newValue: number, oldValue: number, context: ActionContext) => {
        // 属性同期のための Endpoint.updateAttribute() を無視するためにオフラインの変更は無視する(リモートからしか動かす予定はないので副作用は無し)
        if (context.offline === true) {
          return;
        }

        const mode = newValue as DaikinFanLeftRightDirection;
        if (mode === undefined) {
          this.log.info(`DaikinMatterDeviceAC: Unsupported fan speed change requested: ${newValue}`);
          this.EndpointFanRightLeftDirection.updateAttribute(ModeSelect.Cluster.id, 'currentMode', oldValue, this.EndpointFanRightLeftDirection.log);
          return;
        }

        const command = DaikinDeviceACAttributes.setFanRightLeftDirection(this.lastQueryResponse!, this.currentState!.mode, mode);
        await this.sendCommand(command);
        await this.refreshDeviceStatus();
      },
      this.EndpointFanRightLeftDirection.log,
    );
  }

  public async registerWithPlatform(platform: DaikinPlatform) {
    platform.setSelectDevice(this.RootEndpoint.serialNumber ?? '', this.RootEndpoint.deviceName ?? '', undefined, 'hub');

    if (platform.validateDevice(this.RootEndpoint.deviceName ?? '')) {
      await platform.registerDevice(this.RootEndpoint);
    }

    this.currentState = undefined; // 強制更新
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
    await this.refreshLock.acquire('refresh', async () => {
      const promises = [];

      const currentState = this.currentState!;

      const power = currentState.power;
      promises.push(this.Endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', power ?? false, this.Endpoint.log));

      const coolingTargetTemperature = currentState.targetTemperatureMap.get(DaikinModeAC.Cool)!;
      promises.push(this.Endpoint.updateAttribute(Thermostat.Cluster.id, 'occupiedCoolingSetpoint', coolingTargetTemperature * 100, this.Endpoint.log));

      const heatingTargetTemperature = currentState.targetTemperatureMap.get(DaikinModeAC.Heat)!;
      promises.push(this.Endpoint.updateAttribute(Thermostat.Cluster.id, 'occupiedHeatingSetpoint', heatingTargetTemperature * 100, this.Endpoint.log));

      const indoorTemperature = currentState.indoorTemperature;
      promises.push(this.Endpoint.updateAttribute(Thermostat.Cluster.id, 'localTemperature', indoorTemperature * 100, this.Endpoint.log));

      const indoorHumidity = currentState.indoorHumidity;
      promises.push(this.EndpointHumiditySensor.updateAttribute(RelativeHumidityMeasurement.Cluster.id, 'measuredValue', indoorHumidity * 100, this.EndpointHumiditySensor.log));

      const outdoorTemperature = currentState.outdoorTemperature;
      promises.push(this.Endpoint.updateAttribute(Thermostat.Cluster.id, 'outdoorTemperature', outdoorTemperature * 100, this.Endpoint.log));

      const mode = this.mapDaikinModeToMatter(power ?? false, currentState.mode);
      promises.push(this.Endpoint.updateAttribute(Thermostat.Cluster.id, 'systemMode', mode, this.Endpoint.log));
      promises.push(this.EndpointModeChange.updateAttribute(ModeSelect.Cluster.id, 'currentMode', currentState.mode, this.EndpointModeChange.log));

      const fanSpeed = currentState.fanSpeed;
      const fanMode = fanSpeed !== undefined ? DaikinFanSpeedACFanModeMap[fanSpeed] : FanControl.FanMode.Auto;
      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'fanMode', fanMode, this.Endpoint.log));

      const speedSetting = fanSpeed !== undefined ? DaikinFanSpeedACSpeedSettingMap[fanSpeed] : undefined;
      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'speedSetting', speedSetting ?? null, this.Endpoint.log));

      const percentCurrent = fanSpeed !== undefined ? getPercentFromDaikinFanSpeedAC(fanSpeed) : 0;
      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'percentSetting', percentCurrent, this.Endpoint.log));
      promises.push(this.Endpoint.updateAttribute(ModeSelect.Cluster.id, 'currentMode', fanSpeed, this.Endpoint.log));

      const ventilationSpeed = currentState.ventilationSpeed;
      const ventilationFanMode = ventilationSpeed !== undefined ? DaikinVentilationSpeedACFanModeMap[ventilationSpeed] : FanControl.FanMode.Auto;
      promises.push(this.EndpointVentilation.updateAttribute(FanControl.Cluster.id, 'fanMode', ventilationFanMode, this.EndpointVentilation.log));

      const humidityFanMode = DaikinACMatterDeviceAN22ZRS.getFanModeFromTargetHumidity(currentState.mode, currentState.targetHumidityMap);
      promises.push(this.EndpointHumidity.updateAttribute(FanControl.Cluster.id, 'fanMode', humidityFanMode, this.EndpointHumidity.log));

      const fanUpDownDirection = currentState.fanUpDownDirectionMap.get(currentState.mode)!;
      promises.push(this.EndpointFanUpDownDirection.updateAttribute(ModeSelect.Cluster.id, 'currentMode', fanUpDownDirection, this.EndpointFanUpDownDirection.log));

      const fanRightLeftDirection = currentState.fanRightLeftDirectionMap.get(currentState.mode)!;
      promises.push(this.EndpointFanRightLeftDirection.updateAttribute(ModeSelect.Cluster.id, 'currentMode', fanRightLeftDirection, this.EndpointFanRightLeftDirection.log));

      promises.push(
        this.EndpointOutsideTemperatureSensor.updateAttribute(
          TemperatureMeasurement.Cluster.id,
          'measuredValue',
          currentState.outdoorTemperature * 100,
          this.EndpointOutsideTemperatureSensor.log,
        ),
      );

      await Promise.all(promises);
    });
  }

  private async refreshDeviceStatus() {
    this.log.debug(`Accessory: Refresh status for device '${this.name}'`);

    await this.fetchDeviceStatus();
    await this.restoreState();
  }

  private mapDaikinModeToMatter(power: boolean, mode: DaikinModeAC | undefined): Thermostat.SystemMode {
    if (!power || mode === undefined) {
      return Thermostat.SystemMode.Off;
    }

    switch (mode) {
      case DaikinModeAC.Dry:
        return Thermostat.SystemMode.Dry;
      case DaikinModeAC.Cool:
        return Thermostat.SystemMode.Cool;
      case DaikinModeAC.Heat:
        return Thermostat.SystemMode.Heat;
      case DaikinModeAC.FanOnly:
        return Thermostat.SystemMode.FanOnly;
      case DaikinModeAC.Auto:
        return Thermostat.SystemMode.Auto;
      default:
        return Thermostat.SystemMode.Off; // Default to off if mode is unknown
    }
  }

  private mapMatterModeToDaikin(mode: Thermostat.SystemMode): DaikinModeAC | undefined {
    const matterToDaikinModeMap: Record<Thermostat.SystemMode, DaikinModeAC | undefined> = {
      [Thermostat.SystemMode.Cool]: DaikinModeAC.Cool,
      [Thermostat.SystemMode.Heat]: DaikinModeAC.Heat,
      [Thermostat.SystemMode.Auto]: DaikinModeAC.Auto,
      [Thermostat.SystemMode.Dry]: DaikinModeAC.Dry,
      [Thermostat.SystemMode.FanOnly]: DaikinModeAC.FanOnly,
      [Thermostat.SystemMode.Off]: undefined,
      [Thermostat.SystemMode.EmergencyHeat]: undefined,
      [Thermostat.SystemMode.Precooling]: undefined,
      [Thermostat.SystemMode.Sleep]: undefined,
    };

    return matterToDaikinModeMap[mode];
  }

  private static getFanModeFromTargetHumidity(mode: DaikinModeAC, targetHumidityMap: Map<DaikinModeAC, [DaikinHumidityModeAC, number | null]>): FanControl.FanMode {
    const value = targetHumidityMap.get(mode);
    if (value === undefined) {
      return FanControl.FanMode.Off;
    }

    const humidityMode = value![0];
    const targetHumidity = value![1];

    if (humidityMode === DaikinHumidityModeAC.Off) {
      return FanControl.FanMode.Off;
    } else if (humidityMode === DaikinHumidityModeAC.Low) {
      return FanControl.FanMode.Low;
    } else if (humidityMode === DaikinHumidityModeAC.Medium) {
      return FanControl.FanMode.Medium;
    } else if (humidityMode === DaikinHumidityModeAC.High) {
      return FanControl.FanMode.High;
    } else if (humidityMode === DaikinHumidityModeAC.Continuous) {
      return FanControl.FanMode.Auto;
    } else if (humidityMode === DaikinHumidityModeAC.TargetHumidity) {
      if (mode === DaikinModeAC.Dry || mode === DaikinModeAC.Cool) {
        if (targetHumidity! >= 60) {
          return FanControl.FanMode.High;
        } else if (targetHumidity! >= 55) {
          return FanControl.FanMode.Medium;
        } else {
          return FanControl.FanMode.Low;
        }
      } else if (mode === DaikinModeAC.Humidify || mode === DaikinModeAC.Heat) {
        if (targetHumidity! >= 50) {
          return FanControl.FanMode.High;
        } else if (targetHumidity! >= 45) {
          return FanControl.FanMode.Medium;
        } else {
          return FanControl.FanMode.Low;
        }
      }
    }

    return FanControl.FanMode.Off;
  }

  private static getTargetHumidityFromFanMode(mode: DaikinModeAC, fanMode: FanControl.FanMode): [DaikinHumidityModeAC, number | undefined] | undefined {
    if (mode === DaikinModeAC.Dry || mode === DaikinModeAC.Cool) {
      switch (fanMode) {
        case FanControl.FanMode.Off:
          return [DaikinHumidityModeAC.Off, undefined];
        case FanControl.FanMode.Low:
          return [DaikinHumidityModeAC.TargetHumidity, 50];
        case FanControl.FanMode.Medium:
          return [DaikinHumidityModeAC.TargetHumidity, 55];
        case FanControl.FanMode.High:
          return [DaikinHumidityModeAC.TargetHumidity, 60];
        case FanControl.FanMode.Auto:
          return [DaikinHumidityModeAC.Continuous, undefined]; // 連続
      }
    } else if (mode === DaikinModeAC.Humidify || mode === DaikinModeAC.Heat) {
      switch (fanMode) {
        case FanControl.FanMode.Off:
          return [DaikinHumidityModeAC.Off, undefined];
        case FanControl.FanMode.Low:
          return [DaikinHumidityModeAC.TargetHumidity, 40];
        case FanControl.FanMode.Medium:
          return [DaikinHumidityModeAC.TargetHumidity, 45];
        case FanControl.FanMode.High:
          return [DaikinHumidityModeAC.TargetHumidity, 50];
        case FanControl.FanMode.Auto:
          return [DaikinHumidityModeAC.Continuous, undefined]; // 連続
      }
    } else if (mode === DaikinModeAC.Auto) {
      switch (fanMode) {
        case FanControl.FanMode.Off:
          return [DaikinHumidityModeAC.Off, undefined];
        case FanControl.FanMode.Low:
          return [DaikinHumidityModeAC.Low, undefined];
        case FanControl.FanMode.Medium:
          return [DaikinHumidityModeAC.Medium, undefined];
        case FanControl.FanMode.High:
          return [DaikinHumidityModeAC.High, undefined];
      }
    }

    return undefined;
  }
}

export { DaikinACMatterDeviceAN22ZRS };
