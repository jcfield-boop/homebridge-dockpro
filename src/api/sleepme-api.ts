/**
 * SleepMe API client implementation with robust error handling and rate limiting
 */
import axios, { AxiosError } from 'axios';
import { 
  API_BASE_URL, 
  MAX_REQUESTS_PER_MINUTE, 
  MIN_REQUEST_INTERVAL 
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
  rateLimitHit: boolean;
  backoffUntil: number;
}

/**
 * SleepMe API Client
 * Handles API communication with rate limiting and robust error handling
 */
export class SleepMeApi {
  // Static request tracking to ensure proper rate limiting across all instances
  private static requestTracking: RequestTracking = {
    count: 0,
    lastReset: Date.now(),
    lastRequest: 0,
    rateLimitHit: false,
    backoffUntil: 0
  };
  
  // API statistics for monitoring
  private stats: ApiStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    lastRequest: null,
    lastError: null,
    averageResponseTime: 0
  };
  
  // Request queue and processing flag
  private requestQueue: Promise<unknown> = Promise.resolve();
  private processingQueue = false;
  
  // Initial startup delay 
  private readonly startupComplete: Promise<void>;
  
  constructor(
    private readonly apiToken: string,
    private readonly logger: EnhancedLogger
  ) {
    // Validate API token
    if (!apiToken || apiToken.trim() === '') {
      this.logger.error('Invalid API token provided', LogContext.API);
    }
    
    // Create a startup delay to prevent immediate requests
    this.startupComplete = new Promise(resolve => {
      setTimeout(() => {
        this.logger.debug('Initial startup delay complete', LogContext.API);
        resolve();
      }, 10000); // 10 second startup delay
    });
    
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
   * Should only be used in tests or special circumstances
   */
  public static resetRateLimiting(): void {
    SleepMeApi.requestTracking = {
      count: 0,
      lastReset: Date.now(),
      lastRequest: 0,
      rateLimitHit: false,
      backoffUntil: 0
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
        url: '/devices',
        priority: 'high' // Device discovery is a high priority operation
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
        url: `/devices/${deviceId}`,
        priority: 'normal'
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
   * Extract a nested property value from an object
   * Made public to allow accessory to extract values from raw response
   */
  public extractNestedValue(obj: Record<string, any>, path: string): any {
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
   * Turn device on
   * Modified to match API expectations based on Postman example
   */
  public async turnDeviceOn(deviceId: string, temperature?: number): Promise<boolean> {
    try {
      // Default temperature if none provided
      const targetTemp = temperature !== undefined ? temperature : 21;
      
      this.logger.info(`Turning device ${deviceId} ON with temperature ${targetTemp}°C`, LogContext.API);
      
      // Create payload for API - using integers for temperature values
      // Based on working Postman example format
      const payload: Record<string, any> = {
        // Set Fahrenheit as primary temp (matching Postman example)
        set_temperature_f: Math.round(this.convertCtoF(targetTemp)),
        thermal_control_status: 'active'
      };
      
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
   * Modified to match API expectations based on Postman example
   */
  public async setTemperature(deviceId: string, temperature: number): Promise<boolean> {
    try {
      this.logger.info(`Setting device ${deviceId} temperature to ${temperature}°C`, LogContext.API);
      
      // Convert to Fahrenheit and round to integer (matching Postman example)
      const tempF = Math.round(this.convertCtoF(temperature));
      
      // Create payload following working example format
      const payload = {
        set_temperature_f: tempF
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
        data: settings,
        priority: 'high' // User-initiated actions are high priority
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
   * Make a request to the SleepMe API with strict rate limiting
   * Completely rewritten to handle rate limits better
   */
  private async makeRequest<T>(options: {
    method: string;
    url: string;
    data?: any;
    priority?: 'low' | 'normal' | 'high';
  }): Promise<T> {
    // Default priority to normal if not specified
    const priority = options.priority || 'normal';
    
    // Wait for startup delay to complete for non-high priority requests
    if (priority !== 'high') {
      await this.startupComplete;
    }
    
    // Create a promise to hold the result
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (reason: any) => void;
    
    const resultPromise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    
    // Add this request to the queue to ensure sequential processing
    this.requestQueue = this.requestQueue.then(async () => {
      try {
        // Check if we should skip this request due to backoff
        if (this.shouldSkipRequest(priority)) {
          throw new Error(`Request skipped due to rate limiting backoff (priority: ${priority})`);
        }
        
        // Apply strict rate limiting before proceeding
        await this.applyStrictRateLimit(priority);
        
        // Mark that we're processing a request
        this.processingQueue = true;
        
        const result = await this.executeRequest<T>(options);
        resolvePromise(result);
      } catch (error) {
        rejectPromise(error);
      } finally {
        this.processingQueue = false;
      }
    }).catch(error => {
      rejectPromise(error);
      // Continue the chain for the next request
      return Promise.resolve();
    });
    
    return resultPromise;
  }
  
  /**
   * Determines if a request should be skipped due to backoff
   */
  private shouldSkipRequest(priority: string): boolean {
    const now = Date.now();
    
    // If we're in a backoff period and it's not a high priority request
    if (
      SleepMeApi.requestTracking.rateLimitHit && 
      now < SleepMeApi.requestTracking.backoffUntil && 
      priority !== 'high'
    ) {
      const secondsRemaining = Math.ceil((SleepMeApi.requestTracking.backoffUntil - now) / 1000);
      this.logger.debug(
        `Skipping ${priority} request due to rate limit backoff (${secondsRemaining}s remaining)`,
        LogContext.API
      );
      return true;
    }
    
    return false;
  }
  
  /**
   * Apply strict rate limiting with backoff periods for different priority levels
   */
  private async applyStrictRateLimit(priority: string): Promise<void> {
    const now = Date.now();
    
    // Check if we need to reset the rate limit counter (1 minute has passed)
    if (now - SleepMeApi.requestTracking.lastReset >= 60000) {
      this.logger.debug('Resetting rate limit counter (1 minute has passed)', LogContext.API);
      SleepMeApi.requestTracking.count = 0;
      SleepMeApi.requestTracking.lastReset = now;
      
      // If we've passed the backoff period, clear the rate limit flag
      if (now > SleepMeApi.requestTracking.backoffUntil) {
        SleepMeApi.requestTracking.rateLimitHit = false;
      }
    }
    
    // If we've hit a rate limit before, enforce much stricter limits
    let maxAllowedRequests = SleepMeApi.requestTracking.rateLimitHit 
      ? Math.floor(MAX_REQUESTS_PER_MINUTE * 0.2)  // Only 20% of max if rate limit was hit
      : Math.floor(MAX_REQUESTS_PER_MINUTE * 0.5); // 50% of max normally
    
    // Override for high priority - allow more but still be cautious
    if (priority === 'high') {
      maxAllowedRequests = SleepMeApi.requestTracking.rateLimitHit 
        ? Math.floor(MAX_REQUESTS_PER_MINUTE * 0.33) // 33% for high priority when rate limited 
        : Math.floor(MAX_REQUESTS_PER_MINUTE * 0.75); // 75% for high priority normally
    }
    
    // If we've reached our self-imposed limit
    if (SleepMeApi.requestTracking.count >= maxAllowedRequests) {
      // Time until the current minute resets + a buffer
      const timeUntilReset = (60000 - (now - SleepMeApi.requestTracking.lastReset)) + 5000; // 5s buffer
      
      this.logger.warn(
        `Rate limit threshold reached (${SleepMeApi.requestTracking.count}/${MAX_REQUESTS_PER_MINUTE}), ` +
        `waiting ${Math.round(timeUntilReset/1000)}s before continuing`,
        LogContext.API
      );
      
      // Wait until the reset
      await new Promise(resolve => setTimeout(resolve, timeUntilReset));
      
      // Reset counter after waiting
      SleepMeApi.requestTracking.count = 0;
      SleepMeApi.requestTracking.lastReset = Date.now();
    }
    
    // Set minimum delays between requests based on priority and rate limit history
    let minDelay = MIN_REQUEST_INTERVAL;
    
    if (SleepMeApi.requestTracking.rateLimitHit) {
      // Much longer delays if we've hit rate limits
      minDelay = priority === 'high' ? 10000 : 15000; // 10-15 seconds between requests
    } else {
      // Normal operation delays
      minDelay = priority === 'high' ? 5000 : 
                 priority === 'normal' ? 8000 : 12000; // 5-12 seconds between requests
    }
    
    // Enforce minimum delay between requests
    const timeSinceLastRequest = now - SleepMeApi.requestTracking.lastRequest;
    if (timeSinceLastRequest < minDelay) {
      const delay = minDelay - timeSinceLastRequest;
      this.logger.debug(`Enforcing minimum request delay: ${delay}ms`, LogContext.API);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  /**
   * Execute a request with exponential backoff retry
   */
  private async executeRequest<T>(options: {
    method: string;
    url: string;
    data?: any;
    priority?: 'low' | 'normal' | 'high';
  }): Promise<T> {
    let retryCount = 0;
    const maxRetries = 5;
    
    // Track the request for rate limiting
    SleepMeApi.requestTracking.count++;
    SleepMeApi.requestTracking.lastRequest = Date.now();
    
    while (true) {
      try {
        const startTime = Date.now();
        
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
          timeout: 30000 // 30 second timeout
        });
        
        // Update stats
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
        
        // Handle different error types
        if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;
          
          // Check for rate limiting (status 429)
          if (axiosError.response?.status === 429) {
            this.logger.error('API rate limit exceeded', LogContext.API);
            
            // Set global rate limit flag and backoff time
            SleepMeApi.requestTracking.rateLimitHit = true;
            
            // Calculate backoff time based on retry count (exponential backoff)
            // Much more aggressive backoff than before
            const baseBackoff = 60000; // Start with 1 minute
            const backoffTime = Math.min(600000, baseBackoff * Math.pow(2, retryCount)); 
            const backoffUntil = Date.now() + backoffTime;
            
            this.logger.warn(
              `Enforcing rate limit backoff of ${Math.round(backoffTime/1000)}s`,
              LogContext.API
            );
            
            SleepMeApi.requestTracking.backoffUntil = backoffUntil;
            
            retryCount++;
            if (retryCount <= maxRetries) {
              // Calculate retry delay - use exponential backoff with retries
              const retryDelay = Math.pow(2, retryCount + 1) * 2000;
              
              this.logger.warn(
                `Request failed, retrying in ${Math.round(retryDelay/1000)}s (attempt ${retryCount}/${maxRetries}): ${axiosError.message}`,
                LogContext.API
              );
              
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              continue;
            }
          }
          
          // Server errors (500 range) or network errors should be retried
          const shouldRetry = !axiosError.response || 
                             axiosError.response.status >= 500 || 
                             axiosError.code === 'ECONNABORTED';
          
          if (shouldRetry && retryCount < maxRetries) {
            retryCount++;
            
            // Use exponential backoff
            const retryDelay = Math.pow(2, retryCount) * 1000;
            
            this.logger.warn(
              `Server error, retrying in ${Math.round(retryDelay/1000)}s (attempt ${retryCount}/${maxRetries}): ${axiosError.message}`,
              LogContext.API
            );
            
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
          }
        }
        
        // If we've exhausted retries or it's not a retriable error, rethrow
        throw error;
      }
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