/**
 * SleepMe API client implementation with robust error handling and rate limiting
 */
import axios, {AxiosError } from 'axios';
import { 
  API_BASE_URL, 
  MIN_REQUEST_INTERVAL, 
  MAX_REQUESTS_PER_MINUTE 
} from '../settings.js';
import { 
  Device, 
  DeviceStatus,
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
   * Test the API connection
   * Returns true if successful, false otherwise
   */
  public async testConnection(): Promise<boolean> {
    try {
      this.logger.info('Testing API connection...', LogContext.API);
      
      // Try to get devices as a connection test
      const devices = await this.getDevices();
      
      if (devices && devices.length > 0) {
        this.logger.info(`Connection successful - found ${devices.length} devices`, LogContext.API);
        return true;
      } else {
        this.logger.error('Connection test failed - no devices found', LogContext.API);
        return false;
      }
    } catch (error) {
      this.handleApiError('testConnection', error);
      return false;
    }
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
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 10000
      });
      
      // Update stats
      success = true;
      this.stats.successfulRequests++;
      
      // Calculate response time and update average
      const responseTime = Date.now() - startTime;
      this.updateAverageResponseTime(responseTime);
      
      // Log the response
      this.logger.api(options.method, options.url, response.status, 
        options.method === 'GET' ? undefined : options.data);
      
      return response.data as T;
    } catch (error) {
      // Update stats
      this.stats.failedRequests++;
      this.stats.lastError = error instanceof Error ? error : new Error(String(error));
      
      // Handle rate limiting specially
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        this.handleRateLimitExceeded();
      }
      
      throw error;
    } finally {
      // Track rate limiting
      this.trackRequest();
    }
  }
  
  /**
   * Apply rate limiting before making a request
   */
  private async applyRateLimit(): Promise<void> {
    const now = Date.now();
    
    // Check if we need to reset the rate limit counter (1 minute has passed)
    if (now - SleepMeApi.requestTracking.lastReset >= 60000) {
      SleepMeApi.requestTracking.count = 0;
      SleepMeApi.requestTracking.lastReset = now;
    }
    
    // Check if we've hit the rate limit
    if (SleepMeApi.requestTracking.count >= MAX_REQUESTS_PER_MINUTE) {
      // Calculate time until reset
      const timeUntilReset = 60000 - (now - SleepMeApi.requestTracking.lastReset);
      this.logger.debug(`Rate limit reached, waiting ${timeUntilReset}ms`, LogContext.API);
      
      // Wait until rate limit resets
      await new Promise(resolve => setTimeout(resolve, timeUntilReset + 100));
      
      // Reset tracking
      SleepMeApi.requestTracking.count = 0;
      SleepMeApi.requestTracking.lastReset = Date.now();
    }
    
    // Enforce minimum delay between requests
    const timeSinceLastRequest = now - SleepMeApi.requestTracking.lastRequest;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      const delay = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      this.logger.verbose(`Enforcing minimum request delay: ${delay}ms`, LogContext.API);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  /**
   * Track a request for rate limiting
   */
  private trackRequest(): void {
    SleepMeApi.requestTracking.count++;
    SleepMeApi.requestTracking.lastRequest = Date.now();
  }
  
  /**
   * Handle rate limit exceeded error
   */
  private handleRateLimitExceeded(): void {
    this.logger.warn('API rate limit exceeded', LogContext.API);
    // Force a longer delay for the next request
    SleepMeApi.requestTracking.count = MAX_REQUESTS_PER_MINUTE;
  }
  
  /**
   * Update the average response time
   */
  private updateAverageResponseTime(newResponseTime: number): void {
    if (this.stats.averageResponseTime === 0) {
      this.stats.averageResponseTime = newResponseTime;
    } else {
      // Simple moving average calculation
      this.stats.averageResponseTime = 
        (this.stats.averageResponseTime * 0.9) + (newResponseTime * 0.1);
    }
  }
  
  /**
   * Handle API errors
   */
  private handleApiError(context: string, error: unknown): void {
    // Cast to Axios error if possible
    const axiosError = error as AxiosError;
    
    // Details for the log
    let errorMessage = '';
    let responseStatus = 0;
    let responseData = null;
    
    // Get error details
    if (axios.isAxiosError(axiosError)) {
      responseStatus = axiosError.response?.status || 0;
      responseData = axiosError.response?.data;
      errorMessage = axiosError.message;
      
      this.logger.error(
        `API error in ${context}: ${errorMessage} (Status: ${responseStatus})`,
        LogContext.API
      );
      
      if (responseData) {
        this.logger.debug(`Response data: ${JSON.stringify(responseData)}`, LogContext.API);
      }
    } else {
      // Not an Axios error
      errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error in ${context}: ${errorMessage}`, LogContext.API);
    }
  }
  
  /**
   * Extract a temperature value from nested properties
   */
  private extractTemperature(data: Record<string, any>, paths: string[], defaultValue = 21): number {
    for (const path of paths) {
      const value = this.extractNestedValue(data, path);
      if (typeof value === 'number' && !isNaN(value)) {
        return value;
      }
    }
    
    return defaultValue;
  }
  
  /**
   * Extract a nested property value from an object
   */
  private extractNestedValue(obj: Record<string, any>, path: string): any {
    const parts = path.split('.');
    let value = obj;
    
    for (const part of parts) {
      if (value === null || value === undefined || typeof value !== 'object') {
        return undefined;
      }
      
      value = value[part];
    }
    
    return value;
  }
  
  /**
   * Extract thermal status from API response
   */
  private extractThermalStatus(data: Record<string, any>): ThermalStatus {
    // Try to get thermal status from control object
    const rawStatus = this.extractNestedValue(data, 'control.thermal_control_status') ||
                      this.extractNestedValue(data, 'thermal_control_status');
    
    if (rawStatus) {
      switch (String(rawStatus).toLowerCase()) {
        case 'active':
          return ThermalStatus.ACTIVE;
        case 'heating':
          return ThermalStatus.HEATING;
        case 'cooling':
          return ThermalStatus.COOLING;
        case 'standby':
          return ThermalStatus.STANDBY;
        case 'off':
          return ThermalStatus.OFF;
        default:
          this.logger.warn(`Unknown thermal status: ${rawStatus}`, LogContext.API);
          return ThermalStatus.UNKNOWN;
      }
    }
    
    return ThermalStatus.UNKNOWN;
  }
  
  /**
   * Extract power state from API response
   */
  private extractPowerState(data: Record<string, any>): PowerState {
    // Try different paths for power state
    const thermalStatus = this.extractThermalStatus(data);
    
    // If we have a thermal status, infer power state
    if (thermalStatus !== ThermalStatus.UNKNOWN) {
      if (thermalStatus === ThermalStatus.OFF || thermalStatus === ThermalStatus.STANDBY) {
        return PowerState.OFF;
      } else {
        return PowerState.ON;
      }
    }
    
    // Try to get from is_connected or other fields
    const isConnected = this.extractNestedValue(data, 'status.is_connected') ||
                        this.extractNestedValue(data, 'is_connected');
    
    if (typeof isConnected === 'boolean') {
      return isConnected ? PowerState.ON : PowerState.OFF;
    }
    
    return PowerState.UNKNOWN;
  }
  
  /**
   * Convert Celsius to Fahrenheit
   */
  private convertCtoF(celsius: number): number {
    return (celsius * 9/5) + 32;
  }
  
  /**
   * Convert Fahrenheit to Celsius
   */
  private convertFtoC(fahrenheit: number): number {
    return (fahrenheit - 32) * 5/9;
  }
}