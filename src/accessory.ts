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
        this.platform.log.debug(
          `Next scheduled event: ${schedulerStatus.nextEvent.time} ` +
          `(${schedulerStatus.nextEvent.temperature}°C, in ${schedulerStatus.nextEvent.minutesUntil} minutes)`,
          LogContext.ACCESSORY
        );
      }
      
      // Log active warm hug if available
      if (schedulerStatus.activeWarmHug) {
        this.platform.log.debug(
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
   */
  private updateWaterLevelService(waterLevel: number, isWaterLow: boolean): void {
    // Only create/update if we have valid water level data
    if (waterLevel !== undefined) {
      // Get or create water level service (using Battery service as proxy)
      if (!this.waterLevelService) {
        this.waterLevelService = this.accessory.getService(this.platform.Service.Battery) ||
                                this.accessory.addService(this.platform.Service.Battery, 'Water Level');
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

      // Set charging state to "Not Charging" since it's not applicable for water level
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
    
    this.isUpdating = true;
    this.lastUpdateTime = Date.now();
    this.pendingUpdates = false;
    
    try {
      // Force fresh data on initial setup, otherwise use cache when appropriate
      const forceFresh = isInitialSetup;
      
      this.platform.log.debug(
        `Refreshing status for device ${this.deviceId} (${forceFresh ? 'fresh' : 'cached if available'})`,
        LogContext.ACCESSORY
      );
      
      // Get the device status from the API (will use cache if available and not forced fresh)
      // Note: The API method should be updated to support the forceFresh parameter
      const status = await this.apiClient.getDeviceStatus(this.deviceId);
      
      if (!status) {
        throw new Error(`Failed to get status for device ${this.deviceId}`);
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
      }
      
      // CRITICAL CHANGE: Always update target temperature to match actual device target
      // This ensures HomeKit doesn't try to "correct" temperature changes made elsewhere
      if (isNaN(this.targetTemperature) || status.targetTemperature !== this.targetTemperature) {
        this.targetTemperature = status.targetTemperature;
        this.service.updateCharacteristic(
          this.Characteristic.TargetTemperature,
          this.targetTemperature
        );
        this.platform.log.debug(
          `External change detected: Target temperature updated to ${this.targetTemperature}°C`,
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
        
        this.platform.log.debug(
          `External change detected: Current heating state updated to ${stateString}`,
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
        if (status.waterLevel !== this.waterLevel) {
          this.waterLevel = status.waterLevel;
          this.isWaterLow = !!status.isWaterLow;
          this.updateWaterLevelService(this.waterLevel, this.isWaterLow);
        }
      } else if (status.rawResponse) {
        // Extract water level data from raw response if not directly provided
        const waterLevel = this.apiClient.extractNestedValue(status.rawResponse, 'status.water_level') || 
                         this.apiClient.extractNestedValue(status.rawResponse, 'water_level');
        
        const isWaterLow = this.apiClient.extractNestedValue(status.rawResponse, 'status.is_water_low') || 
                         this.apiClient.extractNestedValue(status.rawResponse, 'is_water_low') || false;
        
        if (waterLevel !== undefined && waterLevel !== this.waterLevel) {
          this.waterLevel = waterLevel;
          this.isWaterLow = isWaterLow;
          this.updateWaterLevelService(this.waterLevel, this.isWaterLow);
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
   * Enhanced to respect device's current power state and reduce API calls
   */
  private async handleTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    const newTemp = this.validateTemperature(value as number);
    this.platform.log.debug(`SET TargetTemperature: ${newTemp}°C`, LogContext.HOMEKIT);
    
    try {
      // Always update the internal target temperature immediately for responsiveness
      // This ensures the UI shows the change right away
      this.targetTemperature = newTemp;
      
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
      
      // No need to refresh status after temperature change - the cache will be 
      // optimistically updated and we'll get a regular status update on the next polling cycle
      
      // Update current state based on temperature difference if we have current temperature
      if (!isNaN(this.currentTemperature)) {
        let newHeatingState = this.currentHeatingState;
        
        if (newTemp > this.currentTemperature + 0.5) {
          newHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
        } else if (newTemp < this.currentTemperature - 0.5) {
          newHeatingState = this.Characteristic.CurrentHeatingCoolingState.COOL;
        }
        
        // Only update if changed
        if (newHeatingState !== this.currentHeatingState) {
          this.currentHeatingState = newHeatingState;
          this.service.updateCharacteristic(
            this.Characteristic.CurrentHeatingCoolingState,
            this.currentHeatingState
          );
        }
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

  /**
   * Handler for CurrentHeatingCoolingState GET
   */
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
   * Enhanced to reduce API calls and optimistically update UI state
   */
  private async handleTargetHeatingStateSet(value: CharacteristicValue): Promise<void> {
    const newState = value as number;
    
    // Create state name string for logging
    let stateString = 'UNKNOWN';
    switch (newState) {
      case this.Characteristic.TargetHeatingCoolingState.OFF:
        stateString = 'OFF';
        break;
      case this.Characteristic.TargetHeatingCoolingState.AUTO:
        stateString = 'AUTO';
        break;
    }
    
    this.platform.log.debug(`SET TargetHeatingCoolingState: ${stateString}`, LogContext.HOMEKIT);
    
    try {
      // Skip the API call if the state isn't changing
      if (newState === this.targetHeatingState) {
        this.platform.log.debug(
          `Device already in ${stateString} state, skipping API call`,
          LogContext.ACCESSORY
        );
        return;
      }
      
      let success = false;
      
      switch (newState) {
        case this.Characteristic.TargetHeatingCoolingState.OFF: {
          // Turn off the device
          success = await this.apiClient.turnDeviceOff(this.deviceId);
          
          if (success) {
            // Update internal state immediately for responsiveness
            this.targetHeatingState = newState;
            this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.OFF;
            
            // Update HomeKit characteristics
            this.service.updateCharacteristic(
              this.Characteristic.CurrentHeatingCoolingState,
              this.currentHeatingState
            );
          }
          break;
        }
        case this.Characteristic.TargetHeatingCoolingState.AUTO: {
          // Use the current target temperature or a reasonable default if it's not yet initialized
          const tempToUse = !isNaN(this.targetTemperature) ? this.targetTemperature : 21;
          
          // Turn on in auto mode with current target temperature
          success = await this.apiClient.turnDeviceOn(this.deviceId, tempToUse);
          
          if (success) {
            // Update internal states
            this.targetHeatingState = newState;
            
            // Determine current heating/cooling state based on temperature difference
            if (!isNaN(this.currentTemperature)) {
              if (tempToUse > this.currentTemperature + 0.5) {
                this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
              } else if (tempToUse < this.currentTemperature - 0.5) {
                this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.COOL;
              } else {
                // When temperatures are close, use the last non-OFF state or default to HEAT
                this.currentHeatingState = 
                  (this.currentHeatingState !== this.Characteristic.CurrentHeatingCoolingState.OFF) ? 
                  this.currentHeatingState : this.Characteristic.CurrentHeatingCoolingState.HEAT;
              }
            } else {
              // No current temperature yet, default to HEAT
              this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
            }
            
            // Update HomeKit characteristic
            this.service.updateCharacteristic(
              this.Characteristic.CurrentHeatingCoolingState,
              this.currentHeatingState
            );
          }
          break;
        }
        // We're ignoring HEAT and COOL modes since they aren't exposed to HomeKit
      }
      
      if (!success) {
        throw new Error(`Failed to set target state to ${stateString}`);
      }
      
      // No need to refresh status - cache will be optimistically updated
      // and we'll get a regular status update on the next polling cycle
    } catch (error) {
      this.platform.log.error(
        `Failed to set target heating state: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.ACCESSORY
      );
    }
  }

  /**
   * Validate and constrain temperature values
   */
  private validateTemperature(temperature: number): number {
    if (typeof temperature !== 'number' || isNaN(temperature)) {
      this.platform.log.warn(
        `Invalid temperature value: ${temperature}, using default 21°C`,
        LogContext.ACCESSORY
      );
      return 21; // Return reasonable default if invalid
    }
    
    // Constrain to valid range - properly referencing MIN_TEMPERATURE_C from settings.ts
    if (temperature < MIN_TEMPERATURE_C) {
      this.platform.log.warn(
        `Temperature ${temperature}°C below minimum ${MIN_TEMPERATURE_C}°C, using ${MIN_TEMPERATURE_C}°C`,
        LogContext.ACCESSORY
      );
      return MIN_TEMPERATURE_C;
    }
    
    if (temperature > MAX_TEMPERATURE_C) {
      this.platform.log.warn(
        `Temperature ${temperature}°C above maximum ${MAX_TEMPERATURE_C}°C, using ${MAX_TEMPERATURE_C}°C`,
        LogContext.ACCESSORY
      );
      return MAX_TEMPERATURE_C;
    }
    
    // Round to nearest step value
    return Math.round(temperature / TEMPERATURE_STEP) * TEMPERATURE_STEP;
  }

  /**
   * Handle a scheduled event from the scheduler
   * This updates the HomeKit state to match scheduled changes
   */
  public handleScheduledEvent(eventData: { deviceId: string, temperature: number, state: string }): void {
    if (eventData.deviceId !== this.deviceId) {
      return; // Not for this device
    }
    
    this.platform.log.info(
      `Executing scheduled event: temp=${eventData.temperature}°C, state=${eventData.state}`,
      LogContext.ACCESSORY
    );
    
    // Update internal state
    this.targetTemperature = eventData.temperature;
    
    if (eventData.state === 'auto') {
      this.targetHeatingState = this.Characteristic.TargetHeatingCoolingState.AUTO;
      
      // Update current heating state based on temperature difference
      if (!isNaN(this.currentTemperature)) {
        if (this.targetTemperature > this.currentTemperature + 0.5) {
          this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
        } else if (this.targetTemperature < this.currentTemperature - 0.5) {
          this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.COOL;
        } else {
          this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
        }
      } else {
        // Default to HEAT if no current temperature
        this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
      }
    } else {
      this.targetHeatingState = this.Characteristic.TargetHeatingCoolingState.OFF;
      this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.OFF;
    }
    
    // Update HomeKit characteristics
    this.service.updateCharacteristic(
      this.Characteristic.TargetTemperature,
      this.targetTemperature
    );
    this.service.updateCharacteristic(
      this.Characteristic.TargetHeatingCoolingState,
      this.targetHeatingState
    );
    this.service.updateCharacteristic(
      this.Characteristic.CurrentHeatingCoolingState,
      this.currentHeatingState
    );
  }
}