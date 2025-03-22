/**
 * SleepMe Homebridge Platform
 * This is the main platform implementation that handles device discovery
 * and accessory management for SleepMe devices like ChiliPad, OOLER, and Dock Pro.
 * 
 * The platform serves as the central orchestrator, managing:
 * - Initial discovery of devices from the SleepMe API
 * - Creation and registration of HomeKit accessories
 * - Scheduling features for temperature control
 * - API communication and error handling
 */
import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service
} from 'homebridge';
import { SleepMeApi } from './api/sleepme-api.js';
import { SleepMeAccessory } from './accessory.js';
import { SleepMeScheduler, DeviceSchedule, ScheduledEvent } from './scheduler.js';
import { EnhancedLogger, LogContext, LogLevelString } from './utils/logger.js';
import { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_POLLING_INTERVAL } from './settings.js';

/**
 * SleepMe Platform
 * This class is the entry point for the plugin and manages the plugin lifecycle
 */
export class SleepMePlatform implements DynamicPlatformPlugin {
  // References to Homebridge services and characteristics for accessory creation
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  
  // Scheduler instance to manage temperature scheduling
  public readonly scheduler: SleepMeScheduler;
  
  // Array to store cached accessories from Homebridge
  public readonly accessories: PlatformAccessory[] = [];
  
  // API client for communicating with SleepMe services
  public readonly api: SleepMeApi;
  
  // Enhanced logger for better debugging and error reporting
  public readonly log: EnhancedLogger;
  
  /**
   * Configuration options parsed from config.json
   */
  public readonly logLevel: LogLevelString;
  public readonly debugMode: boolean = false;
  public readonly pollingInterval: number;
  public readonly temperatureUnit: string = 'C';
  
  // Map to track active accessory instances for proper cleanup
  private readonly accessoryInstances: Map<string, SleepMeAccessory> = new Map();
  
  // Timer for periodic device discovery
  private discoveryTimer?: NodeJS.Timeout;
  
