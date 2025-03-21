/**
 * SleepMe Homebridge Platform
 * This is the main platform implementation that handles device discovery
 * and accessory management
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
import { EnhancedLogger, LogContext } from './utils/logger.js';
import { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_POLLING_INTERVAL } from './settings.js';

/**
 * SleepMe Platform
 * This class manages the plugin lifecycle, device discovery, and accessory management
 */
export class SleepMePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly scheduler: SleepMeScheduler;
  
  // Cached accessories
  public readonly accessories: PlatformAccessory[] = [];
  
  // API client
  public readonly api: SleepMeApi;
  
  // Enhanced logger
  public readonly log: EnhancedLogger;
  
  // Configuration options
  public readonly debugMode: boolean;
  public readonly pollingInterval: number;
  public readonly temperatureUnit: string;
  
  // Track managed accessories for cleanup
  private readonly accessoryInstances: Map<string, SleepMeAccessory> = new Map();
  
  // Timer for periodic discovery
  private discoveryTimer?: NodeJS.Timeout;
  
  // Startup phase tracking
  private isStartupPhase = true;
  private startupTimer?: NodeJS.Timeout;
  
  constructor(
    logger: Logger,
    public readonly config: PlatformConfig,
    public readonly homebridgeApi: API
  ) {
    // Initialize HomeKit service and characteristic references
    this.Service = this.homebridgeApi.hap.Service;
    this.Characteristic = this.homebridgeApi.hap.Characteristic;
    
    // Extract configuration options
    this.temperatureUnit = (config.unit as string) || 'C';
    
    // Set polling interval with proper validation
    // Use a longer interval by default to reduce API calls
    this.pollingInterval = Math.max(120, Math.min(600, 
      parseInt(String(config.pollingInterval)) || DEFAULT_POLLING_INTERVAL));
    
    // Set debug mode
    this.debugMode = config.debugMode === true;
    
    // Set up enhanced logger with correct debug mode
    this.log = new EnhancedLogger(logger, this.debugMode);
    
    // Validate API token
    if (!config.apiToken) {
      this.log.error('API token missing from configuration! The plugin will not work.', LogContext.PLATFORM);
      throw new Error('API token missing from configuration');
    }
    
    // Initialize API client
    this.api = new SleepMeApi(config.apiToken as string, this.log);
    
    // Initialize scheduler
    this.scheduler = new SleepMeScheduler(
      this.api,
      this.log,
      this.homebridgeApi.user.persistPath() // This gives the path where data can be stored
    );
    
    this.log.info(
      `Initializing ${PLATFORM_NAME} platform with ${this.temperatureUnit === 'C' ? 'Celsius' : 'Fahrenheit'} ` +
      `units and ${this.pollingInterval}s polling interval`, 
      LogContext.PLATFORM
    );
    
    // Mark the end of startup phase after 2 minutes
    this.startupTimer = setTimeout(() => {
      this.isStartupPhase = false;
      this.log.info('Exiting startup phase - regular operation begins', LogContext.PLATFORM);
    }, 120000); // 2 minutes
    
    // When this event is fired, homebridge has restored all cached accessories
    this.homebridgeApi.on('didFinishLaunching', () => {
      // Delay device discovery to prevent immediate API calls
      setTimeout(() => {
        this.log.info('Homebridge finished launching, starting device discovery', LogContext.PLATFORM);
        this.discoverDevices();
        
        // Further delay schedule initialization
        setTimeout(() => {
          this.initializeSchedules();
        }, 30000);
      }, 10000); // 10 second delay before starting discovery
      
      // Set up periodic discovery to catch new or changed devices
      // Reduced frequency to once per day instead of every 12 hours
      this.discoveryTimer = setInterval(() => {
        if (!this.isStartupPhase) { // Skip during startup phase
          this.discoverDevices();
        }
      }, 24 * 60 * 60 * 1000); // Check once per day
    });
    
    this.homebridgeApi.on('shutdown', () => {
      this.log.info('Shutting down platform', LogContext.PLATFORM);
      if (this.discoveryTimer) {
        clearInterval(this.discoveryTimer);
      }
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
      }
      
      // Clean up scheduler
      this.scheduler.cleanup();
    });
  }
  /**
   * Called when cached accessories are restored at startup
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`, LogContext.PLATFORM);
    
    // Validate device context
    if (!accessory.context.device || !accessory.context.device.id) {
      this.log.warn(
        `Cached accessory ${accessory.displayName} missing device ID, will rediscover`,
        LogContext.PLATFORM
      );
    } else {
      this.log.debug(`Cached accessory device ID: ${accessory.context.device.id}`, LogContext.PLATFORM);
    }
    
    // Store the accessory for later use
    this.accessories.push(accessory);
  }
  
  /**
   * Discover SleepMe devices and create accessories with staggered initialization
   */
  async discoverDevices(): Promise<void> {
    this.log.info('Starting device discovery...', LogContext.PLATFORM);
    
    try {
      // Get devices from the API
      const devices = await this.api.getDevices();
      
      if (!devices || devices.length === 0) {
        this.log.error(
          'No SleepMe devices found. Check your API token and connectivity.',
          LogContext.PLATFORM
        );
        return;
      }
      
      this.log.info(`Devices found: ${devices.length}`, LogContext.PLATFORM);
      
      // Track which accessories are still active
      const activeDeviceIds = new Set<string>();
      
      // Process each device with delays between initializations
      for (let i = 0; i < devices.length; i++) {
        const device = devices[i];
        
        if (!device.id) {
          this.log.warn(`Skipping device with missing ID: ${JSON.stringify(device)}`, LogContext.PLATFORM);
          continue;
        }
        
        // Stagger device initialization to prevent API rate limiting
        if (i > 0) {
          const staggerDelay = 20000 + Math.floor(Math.random() * 10000); // 20-30 second delay
          this.log.info(`Waiting ${Math.round(staggerDelay/1000)}s before initializing next device...`, LogContext.PLATFORM);
          await new Promise(resolve => setTimeout(resolve, staggerDelay));
        }
        
        activeDeviceIds.add(device.id);
        
        // Use device name directly from API
        const displayName = device.name;
        
        // Generate a unique id for this device
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
          
          // Update platform accessories
          this.homebridgeApi.updatePlatformAccessories([existingAccessory]);
          
          // Create new accessory handler with delay
          setTimeout(() => {
            this.initializeAccessory(existingAccessory, device.id);
          }, 3000); // 3 second delay
        } else {
          // Create a new accessory
          this.log.info(`Adding new accessory: ${displayName} (ID: ${device.id})`, LogContext.PLATFORM);
          
          const accessory = new this.homebridgeApi.platformAccessory(displayName, uuid);
          
          // Store device info in the accessory context
          accessory.context.device = device;
          
          // Initialize the accessory with delay
          setTimeout(() => {
            this.initializeAccessory(accessory, device.id);
          }, 3000); // 3 second delay
          
          // Register the accessory
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
   * Updated to connect scheduler events to the accessory
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
   */
  private createAccessoryHandler(accessory: PlatformAccessory, deviceId: string): void {
    // Create new accessory handler
    const handler = new SleepMeAccessory(this, accessory, this.api);
    
    // Listen for scheduled events from the scheduler
    this.scheduler.on('scheduledEventExecuted', (eventData: { deviceId: string, temperature: number, state: string }) => {
      if (eventData.deviceId === deviceId) {
        handler.handleScheduledEvent(eventData);
      }
    });
    
    // Store the handler for later cleanup
    this.accessoryInstances.set(deviceId, handler);
  }
  
  /**
   * Clean up accessories that are no longer available
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
   * Get devices for dynamic selection in config UI
   */
  async getDynamicDeviceIds(): Promise<{ id: string; name: string }[]> {
    this.log.info('Getting device list for config UI', LogContext.PLATFORM);
    
    try {
      const devices = await this.api.getDevices();
      return devices.map(device => ({
        id: device.id,
        name: device.name
      }));
    } catch (error) {
      this.log.error(
        `Error getting devices for config UI: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.PLATFORM
      );
      return [];
    }
  }
  /**
   * Initialize schedules from configuration
   * Modified to process schedules one by one with delays
   */
  private initializeSchedules(): void {
    const schedulerSettings = this.config.schedulerSettings;
    
    if (!schedulerSettings || !schedulerSettings.enabled) {
      this.log.info('Scheduler not enabled in config, skipping initialization', LogContext.PLATFORM);
      return;
    }
    
    this.log.info('Initializing schedules from config', LogContext.PLATFORM);
    
    try {
      // Process schedules one by one with delays
      if (Array.isArray(schedulerSettings.schedules)) {
        this.processScheduleQueue(schedulerSettings.schedules);
      }
    } catch (error) {
      this.log.error(
        `Error initializing schedules: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.PLATFORM
      );
    }
  }
  
  /**
   * Process schedules one by one with delays between them
   */
  private processScheduleQueue(schedules: any[], index = 0): void {
    if (index >= schedules.length) {
      this.log.info(`All schedules processed (${schedules.length} total)`, LogContext.PLATFORM);
      return;
    }
    
    const deviceSchedule = schedules[index];
    const deviceId = deviceSchedule.deviceId;
    
    if (!deviceId) {
      this.log.warn('Schedule missing device ID, skipping', LogContext.PLATFORM);
      // Continue with next schedule after delay
      setTimeout(() => this.processScheduleQueue(schedules, index + 1), 5000);
      return;
    }
    
    // Create schedule structure
    const schedule: DeviceSchedule = {
      deviceId,
      events: [],
      enabled: true
    };
    
    // Process schedule items
    if (Array.isArray(deviceSchedule.scheduleItems)) {
      for (const item of deviceSchedule.scheduleItems) {
        // Convert day type to day array
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
        }
        
        // Create event
        const event: ScheduledEvent = {
          id: `evt_${Math.random().toString(36).substring(2, 15)}`,
          enabled: true, // Default to enabled
          time: item.time,
          temperature: item.temperature,
          days,
          warmHug: item.warmHug || false,
          warmHugDuration: item.warmHugDuration || 20
        };
        
        schedule.events.push(event);
      }
    }
    
    // Set the schedule
    this.scheduler.setDeviceSchedule(schedule);
    this.log.info(`Initialized schedule for device ${deviceId} with ${schedule.events.length} events`, LogContext.PLATFORM);
    
    // Process next schedule after a delay
    setTimeout(() => this.processScheduleQueue(schedules, index + 1), 10000); // 10 second delay
  }
}
