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

import { default as request } from 'superagent';
import { AnsiLogger } from 'matterbridge/logger';

import { DsiotQuery } from './dsiotQuery.js';

const ENDPOINT = '/dsiot/multireq';
const USER_AGENT = 'RemoteApp/9.9.2 CFNetwork/3860.200.71 Darwin/25.1.0';

const REQUEST_TIMEOUT_MS = 3000;

export async function queryDevice(ip: string, log: AnsiLogger, command: string): Promise<DsiotQuery> {
  try {
    const response = await request
      .post(`http://${ip}${ENDPOINT}`)
      .set('User-Agent', USER_AGENT)
      .set('Content-Type', 'application/json')
      .set('Accept', '*/*')
      .send(command)
      .timeout(REQUEST_TIMEOUT_MS);

    if (response.status === 200) {
      // this.log.debug(`Daikin - queryDevice('${this.ip}'): Response: '${JSON.stringify(response.body)}'`);
      const queryResponse = new DsiotQuery(response.body);
      return queryResponse;
    }

    log.debug(`Daikin - queryDevice('${ip}'): Error: Invalid response status code: '${response.status}'`);
  } catch (e) {
    log.debug(`Daikin - queryDevice('${ip}'): Error: '${e}'`);
  }

  throw new Error(`Daikin - queryDevice('${ip}'): Error: Unable to query device`);
}

export async function sendCommand(ip: string, log: AnsiLogger, param: object): Promise<void> {
  const response = await request
    .post(`http://${ip}${ENDPOINT}`)
    .set('User-Agent', USER_AGENT)
    .set('Content-Type', 'application/json')
    .set('Accept', '*/*')
    .send(param)
    .timeout(REQUEST_TIMEOUT_MS);

  if (response.status !== 200) {
    throw new Error(`Daikin - sendCommand('${ip}'): '${JSON.stringify(param)}' : Error: Invalid response status code: '${response.status}'`);
  }
}
