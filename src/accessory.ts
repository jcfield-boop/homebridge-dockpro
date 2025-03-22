/**
 * SleepMe Thermostat Accessory
 * This class handles the HomeKit thermostat interface and communicates
 * with the SleepMe device via the API client
 */
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SleepMePlatform } from './platform.js';
import { SleepMeApi } from './api/sleepme-api.js';
import { ThermalStatus, PowerState } from './api/types.js';
import { LogContext } from './utils/logger.js';
import { MIN_TEMPERATURE_C, MAX_TEMPERATURE_C, TEMPERATURE_STEP } from './settings.js';

/**
 * SleepMe Thermostat Accessory
 * This class manages the HomeKit thermostat interface for a SleepMe device.
 */
export class SleepMeAccessory {
  // HomeKit services
  private service: Service;
  private informationService: Service;
  private waterLevelService?: Service;
  
  // Device state - initialize with NaN to indicate uninitialized state
  private currentTemperature = NaN;
  private targetTemperature = NaN;
  private currentHeatingState = 0; // OFF
  private targetHeatingState = 3;  // AUTO - Initialize to AUTO mode
  private firmwareVersion = 'Unknown';
  private waterLevel = 100; // Default full water level
  private isWaterLow = false;
  // Add this with the other class property declarations
private lastTemperatureSetTime = 0;
  
  // Device properties
  private readonly deviceId: string;
  private readonly displayName: string;
  private deviceModel = 'SleepMe Device';
  
  // Update control
  private isUpdating = false;
  private lastUpdateTime = 0;
  private statusUpdateTimer?: NodeJS.Timeout;
  private pendingUpdates = false;
  private scheduleTimer?: NodeJS.Timeout;
  
