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
export const DEFAULT_POLLING_INTERVAL = 180; // Increased to 3 minutes to reduce API load

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
 * Significantly increased to prevent rate limiting
 */
export const MIN_REQUEST_INTERVAL = 5000; // 5 seconds

/**
 * Maximum API requests per minute (to respect rate limits)
 * Reduced to be more conservative and avoid rate limiting
 */
export const MAX_REQUESTS_PER_MINUTE = 8; // published limit is 10 - so safety margin

/**
 * Default cache validity period in milliseconds
 * Increased to reduce API requests for status checks
 */
export const DEFAULT_CACHE_VALIDITY_MS = 90000; // 90 seconds