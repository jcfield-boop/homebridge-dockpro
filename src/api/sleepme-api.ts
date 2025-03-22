/**
 * SleepMe API client implementation with robust error handling, rate limiting, and caching
 * Significantly enhanced to prevent 429 errors through intelligent request queuing and caching
 */
import axios, { AxiosError, AxiosRequestConfig } from 'axios';
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
  PowerState,
} from './types.js';
import { EnhancedLogger, LogContext, LogLevel } from '../utils/logger.js';

/**
 * Priority levels for API requests
 */
enum RequestPriority {
  HIGH = 'high',       // Critical user-initiated actions (power, temperature changes)
  NORMAL = 'normal',   // Regular status updates
  LOW = 'low'          // Background or non-essential operations
}

/**
 * Interface for a request in the queue
 */
interface QueuedRequest {
  id: string;                          // Unique ID for the request
  config: AxiosRequestConfig;          // Request configuration
  priority: RequestPriority;           // Request priority
  resolve: (value: any) => void;       // Promise resolution function
  reject: (reason: any) => void;       // Promise rejection function
  retryCount: number;                  // Number of retries attempted
  timestamp: number;                   // When the request was queued
  executing?: boolean;                 // Whether the request is currently executing
  method: string;                      // HTTP method (for logging)
  url: string;                         // Endpoint URL (for logging)
  deviceId?: string;                   // Device ID if applicable
  operationType?: string;              // Operation type for deduplication
}

/**
 * Cache entry for device status
 */
interface DeviceStatusCache {
  status: DeviceStatus;                // Cached device status
  timestamp: number;                   // When the status was cached
  isOptimistic: boolean;               // Whether this is an optimistic update
}

/**
 * SleepMe API Client
 * Handles API communication with rate limiting, robust error handling, and caching
 */
export class SleepMeApi {
  // Request queue
  private requestQueue: QueuedRequest[] = [];
  
  // Rate limiting state
  private requestsThisMinute = 0;
  private minuteStartTime = Date.now();
  private lastRequestTime = 0;
  private processingQueue = false;
  private rateLimitBackoffUntil = 0;
  private consecutiveErrors = 0;
  
  // Request ID counter
  private requestIdCounter = 0;
  
  // Device status cache
  private deviceStatusCache: Map<string, DeviceStatusCache> = new Map();
  private readonly cacheValidityMs = 90000; // Cache valid for 90 seconds
  