  // Constants from the platform
  private readonly Characteristic;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly apiClient: SleepMeApi
  ) {
    // Store references to Characteristic for convenience
    this.Characteristic = this.platform.Characteristic;
    
    // Get device ID from accessory context
    this.deviceId = this.accessory.context.device?.id || '';
    this.displayName = this.accessory.displayName;
    
    if (!this.deviceId) {
      this.platform.log.error(`Accessory missing device ID: ${this.displayName}`, LogContext.ACCESSORY);
      throw new Error(`Accessory missing device ID: ${this.displayName}`);
    }
    
    this.platform.log.verbose(`Creating accessory for device ${this.deviceId} (${this.displayName})`, LogContext.ACCESSORY);
    
    // Set accessory information with default values
    // These will be properly updated when we get device status
    this.informationService = this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'Sleepme Inc.')
      .setCharacteristic(this.Characteristic.Model, this.deviceModel)
      .setCharacteristic(this.Characteristic.SerialNumber, this.deviceId)
      .setCharacteristic(this.Characteristic.FirmwareRevision, this.firmwareVersion);
  
    // Get or create the thermostat service
    this.service = this.accessory.getService(this.platform.Service.Thermostat) || 
      this.accessory.addService(this.platform.Service.Thermostat, this.displayName);
      
    // Set up required thermostat characteristics
    
    // Current Temperature
    this.service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));
  
    // Target Temperature - allow changes in any state
    this.service.getCharacteristic(this.Characteristic.TargetTemperature)
      .setProps({
        minValue: MIN_TEMPERATURE_C,
        maxValue: MAX_TEMPERATURE_C,
        minStep: TEMPERATURE_STEP,
      })
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));
  
    // Current Heating/Cooling State
    this.service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingStateGet.bind(this));
  
    // Target Heating/Cooling State - LIMIT TO JUST OFF (0) and AUTO (3)
    this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          this.Characteristic.TargetHeatingCoolingState.OFF,
          this.Characteristic.TargetHeatingCoolingState.AUTO
        ]
      })
      .onGet(this.handleTargetHeatingStateGet.bind(this))
      .onSet(this.handleTargetHeatingStateSet.bind(this));
  
    // Temperature Display Units
    const displayUnits = this.platform.temperatureUnit === 'C' 
      ? this.Characteristic.TemperatureDisplayUnits.CELSIUS
      : this.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  
    this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
      .updateValue(displayUnits)
      .onGet(() => displayUnits);
  
    // Set the initial state to AUTO
    this.service.updateCharacteristic(
      this.Characteristic.TargetHeatingCoolingState,
      this.Characteristic.TargetHeatingCoolingState.AUTO
    );
    
    // Initialize the device state
    this.refreshDeviceStatus(true)  // Pass true to indicate this is the initial setup
      .catch(error => this.platform.log.error(
        `Error initializing device status: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.ACCESSORY
      ));
  
    // Set up polling interval
    this.setupStatusPolling();
  
    // Set up schedule polling
    this.setupSchedulePolling();
  
    this.platform.log.info(`Accessory initialized: ${this.displayName} (ID: ${this.deviceId})`, LogContext.ACCESSORY);
  }

  /**
   * Set up the status polling mechanism with smart interval adjustments
   * This implementation reduces API load and adapts to device state
   */
  private setupStatusPolling(): void {
    // Clear any existing timer
    if (this.statusUpdateTimer) {
      clearInterval(this.statusUpdateTimer);
    }
    
    // Convert polling interval from seconds to milliseconds
    const intervalMs = this.platform.pollingInterval * 1000;
    
    this.platform.log.verbose(
      `Setting up status polling every ${this.platform.pollingInterval} seconds for device ${this.deviceId}`,
      LogContext.ACCESSORY
    );
    
    // Initial poll right away
    this.refreshDeviceStatus().catch(error => {
      this.platform.log.error(
        `Error in initial status update: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.ACCESSORY
      );
    });
    
    // Set up regular polling
    this.statusUpdateTimer = setInterval(() => {
      this.refreshDeviceStatus().catch(error => {
        this.platform.log.error(
          `Error updating device status: ${error instanceof Error ? error.message : String(error)}`,
          LogContext.ACCESSORY
        );
      });
    }, intervalMs);
    
    this.platform.log.debug(
      `Polling scheduled every ${this.platform.pollingInterval} seconds`,
      LogContext.ACCESSORY
    );
  }

  /**
   * Set up the schedule polling mechanism
   */
  private setupSchedulePolling(): void {
    // Check schedule status every 30 seconds
    this.scheduleTimer = setInterval(() => {
      const schedulerStatus = this.platform.scheduler.getSchedulerStatus(this.deviceId);
      
      // Log next scheduled event if available
      if (schedulerStatus.nextEvent) {
        this.platform.log.verbose(
          `Next scheduled event: ${schedulerStatus.nextEvent.time} ` +
          `(${schedulerStatus.nextEvent.temperature}°C, in ${schedulerStatus.nextEvent.minutesUntil} minutes)`,
          LogContext.ACCESSORY
        );
      }
      
      // Log active warm hug if available
      if (schedulerStatus.activeWarmHug) {
        this.platform.log.verbose(
          `Active warm hug: Step ${schedulerStatus.activeWarmHug.currentStep}/` +
          `${schedulerStatus.activeWarmHug.totalSteps} to ${schedulerStatus.activeWarmHug.targetTemp}°C ` +
          `by ${schedulerStatus.activeWarmHug.targetTime}`,
          LogContext.ACCESSORY
        );
      }
    }, 30000);
  }

  /**
   * Log device connection status
   */
  private logConnectionStatus(connected: boolean): void {
    // Just log the status change
    if (!connected) {
      this.platform.log.warn(
        `Device ${this.deviceId} appears to be offline or unreachable`,
        LogContext.ACCESSORY
      );
    } else {
      this.platform.log.debug(
        `Device ${this.deviceId} is online and reachable`,
        LogContext.ACCESSORY
      );
    }
  }

  /**
   * Update or create the water level service
   * Maps water level data to a Battery service in HomeKit
   */
  private updateWaterLevelService(waterLevel: number, isWaterLow: boolean): void {
    // Only create/update if we have valid water level data
    if (waterLevel !== undefined) {
      // Get or create water level service (using Battery service as proxy)
      if (!this.waterLevelService) {
        this.waterLevelService = this.accessory.getService(this.platform.Service.Battery) ||
                               this.accessory.addService(this.platform.Service.Battery, 'Water Level');
        
        // Set proper name characteristic for display in HomeKit
        this.waterLevelService.setCharacteristic(
          this.Characteristic.Name,
          'Water Level'
        );
        
        this.platform.log.info(
          `Created water level service for device ${this.deviceId}`,
          LogContext.ACCESSORY
        );
      }
      
      // Update water level (as battery percentage)
      this.waterLevelService.updateCharacteristic(
        this.Characteristic.BatteryLevel,
        waterLevel
      );
      
      // Update low water status (as low battery status)
      this.waterLevelService.updateCharacteristic(
        this.Characteristic.StatusLowBattery,
        isWaterLow ? 1 : 0
      );

      // Set charging state to "Not Charging" since it's not applicable
      this.waterLevelService.updateCharacteristic(
        this.Characteristic.ChargingState,
        this.Characteristic.ChargingState.NOT_CHARGING
      );
      
      // Log water level status if low
      if (isWaterLow) {
        this.platform.log.warn(
          `Water level low on device ${this.deviceId}: ${waterLevel}%`,
          LogContext.ACCESSORY
        );
      } else {
        this.platform.log.verbose(
          `Water level updated to ${waterLevel}%`,
          LogContext.ACCESSORY
        );
      }
    }
  }
  /**
   * Detect device model based on attachments or other characteristics
   * Enhanced to better identify device models and improve HomeKit display
   */
  private detectDeviceModel(data: Record<string, any>): string {
    // First check attachments which is most reliable
    const attachments = this.apiClient.extractNestedValue(data, 'attachments');
    
    if (Array.isArray(attachments) && attachments.length > 0) {
      this.platform.log.verbose(
        `Device attachments: ${JSON.stringify(attachments)}`,
        LogContext.ACCESSORY
      );
      
      if (attachments.includes('CHILIPAD_PRO')) {
        return 'ChiliPad Pro';
      } else if (attachments.includes('OOLER')) {
        return 'OOLER Sleep System';
      } else if (attachments.includes('DOCK_PRO')) {
        return 'Dock Pro';
      }
      
      // If there are attachments but none match known types, log them for debugging
      this.platform.log.debug(
        `Unknown device attachments: ${attachments.join(', ')}`,
        LogContext.ACCESSORY
      );
    }
    
    // Next check model field directly
    const model = this.apiClient.extractNestedValue(data, 'about.model') || 
                 this.apiClient.extractNestedValue(data, 'model');
    
    if (model) {
      this.platform.log.debug(`Device reports model: ${model}`, LogContext.ACCESSORY);
      
      if (typeof model === 'string') {
        if (model.includes('DP')) {
          return 'Dock Pro';
        } else if (model.includes('OL')) {
          return 'OOLER Sleep System';
        } else if (model.includes('CP')) {
          return 'ChiliPad';
        }
        
        // Return the raw model string if no specific type is detected
        return `SleepMe ${model}`;
      }
    }
    
    // Check firmware version for clues
    const firmware = this.apiClient.extractNestedValue(data, 'about.firmware_version') ||
                    this.apiClient.extractNestedValue(data, 'firmware_version');
    
    if (firmware) {
      if (firmware.toString().startsWith('5.')) {
        return 'Dock Pro'; // Dock Pro typically uses firmware v5.x
      } else if (firmware.toString().startsWith('4.')) {
        return 'OOLER Sleep System'; // OOLER typically uses firmware v4.x
      } else if (firmware.toString().startsWith('3.')) {
        return 'ChiliPad'; // ChiliPad typically uses firmware v3.x
      }
    }
    
    // Default if we can't determine
    return 'SleepMe Device';
  }

  /**
   * Clean up resources when this accessory is removed
   */
  public cleanup(): void {
    if (this.statusUpdateTimer) {
      clearInterval(this.statusUpdateTimer);
      this.statusUpdateTimer = undefined;
    }
    
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    
    this.platform.log.info(`Cleaned up accessory: ${this.displayName}`, LogContext.ACCESSORY);
  }

  /**
   * Refreshes the device status from the API with caching support
   * Enhanced to ensure HomeKit always respects external device changes
   * @param isInitialSetup Whether this is the initial setup refresh
   */
  private async refreshDeviceStatus(isInitialSetup = false): Promise<void> {
    // Prevent multiple concurrent updates
    if (this.isUpdating) {
      this.platform.log.debug('Status update already in progress, skipping', LogContext.ACCESSORY);
      this.pendingUpdates = true;
      return;
    }
      // Skip polling updates if we recently made a user-initiated change
  // This prevents hammering the API after user interactions
  if (!isInitialSetup && !this.pendingUpdates) {
    const timeSinceLastTemp = Date.now() - this.lastTemperatureSetTime;
    if (timeSinceLastTemp < 30000) { // 30 seconds
      this.platform.log.debug(
        `Skipping scheduled status update, recent user interaction ${Math.round(timeSinceLastTemp/1000)}s ago`,
        LogContext.ACCESSORY
      );
      return;
    }
  }
  
    this.isUpdating = true;
    this.lastUpdateTime = Date.now();
    this.pendingUpdates = false;
    
    try {
      // Force fresh data on initial setup, otherwise use cache when appropriate
      const forceFresh = isInitialSetup;
      
      this.platform.log.verbose(
        `Refreshing status for device ${this.deviceId} (${forceFresh ? 'fresh' : 'cached if available'})`,
        LogContext.ACCESSORY
      );
      
      // Get the device status from the API (will use cache if available and not forced fresh)
      // Note: The API method should be updated to support the forceFresh parameter
      const status = await this.apiClient.getDeviceStatus(this.deviceId, forceFresh);
      
      if (!status) {
        throw new Error(`Failed to get status for device ${this.deviceId}`);
      }
      
      // Log detailed status in verbose mode
      if (this.platform.isVerboseLoggingEnabled()) {
        this.platform.log.verbose(
          `Device status received: current=${status.currentTemperature}°C, ` +
          `target=${status.targetTemperature}°C, ` +
          `thermal=${status.thermalStatus}, ` +
          `power=${status.powerState}` +
          (status.waterLevel !== undefined ? `, water=${status.waterLevel}%` : ''),
          LogContext.ACCESSORY
        );
      }
      
      // Update model if we can detect it from raw response
      if (status.rawResponse) {
        const detectedModel = this.detectDeviceModel(status.rawResponse);
        if (detectedModel !== this.deviceModel) {
          this.deviceModel = detectedModel;
          // Update the model in HomeKit
          this.informationService.updateCharacteristic(
            this.Characteristic.Model,
            this.deviceModel
          );
          this.platform.log.info(`Detected device model: ${this.deviceModel}`, LogContext.ACCESSORY);
        }
      }
      
      // Update firmware version if available
      if (status.firmwareVersion && status.firmwareVersion !== this.firmwareVersion) {
        this.firmwareVersion = status.firmwareVersion;
        // Explicitly update the firmware revision characteristic
        this.informationService.updateCharacteristic(
          this.Characteristic.FirmwareRevision,
          this.firmwareVersion
        );
        this.platform.log.debug(
          `Updated firmware version to ${this.firmwareVersion}`,
          LogContext.ACCESSORY
        );
      }
      
      // Always update current temperature regardless of device state
      // This ensures temperature is displayed even when device is off
      if (isNaN(this.currentTemperature) || status.currentTemperature !== this.currentTemperature) {
        this.currentTemperature = status.currentTemperature;
        this.service.updateCharacteristic(
          this.Characteristic.CurrentTemperature,
          this.currentTemperature
        );
        
        this.platform.log.verbose(
          `Current temperature updated to ${this.currentTemperature}°C`,
          LogContext.ACCESSORY
        );
      }
      
      // CRITICAL CHANGE: Always update target temperature to match actual device target
      // This ensures HomeKit doesn't try to "correct" temperature changes made elsewhere
      if (isNaN(this.targetTemperature) || status.targetTemperature !== this.targetTemperature) {
        this.targetTemperature = status.targetTemperature;
        this.service.updateCharacteristic(
          this.Characteristic.TargetTemperature,
          this.targetTemperature
        );
        
        this.platform.log.verbose(
          `Target temperature updated to ${this.targetTemperature}°C`,
          LogContext.ACCESSORY
        );
      }
      
      // CRITICAL CHANGE: Always update heating/cooling states based on device status
      const newHeatingState = this.mapThermalStatusToHeatingState(status.thermalStatus, status.powerState);
      if (newHeatingState !== this.currentHeatingState) {
        this.currentHeatingState = newHeatingState;
        this.service.updateCharacteristic(
          this.Characteristic.CurrentHeatingCoolingState,
          this.currentHeatingState
        );
        
        // Create state name string for logging
        let stateString = 'UNKNOWN';
        switch (this.currentHeatingState) {
          case this.Characteristic.CurrentHeatingCoolingState.OFF:
            stateString = 'OFF';
            break;
          case this.Characteristic.CurrentHeatingCoolingState.HEAT:
            stateString = 'HEAT';
            break;
          case this.Characteristic.CurrentHeatingCoolingState.COOL:
            stateString = 'COOL';
            break;
        }
        
        this.platform.log.verbose(
          `Current heating state updated to ${stateString}`,
          LogContext.ACCESSORY
        );
      }
      
      // CRITICAL CHANGE: Always update target heating state to match actual device state
      // This ensures HomeKit correctly shows when device has been turned off externally
      const newTargetState = this.determineTargetHeatingState(status.thermalStatus, status.powerState);
      if (newTargetState !== this.targetHeatingState) {
        // Device state has been changed externally (turned on/off)
        this.targetHeatingState = newTargetState;
        this.service.updateCharacteristic(
          this.Characteristic.TargetHeatingCoolingState,
          this.targetHeatingState
        );
        
        // Create state name string for logging
        let stateString = 'UNKNOWN';
        switch (this.targetHeatingState) {
          case this.Characteristic.TargetHeatingCoolingState.OFF:
            stateString = 'OFF';
            break;
          case this.Characteristic.TargetHeatingCoolingState.AUTO:
            stateString = 'AUTO';
            break;
        }
        
        this.platform.log.info(
          `External change detected: Device power state changed to ${stateString}`,
          LogContext.ACCESSORY
        );
      }
    
      // Log connection status if available
      if (status.connected !== undefined) {
        this.logConnectionStatus(status.connected);
      }
      
      // Update water level service if water level data is available
      if (status.waterLevel !== undefined) {
        if (status.waterLevel !== this.waterLevel || status.isWaterLow !== this.isWaterLow) {
          this.waterLevel = status.waterLevel;
          this.isWaterLow = !!status.isWaterLow;
          this.updateWaterLevelService(this.waterLevel, this.isWaterLow);
        }
      } else if (status.rawResponse) {
        // Try to extract water level from raw response if not directly provided
        const waterLevel = this.apiClient.extractNestedValue(status.rawResponse, 'status.water_level');
        const isWaterLow = !!this.apiClient.extractNestedValue(status.rawResponse, 'status.is_water_low');
        
        if (waterLevel !== undefined && waterLevel !== this.waterLevel) {
          this.waterLevel = waterLevel;
          this.isWaterLow = isWaterLow;
          this.updateWaterLevelService(this.waterLevel, this.isWaterLow);
          this.platform.log.verbose(
            `Water level extracted from raw response: ${this.waterLevel}%`,
            LogContext.ACCESSORY
          );
        }
      }
    } catch (error) {
      this.platform.log.error(
        `Failed to refresh device status: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.ACCESSORY
      );
    } finally {
      this.isUpdating = false;
      
      // Process any pending updates
      if (this.pendingUpdates) {
        setTimeout(() => {
          if (this.pendingUpdates) {
            this.pendingUpdates = false;
            this.refreshDeviceStatus().catch(error => 
              this.platform.log.error(`Deferred status update failed: ${error}`, LogContext.ACCESSORY)
            );
          }
        }, 2000);
      }
    }
  }

  /**
   * Map thermal status to HomeKit heating/cooling state
   */
  private mapThermalStatusToHeatingState(
    thermalStatus: ThermalStatus,
    powerState: PowerState
  ): number {
    // If power is off, the heating state is OFF
    if (powerState === PowerState.OFF) {
      return this.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    // Map the thermal status to the appropriate HomeKit state
    switch (thermalStatus) {
      case ThermalStatus.HEATING: {
        return this.Characteristic.CurrentHeatingCoolingState.HEAT;
      }
      case ThermalStatus.COOLING: {
        return this.Characteristic.CurrentHeatingCoolingState.COOL;
      }
      case ThermalStatus.ACTIVE: {
        // For an active but not specifically heating/cooling state,
        // determine based on target vs current temperature
        if (!isNaN(this.targetTemperature) && !isNaN(this.currentTemperature)) {
          if (this.targetTemperature > this.currentTemperature + 0.5) {
            return this.Characteristic.CurrentHeatingCoolingState.HEAT;
          } else if (this.targetTemperature < this.currentTemperature - 0.5) {
            return this.Characteristic.CurrentHeatingCoolingState.COOL;
          }
        }
        // When temperatures are close or undefined, default to HEAT (or last state)
        return this.currentHeatingState || this.Characteristic.CurrentHeatingCoolingState.HEAT;
      }
      case ThermalStatus.STANDBY:
      case ThermalStatus.OFF:
      case ThermalStatus.UNKNOWN:
      default: {
        return this.Characteristic.CurrentHeatingCoolingState.OFF;
      }
    }
  }

  /**
   * Determine the target heating state from the device status
   * Simplified to only return OFF or AUTO
   */
  private determineTargetHeatingState(
    thermalStatus: ThermalStatus,
    powerState: PowerState
  ): number {
    // If power is off, the target state is OFF
    if (powerState === PowerState.OFF || 
        thermalStatus === ThermalStatus.OFF ||
        thermalStatus === ThermalStatus.STANDBY) {
      return this.Characteristic.TargetHeatingCoolingState.OFF;
    }
    
    // For any active state, return AUTO mode
    return this.Characteristic.TargetHeatingCoolingState.AUTO;
  }

  /**
   * Handler for CurrentTemperature GET
   */
  private async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    // Return default temperature if value is not yet initialized
    const temp = isNaN(this.currentTemperature) ? 20 : this.currentTemperature;
    this.platform.log.debug(`GET CurrentTemperature: ${temp}`, LogContext.HOMEKIT);
    return temp;
  }

  /**
   * Handler for TargetTemperature GET
   */
  private async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    // Return default temperature if value is not yet initialized
    const temp = isNaN(this.targetTemperature) ? 20 : this.targetTemperature;
    this.platform.log.debug(`GET TargetTemperature: ${temp}`, LogContext.HOMEKIT);
    return temp;
  }

/**
 * Handler for TargetTemperature SET
 * Enhanced to work even when device is off and avoid multiple API calls
 */
private async handleTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
  const newTemp = this.validateTemperature(value as number);
  this.platform.log.verbose(`SET TargetTemperature: ${newTemp}°C`, LogContext.HOMEKIT);
  
  try {
    // Always update the internal target temperature immediately for responsiveness
    this.targetTemperature = newTemp;
    this.lastTemperatureSetTime = Date.now();
    
    // If device is OFF in HomeKit, just store the temperature but don't send to device
    // The temperature will be applied when the device is turned ON
    if (this.targetHeatingState === this.Characteristic.TargetHeatingCoolingState.OFF) {
      this.platform.log.info(
        `Device is currently OFF. Temperature set to ${newTemp}°C will be applied when device is turned on.`,
        LogContext.ACCESSORY
      );
      
      // Update the UI with the new temperature
      this.service.updateCharacteristic(
        this.Characteristic.TargetTemperature,
        this.targetTemperature
      );
      
      return;
    }
    
    // Update the device temperature since it's on (or should be on)
    const success = await this.apiClient.setTemperature(this.deviceId, newTemp);
    
    if (!success) {
      throw new Error('Failed to set temperature on the device');
    }
    
    // Update current state based on temperature difference if we have current temperature
    if (!isNaN(this.currentTemperature)) {
      this.updateHeatingState();
    }
  } catch (error) {
    this.platform.log.error(
      `Failed to set target temperature: ${error instanceof Error ? error.message : String(error)}`,
      LogContext.ACCESSORY
    );
    
    // In case of error, make sure UI still shows the correct temperature
    this.service.updateCharacteristic(
      this.Characteristic.TargetTemperature,
      this.targetTemperature
    );
  }
}
  private async handleCurrentHeatingStateGet(): Promise<CharacteristicValue> {
    // Create state name string for logging
    let stateString = 'UNKNOWN';
    switch (this.currentHeatingState) {
      case this.Characteristic.CurrentHeatingCoolingState.OFF:
        stateString = 'OFF';
        break;
      case this.Characteristic.CurrentHeatingCoolingState.HEAT:
        stateString = 'HEAT';
        break;
      case this.Characteristic.CurrentHeatingCoolingState.COOL:
        stateString = 'COOL';
        break;
    }
    
    this.platform.log.debug(`GET CurrentHeatingCoolingState: ${stateString}`, LogContext.HOMEKIT);
    return this.currentHeatingState;
  }

/**
 * Helper method to update heating state based on temperature difference
 */
private updateHeatingState(): void {
  // Only update if we have current temperature data
  if (isNaN(this.currentTemperature)) return;
  
  let newHeatingState = this.currentHeatingState;
  
  if (this.targetTemperature > this.currentTemperature + 0.5) {
    newHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
  } else if (this.targetTemperature < this.currentTemperature - 0.5) {
    newHeatingState = this.Characteristic.CurrentHeatingCoolingState.COOL;
  }
  
  // Only update if changed
  if (newHeatingState !== this.currentHeatingState) {
    this.currentHeatingState = newHeatingState;
    this.service.updateCharacteristic(
      this.Characteristic.CurrentHeatingCoolingState,
      this.currentHeatingState
    );
    
    // Log the new heating state
    let stateString = 'UNKNOWN';
    switch (this.currentHeatingState) {
      case this.Characteristic.CurrentHeatingCoolingState.OFF:
        stateString = 'OFF';
        break;
      case this.Characteristic.CurrentHeatingCoolingState.HEAT:
        stateString = 'HEAT';
        break;
      case this.Characteristic.CurrentHeatingCoolingState.COOL:
        stateString = 'COOL';
        break;
    }
    
    this.platform.log.verbose(
      `Current heating state updated to ${stateString} based on temperature difference`,
      LogContext.ACCESSORY
    );
  }
}

  /**
   * Handler for TargetHeatingCoolingState GET
   */
private async handleTargetHeatingStateGet(): Promise<CharacteristicValue> {
  // Create state name string for logging
  let stateString = 'UNKNOWN';
  switch (this.targetHeatingState) {
    case this.Characteristic.TargetHeatingCoolingState.OFF:
      stateString = 'OFF';
      break;
    case this.Characteristic.TargetHeatingCoolingState.AUTO:
      stateString = 'AUTO';
      break;
  }
  
  this.platform.log.debug(`GET TargetHeatingCoolingState: ${stateString}`, LogContext.HOMEKIT);
  return this.targetHeatingState;
}

/**
 * Handler for TargetHeatingCoolingState SET
 * Enhanced to use stored temperature when turning on
 */
private async handleTargetHeatingStateSet(value: CharacteristicValue): Promise<void> {
  const newState = value as number;
  let stateString = 'UNKNOWN';
  
  switch (newState) {
    case this.Characteristic.TargetHeatingCoolingState.OFF:
      stateString = 'OFF';
      break;
    case this.Characteristic.TargetHeatingCoolingState.AUTO:
      stateString = 'AUTO';
      break;
  }
  
  this.platform.log.info(`SET TargetHeatingCoolingState: ${stateString}`, LogContext.HOMEKIT);
  
  try {
    // Update internal state first for responsiveness
    this.targetHeatingState = newState;
    
    // Power on or off based on the new state
    let success = false;
    
    if (newState === this.Characteristic.TargetHeatingCoolingState.OFF) {
      // Turn off the device
      success = await this.apiClient.turnDeviceOff(this.deviceId);
      
      if (success) {
        // Update current state to reflect the device is now off
        this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.OFF;
        this.service.updateCharacteristic(
          this.Characteristic.CurrentHeatingCoolingState,
          this.currentHeatingState
        );
        
        this.platform.log.verbose(`Device ${this.deviceId} turned OFF successfully`, LogContext.ACCESSORY);
      }
    } else if (newState === this.Characteristic.TargetHeatingCoolingState.AUTO) {
      // Check if we just recently set the temperature (within the last 2 seconds)
      // This helps avoid redundant API calls when HomeKit sends both temperature and state changes
      const now = Date.now();
      if (now - this.lastTemperatureSetTime < 2000) {
        this.platform.log.verbose(
          `Skipping redundant turnOn call as temperature was just set`,
          LogContext.ACCESSORY
        );
        
        // Still need to update UI state
        this.updateHeatingState();
        return;
      }
      
      // Turn on the device with current target temperature
      const temperature = isNaN(this.targetTemperature) ? 21 : this.targetTemperature;
      success = await this.apiClient.turnDeviceOn(this.deviceId, temperature);
      
      if (success) {
        // Update current state based on temperature difference
        this.updateHeatingState();
        
        this.platform.log.verbose(
          `Device ${this.deviceId} turned ON successfully to ${temperature}°C`,
          LogContext.ACCESSORY
        );
      }
    }
    
    if (!success) {
      throw new Error(`Failed to change device state to ${stateString}`);
    }
  } catch (error) {
    this.platform.log.error(
      `Failed to set target heating state: ${error instanceof Error ? error.message : String(error)}`,
      LogContext.ACCESSORY
    );
    
    // Ensure UI shows correct state in case of error
    this.service.updateCharacteristic(
      this.Characteristic.TargetHeatingCoolingState,
      this.targetHeatingState
    );
  }
}
/**
 * Handle scheduled events from the scheduler
 * @param eventData Data about the scheduled event
 */
public handleScheduledEvent(eventData: { deviceId: string, temperature: number, state: string }): void {
  if (eventData.deviceId !== this.deviceId) {
    return; // Not for this device
  }
  
  this.platform.log.info(
    `Handling scheduled event: Temperature=${eventData.temperature}°C, State=${eventData.state}`,
    LogContext.ACCESSORY
  );
  
  // Update target temperature and state in HomeKit
  if (!isNaN(eventData.temperature) && 
      eventData.temperature >= MIN_TEMPERATURE_C && 
      eventData.temperature <= MAX_TEMPERATURE_C) {
    
    this.targetTemperature = eventData.temperature;
    this.service.updateCharacteristic(
      this.Characteristic.TargetTemperature,
      this.targetTemperature
    );
  }
  
  // Update target state based on the scheduled event state
  if (eventData.state === 'auto') {
    // If scheduled event is "auto", make sure HomeKit shows AUTO
    this.targetHeatingState = this.Characteristic.TargetHeatingCoolingState.AUTO;
    this.service.updateCharacteristic(
      this.Characteristic.TargetHeatingCoolingState,
      this.targetHeatingState
    );
    
    // Also update current state based on temperature difference
    if (!isNaN(this.currentTemperature) && !isNaN(this.targetTemperature)) {
      let newHeatingState = this.currentHeatingState;
      
      if (this.targetTemperature > this.currentTemperature + 0.5) {
        newHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
      } else if (this.targetTemperature < this.currentTemperature - 0.5) {
        newHeatingState = this.Characteristic.CurrentHeatingCoolingState.COOL;
      }
      
      if (newHeatingState !== this.currentHeatingState) {
        this.currentHeatingState = newHeatingState;
        this.service.updateCharacteristic(
          this.Characteristic.CurrentHeatingCoolingState,
          this.currentHeatingState
        );
      }
    }
  } else if (eventData.state === 'off') {
    // If scheduled event is "off", make sure HomeKit shows OFF
    this.targetHeatingState = this.Characteristic.TargetHeatingCoolingState.OFF;
    this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.OFF;
    
    this.service.updateCharacteristic(
      this.Characteristic.TargetHeatingCoolingState,
      this.targetHeatingState
    );
    
    this.service.updateCharacteristic(
      this.Characteristic.CurrentHeatingCoolingState,
      this.currentHeatingState
    );
  }
  
  // No need to issue API calls - the scheduler has already done this
  this.platform.log.verbose(
    `HomeKit UI updated to match scheduled event: Target=${this.targetTemperature}°C`,
    LogContext.ACCESSORY
  );
}

/**
 * Validate and clamp temperature to allowed range
 * @param temperature Temperature to validate
 * @returns Validated temperature value
 */
private validateTemperature(temperature: number): number {
  // First round to nearest 0.5°C increment
  let roundedTemp = Math.round(temperature * 2) / 2;
  
  // Then clamp to allowed range
  if (roundedTemp < MIN_TEMPERATURE_C) {
    this.platform.log.warn(
      `Temperature ${temperature}°C below minimum of ${MIN_TEMPERATURE_C}°C, clamping to minimum`,
      LogContext.ACCESSORY
    );
    roundedTemp = MIN_TEMPERATURE_C;
  } else if (roundedTemp > MAX_TEMPERATURE_C) {
    this.platform.log.warn(
      `Temperature ${temperature}°C above maximum of ${MAX_TEMPERATURE_C}°C, clamping to maximum`,
      LogContext.ACCESSORY
    );
    roundedTemp = MAX_TEMPERATURE_C;
  }
  
  return roundedTemp;
}
}