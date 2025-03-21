/**
 * Type definitions for the SleepMe API
 */

/**
 * Device information returned by the API
 */
export interface Device {
  id: string;
  name: string;
  attachments?: string[];
}

/**
 * Device status information
 */
export interface DeviceStatus {
  // Thermal control data
  currentTemperature: number;
  targetTemperature: number;
  thermalStatus: ThermalStatus;
  powerState: PowerState;
  
  // System data
  firmwareVersion?: string;
  connected?: boolean;
  waterLevel?: number;
  isWaterLow?: boolean;
  
  // Raw API response for debugging
  rawResponse?: Record<string, any>;
}

/**
 * Possible thermal control states
 */
export enum ThermalStatus {
  OFF = 'off',
  HEATING = 'heating',
  COOLING = 'cooling',
  ACTIVE = 'active',   // General active state
  STANDBY = 'standby', // Powered on but not actively heating/cooling
  UNKNOWN = 'unknown'
}

/**
 * Power state of the device
 */
export enum PowerState {
  ON = 'on',
  OFF = 'off',
  UNKNOWN = 'unknown'
}

/**
 * Error from the SleepMe API
 */
export interface ApiError {
  status: number;
  message: string;
  code?: string;
  details?: string;
}

/**
 * Device settings to update
 */
export interface DeviceUpdateSettings {
  temperature?: number;       // Temperature in Celsius
  temperatureF?: number;      // Temperature in Fahrenheit
  thermalStatus?: string;     // 'active', 'standby', etc.
  displayUnit?: string;       // 'c' or 'f'
}

/**
 * API request statistics for monitoring
 */
export interface ApiStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastRequest: Date | null;
  lastError: Error | null;
  averageResponseTime: number;
}