  /**
   * Constructor for the SleepMe platform.
   * Initializes the platform with configuration from Homebridge
   * 
   * @param logger - Homebridge logger instance
   * @param config - Configuration from config.json
   * @param homebridgeApi - Reference to the Homebridge API
   */
  constructor(
    logger: Logger,
    public readonly config: PlatformConfig,
    public readonly homebridgeApi: API
  ) {
    // Store references to Homebridge services and characteristics
    this.Service = this.homebridgeApi.hap.Service;
    this.Characteristic = this.homebridgeApi.hap.Characteristic;
    
    // Parse configuration options with defaults and validation
    this.temperatureUnit = (config.unit as string) || 'C';

    // Set polling interval with minimum and maximum bounds for safety
    this.pollingInterval = Math.max(30, Math.min(900, 
      parseInt(String(config.pollingInterval)) || DEFAULT_POLLING_INTERVAL));

    // Handle log level determination
    if (typeof config.logLevel === 'string') {
      // Validate and type-cast the log level
      this.logLevel = ['normal', 'debug', 'verbose', 'api_detail'].includes(config.logLevel) 
        ? (config.logLevel as LogLevelString) 
        : 'normal';
    } else {
      // Legacy configuration - check boolean flags
      this.debugMode = config.debugMode === true;
      const verboseLogging = config.verboseLogging === true;
      
      // Set log level based on legacy flags
      this.logLevel = verboseLogging ? 'verbose' : (this.debugMode ? 'debug' : 'normal');
    }
    
    // Initialize the logger with the determined log level
    this.log = new EnhancedLogger(logger, this.logLevel, true);
    
    // Log platform initialization with full config
    this.log.verbose(
      `Platform configuration: ${JSON.stringify({
        temperatureUnit: this.temperatureUnit,
        pollingInterval: this.pollingInterval,
        logLevel: this.logLevel,
        enableScheduling: config.enableScheduling || false,
        scheduleCount: config.schedules ? (config.schedules as any[]).length : 0
      })}`,
      LogContext.PLATFORM
    );
    
    // Validate that the API token is present in the configuration
    if (!config.apiToken) {
      this.log.error('API token missing from configuration! The plugin will not work.', LogContext.PLATFORM);
      throw new Error('API token missing from configuration');
    }
    
    // Initialize the SleepMe API client with the provided token
    this.api = new SleepMeApi(config.apiToken as string, this.log);
    
    // Initialize the scheduler for temperature scheduling features
    this.scheduler = new SleepMeScheduler(
      this.api,
      this.log,
      this.homebridgeApi.user.persistPath() // Storage path for persistent data
    );
    
    // Log platform initialization information
    this.log.info(
      `Initializing ${PLATFORM_NAME} platform with ${this.temperatureUnit === 'C' ? 'Celsius' : 'Fahrenheit'} ` +
      `units and ${this.pollingInterval}s polling interval`, 
      LogContext.PLATFORM
    );
    
    // Register for Homebridge events
    
    // When this event is fired, homebridge has restored all cached accessories
    this.homebridgeApi.on('didFinishLaunching', () => {
      // Delay device discovery to prevent immediate API calls on startup
      setTimeout(() => {
        this.log.info('Homebridge finished launching, starting device discovery', LogContext.PLATFORM);
        this.discoverDevices();
        
        // Further delay schedule initialization to prevent overloading the API
        setTimeout(() => {
          this.initializeSchedules();
        }, 60000); // 60 second delay before initializing schedules
      }, 15000); // 15 second delay before starting discovery
      
      // Set up periodic discovery to catch new or changed devices
      // Reduced frequency to once per day to prevent excessive API usage
      this.discoveryTimer = setInterval(() => {
        this.discoverDevices();
      }, 24 * 60 * 60 * 1000); // Check once per day
    });
    
    // Handle Homebridge shutdown event for proper cleanup
    this.homebridgeApi.on('shutdown', () => {
      this.log.info('Shutting down platform', LogContext.PLATFORM);
      
      // Clear discovery timer
      if (this.discoveryTimer) {
        clearInterval(this.discoveryTimer);
      }
      
      // Clean up scheduler resources
      this.scheduler.cleanup();
      
      // Clean up accessory resources
      this.accessoryInstances.forEach(accessory => {
        accessory.cleanup();
      });
    });
  }

