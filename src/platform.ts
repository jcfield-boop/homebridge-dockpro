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
  import { EnhancedLogger, LogContext } from './utils/logger.js';
  import { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_POLLING_INTERVAL } from './settings.js';
  
  /**
   * SleepMe Platform
   * This class manages the plugin lifecycle, device discovery, and accessory management
   */
  export class SleepMePlatform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service;
    public readonly Characteristic: typeof Characteristic;
    
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
    
    constructor(
      logger: Logger,
      public readonly config: PlatformConfig,
      public readonly homebridgeApi: API
    ) {
      // Initialize HomeKit service and characteristic references
      this.Service = this.homebridgeApi.hap.Service;
      this.Characteristic = this.homebridgeApi.hap.Characteristic;
      
      // Set up enhanced logger
      this.debugMode = config.debugMode === true;
      this.log = new EnhancedLogger(logger, this.debugMode);
      
     // Extract configuration options
this.temperatureUnit = (config.unit as string) || 'C';

// Safely access advanced options with fallbacks
const advanced = config.advanced || {};
this.debugMode = advanced.debugMode === true;
this.pollingInterval = Math.max(30, Math.min(300, 
  (advanced.pollingInterval as number) || DEFAULT_POLLING_INTERVAL));
  
      // Validate API token
      if (!config.apiToken) {
        this.log.error('API token missing from configuration! The plugin will not work.', LogContext.PLATFORM);
        throw new Error('API token missing from configuration');
      }
      
      // Initialize API client
      this.api = new SleepMeApi(config.apiToken as string, this.log);
      
      this.log.info(
        `Initializing ${PLATFORM_NAME} platform with ${this.temperatureUnit === 'C' ? 'Celsius' : 'Fahrenheit'} ` +
        `units and ${this.pollingInterval}s polling interval`, 
        LogContext.PLATFORM
      );
      
      // When this event is fired, homebridge has restored all cached accessories
      this.homebridgeApi.on('didFinishLaunching', () => {
        this.log.info('Homebridge finished launching, starting device discovery', LogContext.PLATFORM);
        this.discoverDevices();
        
        // Set up periodic discovery to catch new or changed devices
        this.discoveryTimer = setInterval(() => {
          this.discoverDevices();
        }, 12 * 60 * 60 * 1000); // Check every 12 hours
      });
      
      // Clean up on shutdown
      this.homebridgeApi.on('shutdown', () => {
        this.log.info('Shutting down platform', LogContext.PLATFORM);
        if (this.discoveryTimer) {
          clearInterval(this.discoveryTimer);
        }
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
     * Discover SleepMe devices and create accessories
     */
    async discoverDevices(): Promise<void> {
      this.log.info('Starting device discovery...', LogContext.PLATFORM);
      
      try {
        // Test API connection
        const connectionTest = await this.api.testConnection();
        if (!connectionTest) {
          this.log.error('API connection test failed, skipping device discovery', LogContext.PLATFORM);
          return;
        }
        
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
// Process each device
for (const device of devices) {
  if (!device.id) {
    this.log.warn(`Skipping device with missing ID: ${JSON.stringify(device)}`, LogContext.PLATFORM);
    continue;
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
    
    // Create new accessory handler
    this.initializeAccessory(existingAccessory, device.id);
  } else {
    // Create a new accessory
    this.log.info(`Adding new accessory: ${displayName} (ID: ${device.id})`, LogContext.PLATFORM);
    
    const accessory = new this.homebridgeApi.platformAccessory(displayName, uuid);
    
    // Store device info in the accessory context
    accessory.context.device = device;
    
    // Initialize the accessory
    this.initializeAccessory(accessory, device.id);
    
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
     */
    private initializeAccessory(accessory: PlatformAccessory, deviceId: string): void {
      this.log.info(`Initializing accessory for device ID: ${deviceId}`, LogContext.PLATFORM);
      
      // First, remove any existing handler for this accessory
      const existingHandler = this.accessoryInstances.get(deviceId);
      if (existingHandler) {
        existingHandler.cleanup();
        this.accessoryInstances.delete(deviceId);
      }
      
      // Create new accessory handler
      const handler = new SleepMeAccessory(this, accessory, this.api);
      
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
  }
  