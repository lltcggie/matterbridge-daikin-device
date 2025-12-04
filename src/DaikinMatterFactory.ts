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

import { AnsiLogger } from 'matterbridge/logger';

import { DaikinMatterDevice } from './DaikinMatterDevice.js';
import { DaikinACMatterDeviceAN22ZRS } from './DaikinACMatterDeviceAN22ZRS.js';
import { DaikinAPMatterDeviceACK70Z } from './DaikinAPMatterDeviceACK70Z.js';
import { queryDevice } from './utils/dsiotRequest.js';

const COMMAND_QUERY = '{"requests":[{"op":2,"to":"/dsiot/edge.dev_i?filter=pv"}]}';

async function getDeviceType(ip: string, log: AnsiLogger): Promise<string> {
  try {
    const response = await queryDevice(ip, log, COMMAND_QUERY);

    const deviceType = response.extractValueString('/dsiot/edge.dev_i', 'dev_i/type');
    if (deviceType !== undefined) {
      return deviceType;
    }

    log.debug(`Daikin - queryDevice('${ip}'): Error: Invalid response: No device type found`);
  } catch (e) {
    log.debug(`Daikin - queryDevice('${ip}'): Error: '${e}'`);
  }

  throw new Error(`Daikin - getDeviceType('${ip}'): Error: Unable to get device type`);
}

export default async function daikinMatterFactory(ip: string, log: AnsiLogger): Promise<DaikinMatterDevice | undefined> {
  const deviceType = await getDeviceType(ip, log);
  switch (deviceType) {
    case 'RA':
      log.info(`Daikin - daikinMatterFactory('${ip}'): Detected device type: 'DaikinACMatterDeviceAN22ZRS'`);
      return new DaikinACMatterDeviceAN22ZRS(ip, log);
    case '1D':
      log.info(`Daikin - daikinMatterFactory('${ip}'): Detected device type: 'DaikinAPMatterDeviceACK70Z'`);
      return new DaikinAPMatterDeviceACK70Z(ip, log);
    default:
      throw new Error(`Daikin - daikinMatterFactory('${ip}'): Unknown device type: '${deviceType}'`);
  }
}