  /**
   * Called by Homebridge when cached accessories are restored at startup
   * This allows us to reconfigure accessories that were cached by Homebridge
   * 
   * @param accessory - The cached accessory to configure
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`, LogContext.PLATFORM);
    
    // Validate that the device context is intact
    if (!accessory.context.device || !accessory.context.device.id) {
      this.log.warn(
        `Cached accessory ${accessory.displayName} missing device ID, will rediscover`,
        LogContext.PLATFORM
      );
    } else {
      this.log.debug(`Cached accessory device ID: ${accessory.context.device.id}`, LogContext.PLATFORM);
      
      // Log the full accessory context in verbose mode
      if (this.log.isVerboseEnabled()) {
        this.log.verbose(
          `Accessory context: ${JSON.stringify(accessory.context)}`,
          LogContext.PLATFORM
        );
      }
    }
    
    // Store the accessory in our array for later use
    this.accessories.push(accessory);
  }
  
  /**
   * Discover SleepMe devices and create HomeKit accessories
   * Uses staggered initialization to prevent API rate limiting
   */
  async discoverDevices(): Promise<void> {
    this.log.info('Starting device discovery...', LogContext.PLATFORM);
    
    try {
      // Check if devices are configured directly in config.json
      let devices = [];
      const configuredDevices = this.config.devices as Array<{id: string, name: string}> || [];
      
      if (configuredDevices && configuredDevices.length > 0) {
        // Use the devices from config instead of making an API call
        this.log.info(`Using ${configuredDevices.length} devices from configuration`, LogContext.PLATFORM);
        
        // Log configured devices in verbose mode
        if (this.log.isVerboseEnabled()) {
          configuredDevices.forEach((device, index) => {
            this.log.verbose(`Configured device ${index + 1}: ID=${device.id}, Name=${device.name || 'Unnamed'}`, LogContext.PLATFORM);
          });
        }
        
        // Map config devices to the format expected by the rest of the code
        devices = configuredDevices.map(device => ({
          id: device.id,
          name: device.name || `SleepMe Device (${device.id})`, // Default name if not specified
          attachments: [] // Add required fields with default values
        }));
      } else {
        // Fetch devices from the API if none configured manually
        this.log.info('No devices in configuration, fetching from API...', LogContext.PLATFORM);
        
        devices = await this.api.getDevices();
        
        if (!devices || devices.length === 0) {
          this.log.error(
            'No SleepMe devices found. Check your API token and connectivity.',
            LogContext.PLATFORM
          );
          return;
        }
      }
      
      this.log.info(`Devices to initialize: ${devices.length}`, LogContext.PLATFORM);
      
      // Track which accessories are still active to support removal of stale accessories
      const activeDeviceIds = new Set<string>();
      
      // Process each device with staggered initialization to prevent API rate limiting
      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        
        // Skip devices with missing IDs
        if (!device.id) {
          this.log.warn(`Skipping device with missing ID: ${JSON.stringify(device)}`, LogContext.PLATFORM);
          continue;
        }
        
        // Stagger device initialization to prevent API rate limiting
        if (i > 0) {
          const staggerDelay = 30000 + Math.floor(Math.random() * 15000); // 30-45 second delay
          this.log.info(`Waiting ${Math.round(staggerDelay/1000)}s before initializing next device...`, LogContext.PLATFORM);
          await new Promise(resolve => setTimeout(resolve, staggerDelay));
        }
        
        // Mark this device ID as active
        activeDeviceIds.add(device.id);
        
        // Use device name from API or config
        const displayName = device.name;
        
        // Generate a unique identifier for this device in HomeKit
        const uuid = this.homebridgeApi.hap.uuid.generate(device.id);
        
        // Check if we already have an accessory for this device
        const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);
        if (existingAccessory) {
          // The accessory already exists, just update its context
          this.log.info(
            `Restoring accessory from cache: ${existingAccessory.displayName} (ID: ${device.id})`,
            LogContext.PLATFORM
          );
          
          // Update context and display name if needed
          existingAccessory.context.device = device;
          if (existingAccessory.displayName !== displayName) {
            existingAccessory.displayName = displayName;
            this.log.debug(`Updated accessory name to: ${displayName}`, LogContext.PLATFORM);
          }
          
          // Update platform accessories in Homebridge
          this.homebridgeApi.updatePlatformAccessories([existingAccessory]);
          
          // Initialize the accessory handler with a delay to prevent API overload
          setTimeout(() => {
            this.initializeAccessory(existingAccessory, device.id);
          }, 3000); // 3 second delay
        } else {
          // Create a new accessory since one doesn't exist
          this.log.info(`Adding new accessory: ${displayName} (ID: ${device.id})`, LogContext.PLATFORM);
          
          const accessory = new this.homebridgeApi.platformAccessory(displayName, uuid);
          
          // Store device info in the accessory context
          accessory.context.device = device;
          
          // Initialize the accessory with delay to prevent API overload
          setTimeout(() => {
            this.initializeAccessory(accessory, device.id);
          }, 3000); // 3 second delay
          
          // Register the accessory with Homebridge
          this.homebridgeApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.push(accessory);
        }
      }
      
      // Remove accessories that no longer exist
      this.cleanupInactiveAccessories(activeDeviceIds);
      
