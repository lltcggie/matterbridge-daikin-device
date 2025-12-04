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

import { MatterbridgeDynamicPlatform, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

/**
 * This is the standard interface for Matterbridge plugins.
 * Each plugin should export a default function that follows this signature.
 *
 * @param {PlatformMatterbridge} matterbridge - An instance of MatterBridge.
 * @param {AnsiLogger} log - An instance of AnsiLogger. This is used for logging messages in a format that can be displayed with ANSI color codes and in the frontend.
 * @param {PlatformConfig} config - The platform configuration.
 * @returns {DaikinPlatform} - An instance of the MatterbridgeAccessory or MatterbridgeDynamicPlatform class. This is the main interface for interacting with the Matterbridge system.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): DaikinPlatform {
  return new DaikinPlatform(matterbridge, log, config);
}

import { DaikinMatterDevice } from './DaikinMatterDevice.js';
import daikinMatterFactory from './DaikinMatterFactory.js';

export class DaikinPlatform extends MatterbridgeDynamicPlatform {
  public daikinIPs: string[] = [];
  private devices: DaikinMatterDevice[] = [];
  private isConfigValid = false;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    // Always call super(matterbridge, log, config)
    super(matterbridge, log, config);

    if (config.daikinIPs) this.daikinIPs = config.daikinIPs as string[];

    // Verify that Matterbridge is the correct version
    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.3.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.3.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info(`Initializing Platform...`);

    this.isConfigValid = true;
  }

  override async onStart(reason?: string) {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    if (!this.isConfigValid) {
      throw new Error('Plugin not configured yet, configure first, then restart.');
    }

    await this.ready;
    await this.clearSelect();
    await this.discoverDevices();
  }

  override async onConfigure() {
    await super.onConfigure();

    this.log.info('onConfigure called');

    for (const device of this.devices) {
      await device.restoreState();
    }
  }

  override async onChangeLoggerLevel(logLevel: LogLevel) {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string) {
    await super.onShutdown(reason);

    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);

    for (const device of this.devices) {
      await device.destroy();
    }

    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private async discoverDevices() {
    this.log.info('Discovering devices...');

    for (const daikinIP of this.daikinIPs) {
      try {
        const parts = daikinIP.split(',');

        const ip = parts[0];

        this.log.info(`Creating Daikin AC device at IP: ${ip}`);
        const device = await daikinMatterFactory(ip, this.log);
        if (device === undefined) {
          this.log.error(`Failed to create Daikin device at IP: ${ip}`);
          continue;
        }

        await device.connect();
        await device.createEndpoint(this);

        this.devices.push(device);

        await device.registerWithPlatform(this);
      } catch (error) {
        this.log.error(`Error discovering device at IP ${daikinIP}: ${(error as Error).message}`);
      }
    }
  }
}
