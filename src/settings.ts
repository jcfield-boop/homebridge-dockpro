/**
 * Plugin settings and constants
 */

/**
 * Platform name used to register the plugin in Homebridge
 */
export const PLATFORM_NAME = 'SleepMeBasic';

/**
 * Plugin identifier - must match package.json name property
 */
export const PLUGIN_NAME = 'homebridge-sleepme-basic';

/**
 * SleepMe API base URL
 */
export const API_BASE_URL = 'https://api.developer.sleep.me/v1';

/**
 * Default polling interval in seconds
 */
export const DEFAULT_POLLING_INTERVAL = 120;

/**
 * Minimum allowed temperature in Celsius
 */
export const MIN_TEMPERATURE_C = 13; // ~55°F

/**
 * Maximum allowed temperature in Celsius
 */
export const MAX_TEMPERATURE_C = 46; // ~115°F

/**
 * Default temperature step granularity
 */
export const TEMPERATURE_STEP = 0.5;

/**
 * Minimum time between API requests in milliseconds
 * Increased to be more conservative with API calls
 */
export const MIN_REQUEST_INTERVAL = 12000; // 12 seconds (increased from 8)

/**
 * Maximum API requests per minute (to respect rate limits)
 * Reduced from previous value to be more conservative
 */
export const MAX_REQUESTS_PER_MINUTE = 6; // Conservative limit (reduced from 8)