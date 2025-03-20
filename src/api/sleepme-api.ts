/**
 * SleepMe API client implementation with robust error handling and rate limiting
 */
import axios, { AxiosResponse, AxiosError } from 'axios';
import { 
  API_BASE_URL, 
  MIN_REQUEST_INTERVAL, 
  MAX_REQUESTS_PER_MINUTE 
} from '../settings.js';
import { 
  Device, 
  DeviceStatus, 
  DeviceUpdateSettings, 
  ApiError, 
  ApiStats, 
  ThermalStatus, 
  PowerState 
} from './types.js';
import { EnhancedLogger, LogContext } from '../utils/logger.js';

// Static rate limiting - shared across all instances
interface RequestTracking {
  count: number;
  lastReset: number;
  lastRequest: number;
}

/**
 * SleepMe API Client
 * Handles API communication with rate limiting and robust error handling
 */
export class SleepMeApi {
  private static requestTracking: RequestTracking = {
    count: 0,
    lastReset: Date.now(),
    lastRequest: 0
  };
  
  private stats: ApiStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    lastRequest: null,
    lastError: null,
    averageResponseTime: 0
  };
  
  // Queue for sequential API requests
  private requestQueue: Promise<unknown> = Promise.resolve();
  
  constructor(
    private readonly apiToken: string,
    private readonly logger: EnhancedLogger
  ) {
    // Validate API token
    if (!apiToken || apiToken.trim() === '') {
      this.logger.error('Invalid API token provided', LogContext.API);
    }
    
    this.logger.info('SleepMe API client initialized', LogContext.API);
  }
  
  /**
   * Get API statistics
   */
  public getStats(): ApiStats {
    return { ...this.stats };
  }
  
  /**
   * Clear API statistics
   */
  public clearStats(): void {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      lastRequest: null,
      lastError: null,
      averageResponseTime: 0
    };
  }
  
  /**
   * Reset rate limiting tracking
   */
  public static resetRateLimiting(): void {
    SleepMeApi.requestTracking = {
      count: 0,
      lastReset: Date.now(),
      lastRequest: 0
    };
  }
  
  /**
   * Get devices from the SleepMe API
   */
  public async getDevices(): Promise<Device[]> {
    try {
      this.logger.debug('Fetching devices...', LogContext.API);
      
      const response = await this.makeRequest<Device[] | { devices: Device[] }>({
        method: 'GET',
        url: '/devices'
      });
      
      // Handle different API response formats
      let devices: Device[];
      if (Array.isArray(response)) {
        devices = response;
      } else if (response && typeof response === 'object' && 'devices' in response) {
        devices = response.devices;
      } else {
        this.logger.error('Unexpected API response format for devices', LogContext.API);
        return [];
      }
      
      // Validate and filter devices
      const validDevices = devices.filter(device => {
        if (!device.id) {
          this.logger.warn(`Found device without ID: ${JSON.stringify(device)}`, LogContext.API);
          return false;
        }
        return true;
      });
      
      this.logger.info(`Found ${validDevices.length} devices`, LogContext.API);
      return validDevices;
    } catch (error) {
      this.handleApiError('getDevices', error);
      return [];
    }
  }
  
  /**
   * Get status for a specific device
   */
  public async getDeviceStatus(deviceId: string): Promise<DeviceStatus | null> {
    if (!deviceId) {
      this.logger.error('Missing device ID in getDeviceStatus', LogContext.API);
      return null;
    }
    
    try {
      this.logger.debug(`Fetching status for device ${deviceId}...`, LogContext.API);
      
      const response = await this.makeRequest<Record<string, any>>({
        method: 'GET',
        url: `/devices/${deviceId}`
      });
      
      if (!response) {
        this.logger.error(`Empty response for device ${deviceId}`, LogContext.API);
        return null;
      }
      
      // Save the raw response for debugging
      const rawResponse = { ...response };
      
      // Parse the device status from the response
      const status: DeviceStatus = {
        // Extract current temperature (various possible locations in API)
        currentTemperature: this.extractTemperature(response, [
          'status.water_temperature_c',
          'water_temperature_c',
          'control.current_temperature_c',
          'current_temperature_c'
        ], 21),
        
        // Extract target temperature
        targetTemperature: this.extractTemperature(response, [
          'control.set_temperature_c',
          'set_temperature_c'
        ], 21),
        
        // Extract thermal status
        thermalStatus: this.extractThermalStatus(response),
        
        // Extract power state
        powerState: this.extractPowerState(response),
        
        // Include raw response for debugging
        rawResponse
      };
      
      // Extract firmware version if available
      const firmwareVersion = this.extractNestedValue(response, 'about.firmware_version') || 
                             this.extractNestedValue(response, 'firmware_version');
      
      if (firmwareVersion) {
        status.firmwareVersion = String(firmwareVersion);
      }
      
      // Extract connection status if available
      const connected = this.extractNestedValue(response, 'status.is_connected') ||
                       this.extractNestedValue(response, 'is_connected');
      
      if (connected !== undefined) {
        status.connected = Boolean(connected);
      }
      
      this.logger.debug(
        `Device status: Temp=${status.currentTemperature}°C, ` +
        `Target=${status.targetTemperature}°C, ` +
        `Status=${status.thermalStatus}`,
        LogContext.API
      );
      
      return status;
    } catch (error) {
      this.handleApiError(`getDeviceStatus(${deviceId})`, error);
      return null;
    }
  }
  
  /**
   * Turn device on
   */
  public async turnDeviceOn(deviceId: string, temperature?: number): Promise<boolean> {
    try {
      // Default temperature if none provided
      const targetTemp = temperature !== undefined ? temperature : 21;
      
      this.logger.info(`Turning device ${deviceId} ON with temperature ${targetTemp}°C`, LogContext.API);
      
      // Create payload for API
      const payload: Record<string, any> = {
        set_temperature_c: targetTemp,
        thermal_control_status: 'active'
      };
      
      // Also include Fahrenheit equivalent for compatibility
      payload.set_temperature_f = this.convertCtoF(targetTemp);
      
      return await this.updateDeviceSettings(deviceId, payload);
    } catch (error) {
      this.handleApiError(`turnDeviceOn(${deviceId})`, error);
      return false;
    }
  }
  
  /**
   * Turn device off
   */
  public async turnDeviceOff(deviceId: string): Promise<boolean> {
    try {
      this.logger.info(`Turning device ${deviceId} OFF`, LogContext.API);
      
      // Create payload with standby status
      const payload = {
        thermal_control_status: 'standby'
      };
      
      return await this.updateDeviceSettings(deviceId, payload);
    } catch (error) {
      this.handleApiError(`turnDeviceOff(${deviceId})`, error);
      return false;
    }
  }
  
  /**
   * Set device temperature
   */
  public async setTemperature(deviceId: string, temperature: number): Promise<boolean> {
    try {
      this.logger.info(`Setting device ${deviceId} temperature to ${temperature}°C`, LogContext.API);
      
      // Create payload with both C and F temperatures
      const payload = {
        set_temperature_c: temperature,
        set_temperature_f: this.convertCtoF(temperature)
      };
      
      return await this.updateDeviceSettings(deviceId, payload);
    } catch (error) {
      this.handleApiError(`setTemperature(${deviceId})`, error);
      return false;
    }
  }
  
  /**
   * Update device settings
   */
  private async updateDeviceSettings(deviceId: string, settings: Record<string, any>): Promise<boolean> {
    if (!deviceId) {
      this.logger.error('Missing device ID in updateDeviceSettings', LogContext.API);
      return false;
    }
    
    if (!settings || Object.keys(settings).length === 0) {
      this.logger.error('Empty settings in updateDeviceSettings', LogContext.API);
      return false;
    }
    
    try {
      this.logger.debug(`Updating device ${deviceId} settings: ${JSON.stringify(settings)}`, LogContext.API);
      
      const response = await this.makeRequest<Record<string, any>>({
        method: 'PATCH',
        url: `/devices/${deviceId}`,
        data: settings
      });
      
      // If successful response
      if (response) {
        this.logger.info(`Successfully updated device ${deviceId} settings`, LogContext.API);
        return true;
      }
      
      return false;
    } catch (error) {
      this.handleApiError(`updateDeviceSettings(${deviceId})`, error);
      return false;
    }
  }
  
  /**
   * Make a request to the SleepMe API with rate limiting
   */
  private async makeRequest<T>(options: {
    method: string;
    url: string;
    data?: any;
  }): Promise<T> {
    // Create a promise to hold the result
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (reason: any) => void;
    
    const resultPromise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    
    // Add this request to the queue
    this.requestQueue = this.requestQueue.then(async () => {
      try {
        const result = await this.executeRequest<T>(options);
        resolvePromise(result);
      } catch (error) {
        rejectPromise(error);
      }
    }).catch(async () => {
      // If the previous request failed, still try this one
      try {
        const result = await this.executeRequest<T>(options);
        resolvePromise(result);
      } catch (error) {
        rejectPromise(error);
      }
    });
    
    return resultPromise;
  }
  
  /**
   * Execute a request with rate limiting
   */
  private async executeRequest<T>(options: {
    method: string;
    url: string;
    data?: any;
  }): Promise<T> {
    await this.applyRateLimit();
    
    const startTime = Date.now();
    let success = false;
    
    try {
      // Track request stats
      this.stats.totalRequests++;
      this.stats.lastRequest = new Date();
      
      const fullUrl = `${API_BASE_URL}${options.url}`;
      
      this.logger.api(options.method, options.url);
      
      // Make the actual request
      const response = await axios({
        method: options.method,
        url: fullUrl,
        data: options.data,
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type':