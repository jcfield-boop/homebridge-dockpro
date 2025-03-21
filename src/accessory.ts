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
  
  // Device state
  private currentTemperature = 21; // Default value
  private targetTemperature = 21;  // Default value
  private currentHeatingState = 0; // OFF
  private targetHeatingState = 0;  // OFF
  private firmwareVersion = 'Unknown';
  
  // Device properties
  private readonly deviceId: string;
  private readonly displayName: string;
  
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
    
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'Sleepme Inc.')
      .setCharacteristic(this.Characteristic.Model, 'ChiliPad')
      .setCharacteristic(this.Characteristic.SerialNumber, this.deviceId);

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
    
    // Target Heating/Cooling State
    this.service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingStateGet.bind(this))
      .onSet(this.handleTargetHeatingStateSet.bind(this));
    
    // Temperature Display Units
    const displayUnits = this.platform.temperatureUnit === 'C' 
      ? this.Characteristic.TemperatureDisplayUnits.CELSIUS
      : this.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    
    this.service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
      .updateValue(displayUnits)
      .onGet(() => displayUnits);
    
    // Initialize the device state
    this.refreshDeviceStatus()
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
   * Set up the status polling mechanism
   */
  private setupStatusPolling(): void {
    // Clear any existing timer
    if (this.statusUpdateTimer) {
      clearInterval(this.statusUpdateTimer);
    }
    
    // Convert polling interval from seconds to milliseconds
    const intervalMs = this.platform.pollingInterval * 1000;
    
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
   * Refresh the device status from the API
   */
  private async refreshDeviceStatus(): Promise<void> {
    // Prevent multiple concurrent updates
    if (this.isUpdating) {
      this.platform.log.debug('Status update already in progress, skipping', LogContext.ACCESSORY);
      this.pendingUpdates = true;
      return;
    }
    
    // Add retry logic
    let attempts = 0;
    const maxAttempts = 3;
    
    this.isUpdating = true;
    this.lastUpdateTime = Date.now();
    this.pendingUpdates = false;
    
    try {
      while (attempts < maxAttempts) {
        try {
          this.platform.log.debug(`Refreshing status for device ${this.deviceId} (attempt ${attempts + 1}/${maxAttempts})`, LogContext.ACCESSORY);
          
          // Get the device status from the API
          const status = await this.apiClient.getDeviceStatus(this.deviceId);
          
          if (!status) {
            throw new Error(`Failed to get status for device ${this.deviceId}`);
          }
          
          // Update firmware version if available
          if (status.firmwareVersion && status.firmwareVersion !== this.firmwareVersion) {
            this.firmwareVersion = status.firmwareVersion;
            this.accessory.getService(this.platform.Service.AccessoryInformation)?.
              updateCharacteristic(this.Characteristic.FirmwareRevision, status.firmwareVersion);
          }
          
          // Update temperature values
          if (status.currentTemperature !== this.currentTemperature) {
            this.currentTemperature = status.currentTemperature;
            this.service.updateCharacteristic(
              this.Characteristic.CurrentTemperature,
              this.currentTemperature
            );
          }
          
          if (status.targetTemperature !== this.targetTemperature) {
            this.targetTemperature = status.targetTemperature;
            this.service.updateCharacteristic(
              this.Characteristic.TargetTemperature,
              this.targetTemperature
            );
          }
          // Update heating/cooling states based on thermal status and power state
          const newHeatingState = this.mapThermalStatusToHeatingState(status.thermalStatus, status.powerState);
          if (newHeatingState !== this.currentHeatingState) {
            this.currentHeatingState = newHeatingState;
            this.service.updateCharacteristic(
              this.Characteristic.CurrentHeatingCoolingState,
              this.currentHeatingState
            );
          }
          
          // Update target heating state based on power state
          const newTargetState = this.determineTargetHeatingState(status.thermalStatus, status.powerState);
          if (newTargetState !== this.targetHeatingState) {
            this.targetHeatingState = newTargetState;
            this.service.updateCharacteristic(
              this.Characteristic.TargetHeatingCoolingState,
              this.targetHeatingState
            );
          }
          
          // Success, exit retry loop
          break;
        } catch (error) {
          attempts++;
          
          // Log the error but don't throw - we want polling to continue
          this.platform.log.error(
            `Failed to refresh device status (attempt ${attempts}/${maxAttempts}): ${error instanceof Error ? error.message : String(error)}`,
            LogContext.ACCESSORY
          );
          
          if (attempts < maxAttempts) {
            // Wait before retrying - exponential backoff
            await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
          }
        }
      }
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
        if (this.targetTemperature > this.currentTemperature + 0.5) {
          return this.Characteristic.CurrentHeatingCoolingState.HEAT;
        } else if (this.targetTemperature < this.currentTemperature - 0.5) {
          return this.Characteristic.CurrentHeatingCoolingState.COOL;
        } else {
          // When temperatures are close, default to HEAT (or last state)
          return this.currentHeatingState || this.Characteristic.CurrentHeatingCoolingState.HEAT;
        }
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
    
    // For active states, determine the appropriate target state
    switch (thermalStatus) {
      case ThermalStatus.HEATING: {
        return this.Characteristic.TargetHeatingCoolingState.HEAT;
      }
      case ThermalStatus.COOLING: {
        return this.Characteristic.TargetHeatingCoolingState.COOL;
      }
      case ThermalStatus.ACTIVE:
      default: {
        // Default to AUTO mode when active
        return this.Characteristic.TargetHeatingCoolingState.AUTO;
      }
    }
  }

  /**
   * Handler for CurrentTemperature GET
   */
  private async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    this.platform.log.debug(`GET CurrentTemperature: ${this.currentTemperature}`, LogContext.HOMEKIT);
    return this.currentTemperature;
  }

  /**
   * Handler for TargetTemperature GET
   */
  private async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    this.platform.log.debug(`GET TargetTemperature: ${this.targetTemperature}`, LogContext.HOMEKIT);
    return this.targetTemperature;
  }
  
  /**
   * Handler for TargetTemperature SET
   * Enhanced to automatically activate the device if needed
   */
  private async handleTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    const newTemp = this.validateTemperature(value as number);
    this.platform.log.debug(`SET TargetTemperature: ${newTemp}°C`, LogContext.HOMEKIT);
    
    try {
      // Always update the internal target temperature immediately for responsiveness
      this.targetTemperature = newTemp;
      
      // Determine if device is currently off
      const deviceIsOff = this.targetHeatingState === this.Characteristic.TargetHeatingCoolingState.OFF;
      
      if (deviceIsOff) {
        // Device is off, automatically turn it on with the new temperature
        this.platform.log.info(`Device is OFF, automatically turning ON with temperature ${newTemp}°C`, LogContext.ACCESSORY);
        
        // Turn on the device in AUTO mode
        const success = await this.apiClient.turnDeviceOn(this.deviceId, newTemp);
        
        if (success) {
          // Update internal states
          this.targetHeatingState = this.Characteristic.TargetHeatingCoolingState.AUTO;
          
          // Determine current heating/cooling state based on temperature difference
          if (newTemp > this.currentTemperature + 0.5) {
            this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
          } else if (newTemp < this.currentTemperature - 0.5) {
            this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.COOL;
          } else {
            // When temperatures are close, default to HEAT
            this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
          }
          
          // Update HomeKit characteristics
          this.service.updateCharacteristic(
            this.Characteristic.TargetHeatingCoolingState,
            this.targetHeatingState
          );
          this.service.updateCharacteristic(
            this.Characteristic.CurrentHeatingCoolingState,
            this.currentHeatingState
          );
        } else {
          throw new Error('Failed to turn device on');
        }
      } else {
        // Device is already on, just update the temperature
        const success = await this.apiClient.setTemperature(this.deviceId, newTemp);
        
        if (!success) {
          throw new Error('Failed to set temperature');
        }
        
        // Update current heating/cooling state based on new target temperature
        if (this.targetHeatingState === this.Characteristic.TargetHeatingCoolingState.AUTO) {
          // Only update the current state if in AUTO mode
          if (newTemp > this.currentTemperature + 0.5) {
            this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
          } else if (newTemp < this.currentTemperature - 0.5) {
            this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.COOL;
          }
          
          this.service.updateCharacteristic(
            this.Characteristic.CurrentHeatingCoolingState,
            this.currentHeatingState
          );
        }
      }
      
      // Refresh the device status after a short delay
      setTimeout(() => {
        this.refreshDeviceStatus().catch(error => {
          this.platform.log.error(
            `Error updating device status after temperature change: ${error}`,
            LogContext.ACCESSORY
          );
        });
      }, 2000);
    } catch (error) {
      this.platform.log.error(
        `Failed to set target temperature: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.ACCESSORY
      );
    }
  }
  /**
   * Handler for CurrentHeatingCoolingState GET
   */
  private async handleCurrentHeatingStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug(`GET CurrentHeatingCoolingState: ${this.getHeatingStateName(this.currentHeatingState)}`, LogContext.HOMEKIT);
    return this.currentHeatingState;
  }

  /**
   * Handler for TargetHeatingCoolingState GET
   */
  private async handleTargetHeatingStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug(`GET TargetHeatingCoolingState: ${this.getHeatingStateName(this.targetHeatingState)}`, LogContext.HOMEKIT);
    return this.targetHeatingState;
  }

  /**
   * Handler for TargetHeatingCoolingState SET
   * Improved to ensure the device responds properly to HomeKit state changes
   */
  private async handleTargetHeatingStateSet(value: CharacteristicValue): Promise<void> {
    const newState = value as number;
    this.platform.log.debug(`SET TargetHeatingCoolingState: ${this.getHeatingStateName(newState)}`, LogContext.HOMEKIT);
    
    try {
      let success = false;
      
      switch (newState) {
        case this.Characteristic.TargetHeatingCoolingState.OFF: {
          // Turn off the device
          success = await this.apiClient.turnDeviceOff(this.deviceId);
          
          if (success) {
            // Update internal state immediately for better responsiveness
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
        case this.Characteristic.TargetHeatingCoolingState.HEAT: {
          // For heating, use a temperature higher than current temperature
          let heatingTemp = Math.max(this.currentTemperature + 2, this.targetTemperature);
          heatingTemp = this.validateTemperature(heatingTemp);
          
          success = await this.apiClient.turnDeviceOn(this.deviceId, heatingTemp);
          
          if (success) {
            // Update internal states
            this.targetHeatingState = newState;
            this.targetTemperature = heatingTemp;
            this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
            
            // Update HomeKit characteristics
            this.service.updateCharacteristic(
              this.Characteristic.TargetTemperature,
              this.targetTemperature
            );
            this.service.updateCharacteristic(
              this.Characteristic.CurrentHeatingCoolingState,
              this.currentHeatingState
            );
          }
          break;
        }
        case this.Characteristic.TargetHeatingCoolingState.COOL: {
          // For cooling, use a temperature lower than current temperature
          let coolingTemp = Math.min(this.currentTemperature - 2, this.targetTemperature);
          coolingTemp = this.validateTemperature(coolingTemp);
          
          success = await this.apiClient.turnDeviceOn(this.deviceId, coolingTemp);
          
          if (success) {
            // Update internal states
            this.targetHeatingState = newState;
            this.targetTemperature = coolingTemp;
            this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.COOL;
            
            // Update HomeKit characteristics
            this.service.updateCharacteristic(
              this.Characteristic.TargetTemperature,
              this.targetTemperature
            );
            this.service.updateCharacteristic(
              this.Characteristic.CurrentHeatingCoolingState,
              this.currentHeatingState
            );
          }
          break;
        }
        case this.Characteristic.TargetHeatingCoolingState.AUTO: {
          // Turn on in auto mode with current target temperature
          success = await this.apiClient.turnDeviceOn(this.deviceId, this.targetTemperature);
          
          if (success) {
            // Update internal states
            this.targetHeatingState = newState;
            
            // Determine current heating/cooling state based on temperature difference
            if (this.targetTemperature > this.currentTemperature + 0.5) {
              this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.HEAT;
            } else if (this.targetTemperature < this.currentTemperature - 0.5) {
              this.currentHeatingState = this.Characteristic.CurrentHeatingCoolingState.COOL;
            } else {
              // When temperatures are close, use the last non-OFF state or default to HEAT
              this.currentHeatingState = 
                (this.currentHeatingState !== this.Characteristic.CurrentHeatingCoolingState.OFF) ? 
                this.currentHeatingState : this.Characteristic.CurrentHeatingCoolingState.HEAT;
            }
            
            // Update HomeKit characteristic
            this.service.updateCharacteristic(
              this.Characteristic.CurrentHeatingCoolingState,
              this.currentHeatingState
            );
          }
          break;
        }
      }
      if (!success) {
        throw new Error(`Failed to set target state to ${this.getHeatingStateName(newState)}`);
      }
      
      // Refresh device status after a short delay for better feedback
      setTimeout(() => {
        this.refreshDeviceStatus().catch(error => {
          this.platform.log.error(
            `Error updating device status after state change: ${error}`,
            LogContext.ACCESSORY
          );
        });
      }, 2000);
    } catch (error) {
      this.platform.log.error(
        `Failed to set target heating state: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.ACCESSORY
      );
      
      // Restore the previous target state in HomeKit
      this.service.updateCharacteristic(
        this.Characteristic.TargetHeatingCoolingState,
        this.targetHeatingState
      );
    }
  }

  /**
   * Validate and constrain temperature values
   */
  private validateTemperature(temperature: number): number {
    if (typeof temperature !== 'number' || isNaN(temperature)) {
      this.platform.log.warn(
        `Invalid temperature value: ${temperature}, using current target ${this.targetTemperature}°C`,
        LogContext.ACCESSORY
      );
      return this.targetTemperature;
    }
    
    // Constrain to valid range
    if (temperature < MIN_TEMPERATURE_C) {
      this.platform.log.warn(
        `Temperature ${temperature}°C below minimum, using ${MIN_TEMPERATURE_C}°C`,
        LogContext.ACCESSORY
      );
      return MIN_TEMPERATURE_C;
    }
    
    if (temperature > MAX_TEMPERATURE_C) {
      this.platform.log.warn(
        `Temperature ${temperature}°C above maximum, using ${MAX_TEMPERATURE_C}°C`,
        LogContext.ACCESSORY
      );
      return MAX_TEMPERATURE_C;
    }
    
    // Round to nearest step value
    return Math.round(temperature / TEMPERATURE_STEP) * TEMPERATURE_STEP;
  }

  /**
   * Get the name of a heating/cooling state for logging
   */
  private getHeatingStateName(state: number): string {
    switch (state) {
      case this.Characteristic.CurrentHeatingCoolingState.OFF:
      case this.Characteristic.TargetHeatingCoolingState.OFF:
        return 'OFF';
      case this.Characteristic.CurrentHeatingCoolingState.HEAT:
      case this.Characteristic.TargetHeatingCoolingState.HEAT:
        return 'HEAT';
      case this.Characteristic.CurrentHeatingCoolingState.COOL:
      case this.Characteristic.TargetHeatingCoolingState.COOL:
        return 'COOL';
      case this.Characteristic.TargetHeatingCoolingState.AUTO:
        return 'AUTO';
      default:
        return `UNKNOWN(${state})`;
    }
  }
}