      this.log.info('Device discovery completed', LogContext.PLATFORM);
    } catch (error) {
      this.log.error(
        `Error discovering devices: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.PLATFORM
      );
    }
  }
  
  /**
   * Initialize an accessory with its handler
   * Handles connecting scheduler events to the accessory
   * 
   * @param accessory - The platform accessory to initialize
   * @param deviceId - The device ID for this accessory
   */
  private initializeAccessory(accessory: PlatformAccessory, deviceId: string): void {
    this.log.info(`Initializing accessory for device ID: ${deviceId}`, LogContext.PLATFORM);
    
    // First, remove any existing handler for this accessory
    const existingHandler = this.accessoryInstances.get(deviceId);
    if (existingHandler) {
      existingHandler.cleanup();
      this.accessoryInstances.delete(deviceId);
      
      // Add a small delay before creating the new handler
      setTimeout(() => {
        this.createAccessoryHandler(accessory, deviceId);
      }, 5000);
    } else {
      // Create handler immediately if no existing one
      this.createAccessoryHandler(accessory, deviceId);
    }
  }
  
  /**
   * Create a new accessory handler
   * 
   * @param accessory - The platform accessory to create a handler for
   * @param deviceId - The device ID for this accessory
   */
  private createAccessoryHandler(accessory: PlatformAccessory, deviceId: string): void {
    // Create new accessory handler
    const handler = new SleepMeAccessory(this, accessory, this.api);
    
    // Connect the handler to scheduler events
    this.scheduler.on('scheduledEventExecuted', (eventData: { deviceId: string, temperature: number, state: string }) => {
      if (eventData.deviceId === deviceId) {
        this.log.verbose(
          `Scheduler event executed: ${JSON.stringify(eventData)}`, 
          LogContext.SCHEDULER
        );
        handler.handleScheduledEvent(eventData);
      }
    });
    
    // Store the handler for later cleanup
    this.accessoryInstances.set(deviceId, handler);
    
    this.log.verbose(`Accessory handler created for device ${deviceId}`, LogContext.PLATFORM);
  }
  
  /**
   * Clean up accessories that are no longer active
   * Removes accessories from Homebridge that don't match active device IDs
   * 
   * @param activeDeviceIds - Set of active device IDs
   */
  private cleanupInactiveAccessories(activeDeviceIds: Set<string>): void {
    // Find accessories to remove - those not in the active devices list
    const accessoriesToRemove = this.accessories.filter(accessory => {
      const deviceId = accessory.context.device?.id;
      return deviceId && !activeDeviceIds.has(deviceId);
    });
    
    if (accessoriesToRemove.length > 0) {
      this.log.info(`Removing ${accessoriesToRemove.length} inactive accessories`, LogContext.PLATFORM);
      
      // Clean up each accessory
      for (const accessory of accessoriesToRemove) {
        const deviceId = accessory.context.device?.id;
        if (deviceId) {
          // Clean up handler if it exists
          const handler = this.accessoryInstances.get(deviceId);
          if (handler) {
            handler.cleanup();
            this.accessoryInstances.delete(deviceId);
          }
          
          // Remove from accessories array
          const index = this.accessories.indexOf(accessory);
          if (index !== -1) {
            this.accessories.splice(index, 1);
          }
        }
        
        this.log.info(`Removing inactive accessory: ${accessory.displayName}`, LogContext.PLATFORM);
      }
      
      // Unregister from Homebridge
      this.homebridgeApi.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        accessoriesToRemove
      );
    }
  }
  
  /**
   * Initialize temperature schedules from configuration
   * Creates schedules based on the config.json settings
   */
  private initializeSchedules(): void {
    // Check if scheduling is enabled in configuration
    const enableScheduling = this.config.enableScheduling === true;
    const schedules = this.config.schedules as Array<any> || [];
    
    if (!enableScheduling || !schedules || schedules.length === 0) {
      this.log.info('Scheduler not enabled in config or no schedules defined, skipping initialization', LogContext.PLATFORM);
      return;
    }
    
    this.log.info('Initializing schedules from config', LogContext.PLATFORM);
    
    // Log all schedules in verbose mode
    if (this.log.isVerboseEnabled()) {
      this.log.verbose(`Schedule config: ${JSON.stringify(schedules)}`, LogContext.PLATFORM);
    }
    
    try {
      // Get device IDs from either configured devices or cached accessories
      const deviceIds: string[] = [];
      
      // Process device-specific schedules or apply to all devices
      const configuredDevices = this.config.devices as Array<{id: string}> || [];
      
      // If no devices are configured, get them from the cached accessories
      if (configuredDevices.length === 0) {
        this.accessories.forEach(accessory => {
          const deviceId = accessory.context.device?.id;
          if (deviceId) {
            deviceIds.push(deviceId);
          }
        });
      } else {
        // Use configured devices
        configuredDevices.forEach(device => {
          if (device.id) {
            deviceIds.push(device.id);
          }
        });
      }
      
      this.log.verbose(`Setting up schedules for ${deviceIds.length} devices`, LogContext.PLATFORM);
      
      // Create schedules for each device with staggered timing to prevent API overload
      deviceIds.forEach((deviceId, index) => {
        // Add delay between initializing schedules for different devices
        setTimeout(() => {
          this.createDeviceSchedule(deviceId, schedules);
        }, index * 20000); // 20 second delay between devices
      });
    } catch (error) {
      this.log.error(
        `Error initializing schedules: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.PLATFORM
      );
    }
  }
  
  /**
   * Create a schedule for a specific device
   * 
   * @param deviceId - The device ID to create a schedule for
   * @param schedules - Array of schedule configurations
   */
  private createDeviceSchedule(deviceId: string, schedules: any[]): void {
    this.log.info(`Creating schedule for device ${deviceId}`, LogContext.PLATFORM);
    
    // Create the schedule structure
    const schedule: DeviceSchedule = {
      deviceId,
      events: [],
      enabled: true
    };
    
    // Process each schedule item from configuration
    for (const item of schedules) {
      // Convert day type to array of day numbers (0-6, where 0 is Sunday)
      let days: number[] = [];
      switch (item.dayType) {
        case 'everyday':
          days = [0, 1, 2, 3, 4, 5, 6]; // All days
          break;
        case 'weekday':
          days = [1, 2, 3, 4, 5]; // Monday to Friday
          break;
        case 'weekend':
          days = [0, 6]; // Sunday and Saturday
          break;
        case 'specific':
          // Convert string to number for specific day
          days = [parseInt(item.specificDay, 10)];
          break;
        default:
          days = [0, 1, 2, 3, 4, 5, 6]; // Default to all days
      }
      
      // Create the scheduled event
      const event: ScheduledEvent = {
        id: `evt_${Math.random().toString(36).substring(2, 15)}`, // Generate a random ID
        enabled: true, // Default to enabled
        time: item.time,
        temperature: item.temperature,
        days,
        warmHug: item.warmHug || false,
        warmHugDuration: parseInt(item.warmHugDuration || '20', 10)
      };
      
      // Log event details in verbose mode
      this.log.verbose(
        `Adding schedule event: time=${event.time}, temp=${event.temperature}°C, ` +
        `days=[${event.days.join(',')}], warmHug=${event.warmHug}`,
        LogContext.PLATFORM
      );
      
      schedule.events.push(event);
    }
    
    // Set the schedule if it has events
    if (schedule.events.length > 0) {
      this.scheduler.setDeviceSchedule(schedule);
      this.log.info(`Initialized schedule for device ${deviceId} with ${schedule.events.length} events`, LogContext.PLATFORM);
    }
  }
  
  /**
   * Check if verbose logging is enabled
   * Utility methods for components to check without verbose string concatenation
   */
  public isVerboseLoggingEnabled(): boolean {
    return this.log.isVerboseEnabled();
  }

  /**
   * Check if detailed API logging is enabled
   */
  public isDetailLoggingEnabled(): boolean {
    return this.log.isApiDetailEnabled();
  }
}