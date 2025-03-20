/**
 * This is the main entry point for the Homebridge plugin
 */
import { API } from 'homebridge';
import { SleepMePlatform } from './platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * Register the platform with Homebridge
 */
export default (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SleepMePlatform);
};