  // API statistics for monitoring
  private stats: ApiStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    lastRequest: null,
    lastError: null,
    averageResponseTime: 0
  };
  
  // Initial startup delay 
  private readonly startupComplete: Promise<void>;
  private startupFinished = false;
  
  /**
   * Create a new SleepMe API client
   * @param apiToken API authentication token
   * @param logger Enhanced logging utility
   */
  constructor(
    private readonly apiToken: string,
    private readonly logger: EnhancedLogger
  ) {
    // Validate API token
    if (!apiToken || apiToken.trim() === '') {
      this.logger.error('Invalid API token provided', LogContext.API);
      throw new Error('Invalid API token provided');
    }
    
    // Create a startup delay to prevent immediate requests
    this.startupComplete = new Promise(resolve => {
      setTimeout(() => {
        this.logger.debug('Initial startup delay complete', LogContext.API);
        this.startupFinished = true;
        resolve();
      }, 5000); // 5 second startup delay
    });
    
    // Start the queue processor
    this.processQueue();
    
    // Set up cache cleanup interval
    setInterval(() => this.cleanupCache(), 300000); // Clean up cache every 5 minutes
    
    this.logger.info('SleepMe API client initialized', LogContext.API);
    this.logger.verbose(`API client configured with API token: ${apiToken.substring(0, 4)}...${apiToken.substring(apiToken.length - 4)}`, LogContext.API);
  }
  
  /**
   * Get API statistics
   * @returns Current API statistics
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
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    let expiredCount = 0;
    
    for (const [deviceId, cacheEntry] of this.deviceStatusCache.entries()) {
      // Keep cache entries that are less than twice the validity period old
      if (now - cacheEntry.timestamp > this.cacheValidityMs * 2) {
        this.deviceStatusCache.delete(deviceId);
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      this.logger.debug(`Cleaned up ${expiredCount} expired cache entries`, LogContext.API);
    }
  }
  
  /**
   * Get devices from the SleepMe API
   * @returns Array of devices or empty array if error
   */
  public async getDevices(): Promise<Device[]> {
    try {
      this.logger.debug('Fetching devices...', LogContext.API);
      
      const response = await this.makeRequest<Device[] | { devices: Device[] }>({
        method: 'GET',
        url: '/devices',
        priority: RequestPriority.HIGH, // Device discovery is a high priority operation
        operationType: 'getDevices'
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
      
      // Verbose log the complete device list
      if (this.logger.isVerboseEnabled()) {
        this.logger.verbose(`Retrieved ${devices.length} devices from API`, LogContext.API);
        devices.forEach((device, index) => {
          this.logger.verbose(`Device ${index + 1}: ID=${device.id}, Name=${device.name}`, LogContext.API);
        });
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
   * Get status for multiple devices in a batched request
   * @param deviceIds Array of device identifiers
   * @param forceFresh Whether to force fresh status updates
   * @returns Map of device IDs to device statuses
   */
  public async getMultipleDeviceStatuses(
    deviceIds: string[], 
    forceFresh = false
  ): Promise<Map<string, DeviceStatus | null>> {
    const results = new Map<string, DeviceStatus | null>();
    
    this.logger.debug(`Getting status for ${deviceIds.length} devices${forceFresh ? ' (force fresh)' : ''}`, LogContext.API);
    
    // Use a staggered approach to avoid rate limiting
    for (let i = 0; i < deviceIds.length; i++) {
        const deviceId = deviceIds[i];
        const status = await this.getDeviceStatus(deviceId, forceFresh);
        results.set(deviceId, status);
        
        // Add a small delay between requests to avoid API rate limiting
        if (i < deviceIds.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    this.logger.verbose(`Retrieved status for ${deviceIds.length} devices`, LogContext.API);
    return results;
  }

  /**
   * Get status for a specific device with intelligent caching
   * @param deviceId Device identifier
   * @param forceFresh Whether to force a fresh status update
   * @returns Device status or null if error
   */
  public async getDeviceStatus(deviceId: string, forceFresh = false): Promise<DeviceStatus | null> {
    if (!deviceId) {
      this.logger.error('Missing device ID in getDeviceStatus', LogContext.API);
      return null;
    }
    
    try {
     // Check cache first if not forcing fresh data
if (!forceFresh) {
  const cachedStatus = this.deviceStatusCache.get(deviceId);
  const now = Date.now();
  
  // Use cache if valid - even if optimistic but for a shorter time
  // This reduces API calls after user interactions
  if (cachedStatus && 
      (now - cachedStatus.timestamp < (cachedStatus.isOptimistic ? 
        this.cacheValidityMs/2 : this.cacheValidityMs))) {
    
    const ageSeconds = Math.round((now - cachedStatus.timestamp) / 1000);
    const optimisticFlag = cachedStatus.isOptimistic ? ' (optimistic)' : '';
    this.logger.verbose(
      `Using cached status for device ${deviceId} (${ageSeconds}s old${optimisticFlag})`, 
      LogContext.API
    );
    
    // Log the cached status details if verbose logging is enabled
    if (this.logger.isVerboseEnabled()) {
      this.logger.verbose(
        `Cached status: Current=${cachedStatus.status.currentTemperature}°C, ` +
        `Target=${cachedStatus.status.targetTemperature}°C, ` +
        `Status=${cachedStatus.status.thermalStatus}, ` +
        `Power=${cachedStatus.status.powerState}`,
        LogContext.API
      );
    }
    
    return cachedStatus.status;
  }
}
      
      this.logger.debug(`Fetching status for device ${deviceId}...`, LogContext.API);
      
      const response = await this.makeRequest<Record<string, any>>({
        method: 'GET',
        url: `/devices/${deviceId}`,
        priority: forceFresh ? RequestPriority.HIGH : RequestPriority.NORMAL,
        deviceId,
        operationType: 'getDeviceStatus'
      });
      
      if (!response) {
        this.logger.error(`Empty response for device ${deviceId}`, LogContext.API);
        return null;
      }
      
      // Save the raw response for debugging
      const rawResponse = { ...response };
      
      // For API detail logging, log the full raw response
      if (this.logger.isApiDetailEnabled()) {
        this.logger.apiDetail(`Raw device status response: ${JSON.stringify(rawResponse)}`);
      }
      
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
      
      // Extract water level information if available
      const waterLevel = this.extractNestedValue(response, 'status.water_level') || 
                         this.extractNestedValue(response, 'water_level');
                         
      if (waterLevel !== undefined) {
        status.waterLevel = Number(waterLevel);
      }
      
      const isWaterLow = this.extractNestedValue(response, 'status.is_water_low') || 
                         this.extractNestedValue(response, 'is_water_low');
                         
      if (isWaterLow !== undefined) {
        status.isWaterLow = Boolean(isWaterLow);
      }
      
      // Verbose log the parsed status information
      this.logger.verbose(
        `Device status: Temp=${status.currentTemperature}°C, ` +
        `Target=${status.targetTemperature}°C, ` +
        `Status=${status.thermalStatus}, ` +
        `Power=${status.powerState}` +
        (status.waterLevel !== undefined ? `, Water=${status.waterLevel}%` : ''),
        LogContext.API
      );
      
      // Update cache with fresh data
      this.deviceStatusCache.set(deviceId, {
        status,
        timestamp: Date.now(),
        isOptimistic: false
      });
      
      return status;
    } catch (error) {
      this.handleApiError(`getDeviceStatus(${deviceId})`, error);
      return null;
    }
  }

  /**
   * Extract a nested property value from an object
   * @param obj Object to extract from
   * @param path Dot-notation path to property
   * @returns Extracted value or undefined if not found
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
   * @param deviceId Device identifier
   * @param temperature Optional target temperature in Celsius
   * @returns Whether operation was successful
   */
  public async turnDeviceOn(deviceId: string, temperature?: number): Promise<boolean> {
    try {
      // Default temperature if none provided
      const targetTemp = temperature !== undefined ? temperature : 21;
      
      this.logger.info(`Turning device ${deviceId} ON with temperature ${targetTemp}°C`, LogContext.API);
      
      // Create payload for API - using integers for temperature values
      const payload: Record<string, any> = {
        // Set Fahrenheit as primary temp (matching API expectation)
        set_temperature_f: Math.round(this.convertCtoF(targetTemp)),
        thermal_control_status: 'active'
      };
      
      // Log the request payload in verbose mode
      this.logger.verbose(`Turn ON payload: ${JSON.stringify(payload)}`, LogContext.API);
      
      const success = await this.updateDeviceSettings(deviceId, payload);
      
      if (success) {
        // Update cache optimistically
        this.updateCacheOptimistically(deviceId, {
          powerState: PowerState.ON,
          targetTemperature: targetTemp,
          thermalStatus: ThermalStatus.ACTIVE
        });
        
        this.logger.verbose(`Device ${deviceId} turned ON successfully`, LogContext.API);
      } else {
        this.logger.error(`Failed to turn device ${deviceId} ON`, LogContext.API);
      }
      
      return success;
    } catch (error) {
      this.handleApiError(`turnDeviceOn(${deviceId})`, error);
      return false;
    }
  }

  /**
   * Turn device off
   * @param deviceId Device identifier
   * @returns Whether operation was successful
   */
  public async turnDeviceOff(deviceId: string): Promise<boolean> {
    try {
      this.logger.info(`Turning device ${deviceId} OFF`, LogContext.API);
      
      // Create payload with standby status
      const payload = {
        thermal_control_status: 'standby'
      };
      
      this.logger.verbose(`Turn OFF payload: ${JSON.stringify(payload)}`, LogContext.API);
      
      const success = await this.updateDeviceSettings(deviceId, payload);
      
      if (success) {
        // Update cache optimistically
        this.updateCacheOptimistically(deviceId, {
          powerState: PowerState.OFF,
          thermalStatus: ThermalStatus.STANDBY
        });
        
        this.logger.verbose(`Device ${deviceId} turned OFF successfully`, LogContext.API);
      } else {
        this.logger.error(`Failed to turn device ${deviceId} OFF`, LogContext.API);
      }
      
      return success;
    } catch (error) {
      this.handleApiError(`turnDeviceOff(${deviceId})`, error);
      return false;
    }
  }

  /**
   * Set device temperature
   * @param deviceId Device identifier
   * @param temperature Target temperature in Celsius
   * @returns Whether operation was successful
   */
  public async setTemperature(deviceId: string, temperature: number): Promise<boolean> {
    try {
      this.logger.info(`Setting device ${deviceId} temperature to ${temperature}°C`, LogContext.API);
      
      // Convert to Fahrenheit and round to integer (matching API expectation)
      const tempF = Math.round(this.convertCtoF(temperature));
      
      // Create payload following API format
      const payload = {
        set_temperature_f: tempF
      };
      
      this.logger.verbose(`Set temperature payload: ${JSON.stringify(payload)}`, LogContext.API);
      
      const success = await this.updateDeviceSettings(deviceId, payload);
      
      if (success) {
        // Update cache optimistically
        this.updateCacheOptimistically(deviceId, {
          targetTemperature: temperature
        });
        
        this.logger.verbose(`Device ${deviceId} temperature set successfully to ${temperature}°C`, LogContext.API);
      } else {
        this.logger.error(`Failed to set device ${deviceId} temperature to ${temperature}°C`, LogContext.API);
      }
      
      return success;
    } catch (error) {
      this.handleApiError(`setTemperature(${deviceId})`, error);
      return false;
    }
  }

  /**
   * Update device settings
   * @param deviceId Device identifier
   * @param settings Settings to update
   * @returns Whether operation was successful
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
      
      // Cancel any pending device status requests for this device
      this.cancelPendingRequests(deviceId, 'getDeviceStatus');
      
      const response = await this.makeRequest<Record<string, any>>({
        method: 'PATCH',
        url: `/devices/${deviceId}`,
        data: settings,
        priority: RequestPriority.HIGH, // User-initiated actions are high priority
        deviceId,
        operationType: 'updateDeviceSettings'
      });
      
      // If successful response
      if (response) {
        this.logger.info(`Successfully updated device ${deviceId} settings`, LogContext.API);
        
        // Log full response in verbose mode
        if (this.logger.isVerboseEnabled()) {
          this.logger.verbose(`Update response: ${JSON.stringify(response)}`, LogContext.API);
        }
        
        // Reset consecutive errors on success
        this.consecutiveErrors = 0;
        
        return true;
      }
      
      return false;
    } catch (error) {
      this.handleApiError(`updateDeviceSettings(${deviceId})`, error);
      return false;
    }
  }

  /**
   * Update the device status cache optimistically based on settings changes
   * @param deviceId Device identifier
   * @param updates Status updates to apply
   */
  private updateCacheOptimistically(deviceId: string, updates: Partial<DeviceStatus>): void {
    // Get current cached status
    const cachedEntry = this.deviceStatusCache.get(deviceId);
    
    if (cachedEntry) {
      // Merge updates with current status
      const updatedStatus: DeviceStatus = {
        ...cachedEntry.status,
        ...updates
      };
      
      // Store updated status as optimistic
      this.deviceStatusCache.set(deviceId, {
        status: updatedStatus,
        timestamp: Date.now(),
        isOptimistic: true
      });
      
      this.logger.verbose(
        `Optimistically updated cache for device ${deviceId}: ` +
        `Power=${updatedStatus.powerState}, ` +
        `Target=${updatedStatus.targetTemperature}°C, ` +
        `Status=${updatedStatus.thermalStatus}`,
        LogContext.API
      );
    }
  }

  private async processQueue(): Promise<void> {
    // If already processing, exit
    if (this.processingQueue) {
        return;
    }
    
    this.processingQueue = true;
    
    try {
        while (this.requestQueue.length > 0) {
            // Check if we need to reset rate limit counter
            this.checkRateLimit();
            
            // Check if we're in backoff mode
            if (this.rateLimitBackoffUntil > Date.now()) {
                const backoffTimeRemaining = Math.ceil((this.rateLimitBackoffUntil - Date.now()) / 1000);
                this.logger.info(`In rate limit backoff mode for ${backoffTimeRemaining}s`, LogContext.API);
                break;
            }
            
            // Check if we've hit the rate limit
            if (this.requestsThisMinute >= MAX_REQUESTS_PER_MINUTE) {
                const resetTime = this.minuteStartTime + 60000;
                const waitTime = resetTime - Date.now();
                
                this.logger.info(
                    `Rate limit approached (${this.requestsThisMinute}/${MAX_REQUESTS_PER_MINUTE} requests), ` +
                    `waiting ${Math.ceil(waitTime / 1000)}s before continuing`,
                    LogContext.API
                );
                
                // Wait for rate limit reset
                setTimeout(() => this.processQueue(), waitTime + 1000);
                return;
            }
            
            // Check if we need to wait between requests
            const timeSinceLastRequest = Date.now() - this.lastRequestTime;
            if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
                const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
                
                // Only log this at verbose level to reduce noise - use the new method
                if (this.logger.isVerboseEnabled()) {
                    this.logger.verbose(`Waiting ${waitTime}ms between requests to prevent rate limiting`, LogContext.API);
                }
                
                // Wait for minimum interval
                setTimeout(() => this.processQueue(), waitTime);
                return;
            }
            
            // Get the next request with priority
            const request = this.getNextRequest();
            
            if (!request) {
                break;
            }
            
            // Mark the request as executing
            request.executing = true;
            
            try {
                // Update rate limiting counters
                this.requestsThisMinute++;
                this.lastRequestTime = Date.now();
                
                // Add auth token to request
                request.config.headers = {
                    ...(request.config.headers || {}),
                    Authorization: `Bearer ${this.apiToken}`
                };
                
                this.logger.verbose(
                    `Executing request ${request.id}: ${request.method} ${request.url}`,
                    LogContext.API
                );
                
                const startTime = Date.now();
                
                // Execute the request
                this.stats.totalRequests++;
                const response = await axios(request.config);
                this.stats.successfulRequests++;
                this.stats.lastRequest = new Date();
                
                // Track response time
                const responseTime = Date.now() - startTime;
                this.updateAverageResponseTime(responseTime);
                
                // Resolve the promise with the data
                request.resolve(response.data);
                
                this.logger.verbose(
                    `Request ${request.id} completed in ${responseTime}ms`,
                    LogContext.API
                );
                
                // Reset consecutive errors on success
                this.consecutiveErrors = 0;
            } catch (error) {
                const axiosError = error as AxiosError;
                
                this.stats.failedRequests++;
                this.stats.lastError = axiosError;
                
                // Handle rate limiting (HTTP 429)
                if (axiosError.response?.status === 429) {
                    // Implement backoff
                    this.consecutiveErrors++;
                    const backoffTime = Math.min(30000, 1000 * Math.pow(2, this.consecutiveErrors));
                    this.rateLimitBackoffUntil = Date.now() + backoffTime;
                    
                    this.logger.warn(
                        `Rate limit exceeded (429). Backing off for ${backoffTime / 1000}s`,
                        LogContext.API
                    );
                    
                    // Requeue the request
                    this.requestQueue.unshift({
                        ...request,
                        executing: false,
                        retryCount: request.retryCount + 1
                    });
                } else {
                    // For other errors, just reject
                    this.consecutiveErrors++;
                    request.reject(error);
                }
            } finally {
                // Remove request from queue
                this.removeRequest(request.id);
            }
        }
    } finally {
        this.processingQueue = false;
        
        // If there are still requests in the queue, continue processing
        if (this.requestQueue.length > 0) {
            // Small delay to prevent CPU spinning
            setTimeout(() => this.processQueue(), 100);
        }
    }
}

  /**
   * Check and reset rate limit counter if needed
   */
  private checkRateLimit(): void {
    const now = Date.now();
    
    // Reset rate limit counter if a minute has passed
    if (now - this.minuteStartTime >= 60000) {
      this.requestsThisMinute = 0;
      this.minuteStartTime = now;
      
      // If we've passed the backoff period, clear the rate limit flag
      if (now > this.rateLimitBackoffUntil) {
        this.rateLimitBackoffUntil = 0;
      }
      
      this.logger.debug('Resetting rate limit counter (1 minute has passed)', LogContext.API);
    }
  }

  /**
   * Get the next request from the queue, prioritizing by type and timestamp
   * @returns Next request to process or undefined if queue is empty
   */
  private getNextRequest(): QueuedRequest | undefined {
    // Skip requests that are already being executed
    const pendingRequests = this.requestQueue.filter(r => !r.executing);
    
    if (pendingRequests.length === 0) {
      return undefined;
    }
    
    // Prioritize requests by priority level
    const highPriorityRequests = pendingRequests.filter(r => r.priority === RequestPriority.HIGH);
    const normalPriorityRequests = pendingRequests.filter(r => r.priority === RequestPriority.NORMAL);
    const lowPriorityRequests = pendingRequests.filter(r => r.priority === RequestPriority.LOW);
    
    // First, try high priority requests
    if (highPriorityRequests.length > 0) {
      // Sort by timestamp (oldest first)
      return highPriorityRequests.sort((a, b) => a.timestamp - b.timestamp)[0];
    }
    
    // Then, try normal priority requests
    if (normalPriorityRequests.length > 0) {
      return normalPriorityRequests.sort((a, b) => a.timestamp - b.timestamp)[0];
    }
    
    // Finally, try low priority requests
    if (lowPriorityRequests.length > 0) {
      return lowPriorityRequests.sort((a, b) => a.timestamp - b.timestamp)[0];
    }
    
    return undefined;
  }

  /**
   * Remove a request from the queue
   * @param id Request ID
   */
  private removeRequest(id: string): void {
    const index = this.requestQueue.findIndex(r => r.id === id);
    
    if (index !== -1) {
      this.requestQueue.splice(index, 1);
    }
  }

  /**
   * Cancel pending requests of a specific type for a device
   * @param deviceId Device ID
   * @param operationType Type of operation to cancel
   */
  private cancelPendingRequests(deviceId: string, operationType: string): void {
    // Find requests to cancel
    const requestsToCancel = this.requestQueue.filter(r => 
      !r.executing && r.deviceId === deviceId && r.operationType === operationType
    );
    
    // Cancel each request
    for (const request of requestsToCancel) {
      this.logger.verbose(
        `Canceling pending ${request.operationType} request for device ${deviceId}`,
        LogContext.API
      );
      
      this.removeRequest(request.id);
      request.resolve(null); // Resolve with null rather than rejecting
    }
  }

  /**
   * Make a request to the SleepMe API
   * @param options Request options
   * @returns Promise resolving to response data
   */
  private async makeRequest<T>(options: {
    method: string;
    url: string;
    data?: any;
    priority?: RequestPriority;
    deviceId?: string;
    operationType?: string;
  }): Promise<T> {
    // Set default priority
    const priority = options.priority || RequestPriority.NORMAL;
    
    // Add detailed verbose logging for the request
    if (this.logger.isVerboseEnabled()) {
      this.logger.verbose(
        `API Request ${options.method} ${options.url} [${priority}]` + 
        (options.data ? ` with payload: ${JSON.stringify(options.data)}` : ''),
        LogContext.API
      );
    }
    
    // Wait for startup delay to complete for non-high priority requests
    if (priority !== RequestPriority.HIGH && !this.startupFinished) {
      await this.startupComplete;
    }
    
    // Return a new promise
    return new Promise<T>((resolve, reject) => {
      // Generate a unique ID for this request
      const requestId = `req_${++this.requestIdCounter}`;
      
      // Create request config
      const config: AxiosRequestConfig = {
        method: options.method,
        url: API_BASE_URL + options.url
      };
      
      // Add data if provided
      if (options.data) {
        config.data = options.data;
      }
      
      // API detail logging
      if (this.logger.isApiDetailEnabled()) {
        this.logger.apiDetail(`Creating request ${requestId}: ${JSON.stringify({
          method: options.method,
          url: options.url, 
          priority,
          deviceId: options.deviceId,
          operationType: options.operationType
        })}`);
      }
      
      // Add to queue
      this.requestQueue.push({
        id: requestId,
        config,
        priority,
        resolve,
        reject,
        retryCount: 0,
        timestamp: Date.now(),
        method: options.method,
        url: options.url,
        deviceId: options.deviceId,
        operationType: options.operationType
      });
      
      // Start processing the queue if not already running
      if (!this.processingQueue) {
        this.processQueue();
      }
    });
  }
  
  /**
   * Handle API errors with better logging
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
        // Log the full response data in verbose mode
        if (this.logger.isVerboseEnabled()) {
          this.logger.verbose(`Response error data: ${JSON.stringify(responseData)}`, LogContext.API);
        } else {
          this.logger.debug(`Response error data available (enable verbose logging to view)`, LogContext.API);
        }
      }
    } else {
      // Not an Axios error
      errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error in ${context}: ${errorMessage}`, LogContext.API);
    }
    
    // For API detail logging, include stack trace if available
    if (this.logger.isApiDetailEnabled() && error instanceof Error && error.stack) {
      this.logger.apiDetail(`Error stack trace: ${error.stack}`);
    }
  }
  
  /**
   * Update the average response time
   * @param newResponseTime New response time in milliseconds
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
   * @param data Object to extract from
   * @param paths Array of possible property paths
   * @param defaultValue Default value if not found
   * @returns Extracted temperature or default value
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
   * @param data API response data
   * @returns Thermal status
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
   * @param data API response data
   * @returns Power state
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
   * @param celsius Temperature in Celsius
   * @returns Temperature in Fahrenheit
   */
  private convertCtoF(celsius: number): number {
    return (celsius * 9/5) + 32;
  }

  /**
   * Convert Fahrenheit to Celsius
   * @param fahrenheit Temperature in Fahrenheit
   * @returns Temperature in Celsius
   */
  private convertFtoC(fahrenheit: number): number {
    return (fahrenheit - 32) * 5/9;
  }
}