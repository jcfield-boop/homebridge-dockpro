/**
 * SleepMe Scheduler Module
 * Provides scheduling capabilities for SleepMe devices
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { SleepMeApi } from './api/sleepme-api.js';
import { EnhancedLogger, LogContext } from './utils/logger.js';

/**
 * Represents a scheduled temperature event
 */
export interface ScheduledEvent {
  id: string;             // Unique identifier for the event
  enabled: boolean;       // Whether this event is active
  time: string;           // Time in 24-hour format (HH:MM)
  temperature: number;    // Target temperature in Celsius
  days: number[];         // Days of week (0-6, Sunday is 0)
  warmHug: boolean;       // Whether to gradually warm up before this event
  warmHugDuration: number; // Duration of warm-up period in minutes (default: 20)
}

/**
 * Represents a device's complete schedule
 */
export interface DeviceSchedule {
  deviceId: string;        // Device identifier
  events: ScheduledEvent[]; // Array of scheduled events
  enabled: boolean;        // Master switch for scheduling
}

/**
 * Scheduler status and next event information
 */
export interface SchedulerStatus {
  enabled: boolean;        // Whether scheduling is enabled
  nextEvent?: {            // Information about the next scheduled event
    time: string;          // Time in 24-hour format
    temperature: number;   // Target temperature in Celsius
    warmHug: boolean;      // Whether warm hug is enabled for this event
    minutesUntil: number;  // Minutes until the event
  };
  activeWarmHug?: {        // Information about an active warm hug process
    targetTime: string;    // Target time when final temperature should be reached
    targetTemp: number;    // Final target temperature
    currentStep: number;   // Current step in the warm-up process
    totalSteps: number;    // Total steps in the warm-up process
  };
}

/**
 * SleepMe Scheduler Class
 * Manages temperature schedules for SleepMe devices
 * Extends EventEmitter to provide event-based communication
 */
export class SleepMeScheduler extends EventEmitter {
  // Store active timers by device ID
  private eventTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // Store warm hug timers by device ID
  private warmHugTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // Store active warm hug processes
  private activeWarmHugs: Map<string, {
    targetTime: Date;
    targetTemp: number;
    startTemp: number;
    currentStep: number;
    totalSteps: number;
  }> = new Map();
  
  // Schedule cache by device ID
  private schedules: Map<string, DeviceSchedule> = new Map();
  
  // Next scheduled events by device ID
  private nextEvents: Map<string, {
    event: ScheduledEvent;
    timestamp: Date;
    timer: NodeJS.Timeout;
  }> = new Map();
  
 /**
 * Create a new SleepMe scheduler
 */
constructor(
    private readonly api: SleepMeApi,
    private readonly logger: EnhancedLogger,
    private readonly storagePath: string
  ) {
    // Initialize EventEmitter
    super();
    
    this.logger.info('Initializing SleepMe scheduler', LogContext.SCHEDULER);
    this.loadSchedules();
  }
 /**
 * Load all schedules from persistent storage
 */
 private loadSchedules(): void {
  try {
    const dataPath = path.join(this.storagePath, 'sleepme-schedules.json');
    
    if (!fs.existsSync(dataPath)) {
      this.logger.info('No existing schedules found, starting with empty schedules', LogContext.SCHEDULER);
      return;
    }
    
    const data = fs.readFileSync(dataPath, 'utf8');
    const schedules = JSON.parse(data) as Record<string, DeviceSchedule>;
    
    // Convert to Map for easier access - with validation
    Object.values(schedules).forEach(schedule => {
      // Validate deviceId is a proper string
      if (typeof schedule.deviceId === 'string' && schedule.deviceId.trim() !== '') {
        this.schedules.set(schedule.deviceId, schedule);
      } else {
        this.logger.warn(
          `Skipping invalid schedule with non-string deviceId: ${typeof schedule.deviceId}`,
          LogContext.SCHEDULER
        );
      }
    });
    
    this.logger.info(`Loaded ${this.schedules.size} device schedules from storage`, LogContext.SCHEDULER);
    
    // Activate all enabled schedules
    this.schedules.forEach(schedule => {
      if (schedule.enabled) {
        this.activateSchedule(schedule.deviceId);
      }
    });
  } catch (error) {
    this.logger.error(
      `Failed to load schedules: ${error instanceof Error ? error.message : String(error)}`,
      LogContext.SCHEDULER
    );
  }
}
  /**
   * Save all schedules to persistent storage
   */
  private saveSchedules(): void {
    try {
      const schedulesToSave: Record<string, DeviceSchedule> = {};
      
      this.schedules.forEach((schedule, deviceId) => {
        schedulesToSave[deviceId] = schedule;
      });
      
      // Create directory if it doesn't exist
      const dirPath = path.dirname(path.join(this.storagePath, 'sleepme-schedules.json'));
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      
      fs.writeFileSync(
        path.join(this.storagePath, 'sleepme-schedules.json'),
        JSON.stringify(schedulesToSave, null, 2),
        'utf8'
      );
      
      this.logger.debug('Saved schedules to storage', LogContext.SCHEDULER);
    } catch (error) {
      this.logger.error(
        `Failed to save schedules: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.SCHEDULER
      );
    }
  }
  /**
   * Get the schedule for a specific device
   */
  public getDeviceSchedule(deviceId: string): DeviceSchedule | null {
    return this.schedules.get(deviceId) || null;
  }
  
  /**
   * Set or update the schedule for a device
   */
  public setDeviceSchedule(schedule: DeviceSchedule): boolean {
    try {
      // Validate schedule
      if (!schedule.deviceId || typeof schedule.deviceId !== 'string' || schedule.deviceId.trim() === '') {
        this.logger.error('Invalid schedule: missing or invalid device ID', LogContext.SCHEDULER);
        return false;
      }
      
      // Ensure events have unique IDs
      schedule.events = schedule.events.map(event => {
        if (!event.id) {
          event.id = this.generateEventId();
        }
        return event;
      });
      
      // Deactivate current schedule if exists
      this.deactivateSchedule(schedule.deviceId);
      
      // Store the new schedule
      this.schedules.set(schedule.deviceId, schedule);
      
      // Activate if enabled
      if (schedule.enabled) {
        this.activateSchedule(schedule.deviceId);
      }
      
      // Save to storage
      this.saveSchedules();
      
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to set schedule: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.SCHEDULER
      );
      return false;
    }
  }
  
  /**
   * Add a single event to a device's schedule
   */
  public addScheduledEvent(deviceId: string, event: ScheduledEvent): boolean {
    try {
      // Get current schedule or create new one
      const schedule = this.schedules.get(deviceId) || {
        deviceId,
        events: [],
        enabled: true
      };
      
      // Ensure event has an ID
      if (!event.id) {
        event.id = this.generateEventId();
      }
      
      // Add the event
      schedule.events.push(event);
      
      // Update schedule
      return this.setDeviceSchedule(schedule);
    } catch (error) {
      this.logger.error(
        `Failed to add event: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.SCHEDULER
      );
      return false;
    }
  }
  
  /**
   * Remove an event from a device's schedule by ID
   */
  public removeScheduledEvent(deviceId: string, eventId: string): boolean {
    try {
      // Get current schedule
      const schedule = this.schedules.get(deviceId);
      if (!schedule) {
        this.logger.warn(`No schedule found for device ${deviceId}`, LogContext.SCHEDULER);
        return false;
      }
      
      // Filter out the event to remove
      const initialCount = schedule.events.length;
      schedule.events = schedule.events.filter(e => e.id !== eventId);
      
      // Check if an event was actually removed
      if (schedule.events.length === initialCount) {
        this.logger.warn(`Event ${eventId} not found in schedule for device ${deviceId}`, LogContext.SCHEDULER);
        return false;
      }
      
      // Update schedule
      return this.setDeviceSchedule(schedule);
    } catch (error) {
      this.logger.error(
        `Failed to remove event: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.SCHEDULER
      );
      return false;
    }
  }
  
  /**
   * Enable or disable a device's schedule
   */
  public setScheduleEnabled(deviceId: string, enabled: boolean): boolean {
    try {
      // Get current schedule
      const schedule = this.schedules.get(deviceId);
      if (!schedule) {
        this.logger.warn(`No schedule found for device ${deviceId}`, LogContext.SCHEDULER);
        return false;
      }
      
      // Update enabled status
      schedule.enabled = enabled;
      
      // Activate or deactivate as needed
      if (enabled) {
        this.activateSchedule(deviceId);
      } else {
        this.deactivateSchedule(deviceId);
      }
      
      // Save changes
      this.schedules.set(deviceId, schedule);
      this.saveSchedules();
      
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to ${enabled ? 'enable' : 'disable'} schedule: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.SCHEDULER
      );
      return false;
    }
  }
  
  /**
   * Enable or disable a specific event in a device's schedule
   */
  public setEventEnabled(deviceId: string, eventId: string, enabled: boolean): boolean {
    try {
      // Get current schedule
      const schedule = this.schedules.get(deviceId);
      if (!schedule) {
        this.logger.warn(`No schedule found for device ${deviceId}`, LogContext.SCHEDULER);
        return false;
      }
      
      // Find the event
      const event = schedule.events.find(e => e.id === eventId);
      if (!event) {
        this.logger.warn(`Event ${eventId} not found in schedule for device ${deviceId}`, LogContext.SCHEDULER);
        return false;
      }
      
      // Update enabled status
      event.enabled = enabled;
      
      // Re-activate schedule to update timers
      if (schedule.enabled) {
        this.deactivateSchedule(deviceId);
        this.activateSchedule(deviceId);
      }
      
      // Save changes
      this.schedules.set(deviceId, schedule);
      this.saveSchedules();
      
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to ${enabled ? 'enable' : 'disable'} event: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.SCHEDULER
      );
      return false;
    }
  }
  
  /**
   * Get the current scheduler status for a device
   */
  public getSchedulerStatus(deviceId: string): SchedulerStatus {
    // Get current schedule
    const schedule = this.schedules.get(deviceId);
    if (!schedule) {
      return { enabled: false };
    }
    
    const status: SchedulerStatus = {
      enabled: schedule.enabled
    };
    
    // Get information about next event if any
    const nextEventInfo = this.nextEvents.get(deviceId);
    if (nextEventInfo) {
      const minutesUntil = Math.round((nextEventInfo.timestamp.getTime() - Date.now()) / 60000);
      
      status.nextEvent = {
        time: nextEventInfo.event.time,
        temperature: nextEventInfo.event.temperature,
        warmHug: nextEventInfo.event.warmHug,
        minutesUntil: minutesUntil
      };
    }
    
    // Get information about active warm hug process
    const activeWarmHug = this.activeWarmHugs.get(deviceId);
    if (activeWarmHug) {
      status.activeWarmHug = {
        targetTime: activeWarmHug.targetTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        targetTemp: activeWarmHug.targetTemp,
        currentStep: activeWarmHug.currentStep,
        totalSteps: activeWarmHug.totalSteps
      };
    }
    
    return status;
  }
  
  /**
   * Activate the schedule for a device
   */
  private activateSchedule(deviceId: string): void {
   // Validate deviceId is a string
  if (typeof deviceId !== 'string' || deviceId.trim() === '') {
    this.logger.error(`Invalid device ID for activation: ${deviceId}`, LogContext.SCHEDULER);
    return;
  }
    // Get device schedule
    const schedule = this.schedules.get(deviceId);
    if (!schedule || !schedule.enabled || schedule.events.length === 0) {
      return;
    }
    
    this.logger.info(`Activating schedule for device ${deviceId}`, LogContext.SCHEDULER);
    
    // Clear any existing timers
    this.clearDeviceTimers(deviceId);
    
    // Schedule the next event
    this.scheduleNextEvent(deviceId);
  }
  
  /**
   * Deactivate the schedule for a device
   */
  private deactivateSchedule(deviceId: string): void {
    this.logger.info(`Deactivating schedule for device ${deviceId}`, LogContext.SCHEDULER);
    
    // Clear all timers
    this.clearDeviceTimers(deviceId);
    
    // Remove from next events
    this.nextEvents.delete(deviceId);
    
    // Cancel any active warm hug
    this.cancelWarmHug(deviceId);
  }
  
  /**
   * Clear all timers for a device
   */
  private clearDeviceTimers(deviceId: string): void {
    // Clear event timer
    const eventTimer = this.eventTimers.get(deviceId);
    if (eventTimer) {
      clearTimeout(eventTimer);
      this.eventTimers.delete(deviceId);
    }
    
    // Clear warm hug timer
    const warmHugTimer = this.warmHugTimers.get(deviceId);
    if (warmHugTimer) {
      clearTimeout(warmHugTimer);
      this.warmHugTimers.delete(deviceId);
    }
  }
  
  /**
   * Schedule the next event for a device
   */
  private scheduleNextEvent(deviceId: string): void {
    // Get device schedule
    const schedule = this.schedules.get(deviceId);
    if (!schedule || !schedule.enabled || schedule.events.length === 0) {
      return;
    }
    
    // Get enabled events only
    const enabledEvents = schedule.events.filter(event => event.enabled);
    if (enabledEvents.length === 0) {
      this.logger.debug(`No enabled events for device ${deviceId}`, LogContext.SCHEDULER);
      return;
    }
    
    const now = new Date();
    const todayDay = now.getDay(); // 0-6, where 0 is Sunday
    
    // Find the next event to schedule
    let nextEvent: ScheduledEvent | null = null;
    let nextEventTime: Date | null = null;
    let daysUntilNextEvent = 0;
    
    // Look up to 7 days ahead to find the next event
    for (let daysAhead = 0; daysAhead < 7; daysAhead++) {
      const targetDay = (todayDay + daysAhead) % 7;
      
      // Find events scheduled for this day
      for (const event of enabledEvents) {
        // Skip if event is not scheduled for this day
        if (!event.days.includes(targetDay)) {
          continue;
        }
        
        // Parse event time
        const [hours, minutes] = event.time.split(':').map(Number);
        
        // Create a date object for this event time
        const eventTime = new Date(now);
        eventTime.setDate(now.getDate() + daysAhead);
        eventTime.setHours(hours, minutes, 0, 0);
        
        // Skip if event time is in the past (for today only)
        if (daysAhead === 0 && eventTime <= now) {
          continue;
        }
        
        // If this is the first valid event we've found, or if it's earlier than the current next event
        if (!nextEventTime || eventTime < nextEventTime) {
          nextEvent = event;
          nextEventTime = eventTime;
          daysUntilNextEvent = daysAhead;
        }
      }
      
      // If we found an event for this day, no need to look further
      if (nextEvent && daysUntilNextEvent === daysAhead) {
        break;
      }
    }
    
    // If no next event was found
    if (!nextEvent || !nextEventTime) {
      this.logger.debug(`No upcoming events found for device ${deviceId}`, LogContext.SCHEDULER);
      return;
    }
    
    // Calculate time until next event
    const msUntilNextEvent = nextEventTime.getTime() - now.getTime();
    const minutesUntil = Math.round(msUntilNextEvent / 60000);
    
    this.logger.info(
      `Next event for device ${deviceId} scheduled in ${minutesUntil} minutes ` +
      `(${nextEvent.time}, ${nextEvent.temperature}°C, Warm Hug: ${nextEvent.warmHug ? 'Yes' : 'No'})`,
      LogContext.SCHEDULER
    );
    
    // Store next event info
    const timer = setTimeout(() => {
      this.executeEvent(deviceId, nextEvent!);
    }, msUntilNextEvent);
    
    this.nextEvents.set(deviceId, {
      event: nextEvent,
      timestamp: nextEventTime,
      timer
    });
    
    this.eventTimers.set(deviceId, timer);
    
    // Schedule warm hug if enabled
    if (nextEvent.warmHug) {
      this.scheduleWarmHug(deviceId, nextEvent, nextEventTime);
    }
  }
  
  /**
   * Schedule a warm hug process for a device
   */
  private scheduleWarmHug(deviceId: string, event: ScheduledEvent, eventTime: Date): void {
    // Warm hug should start a certain time before the event
    const warmHugDuration = event.warmHugDuration || 20; // Default to 20 minutes
    const warmHugStartTime = new Date(eventTime.getTime() - warmHugDuration * 60 * 1000);
    
    // Skip if warm hug start time is in the past
    const now = new Date();
    if (warmHugStartTime <= now) {
      this.logger.debug(
        `Warm hug start time is in the past for device ${deviceId}, event at ${event.time}`,
        LogContext.SCHEDULER
      );
      return;
    }
    
    // Calculate time until warm hug should start
    const msUntilWarmHug = warmHugStartTime.getTime() - now.getTime();
    const minutesUntil = Math.round(msUntilWarmHug / 60000);
    
    this.logger.info(
      `Warm hug for device ${deviceId} scheduled in ${minutesUntil} minutes, ` +
      `${warmHugDuration} minutes before event at ${event.time}`,
      LogContext.SCHEDULER
    );
    
    // Schedule warm hug start
    const timer = setTimeout(() => {
      this.startWarmHug(deviceId, event.temperature, eventTime, warmHugDuration);
    }, msUntilWarmHug);
    
    this.warmHugTimers.set(deviceId, timer);
  }
  
  /**
   * Start a warm hug process for a device
   */
  private async startWarmHug(
    deviceId: string,
    targetTemp: number,
    targetTime: Date,
    duration: number
  ): Promise<void> {
    try {
      // Get current device status
      const deviceStatus = await this.api.getDeviceStatus(deviceId);
      if (!deviceStatus) {
        this.logger.error(`Failed to get device status for warm hug on device ${deviceId}`, LogContext.SCHEDULER);
        return;
      }
      
      // If device is off, turn it on first
      if (deviceStatus.powerState !== 'on') {
        await this.api.turnDeviceOn(deviceId, deviceStatus.currentTemperature);
      }
      
      const startTemp = deviceStatus.currentTemperature;
      const tempDiff = targetTemp - startTemp;
      
      // Calculate number of steps (1°C per minute)
      const totalSteps = Math.min(duration, Math.abs(Math.round(tempDiff)));
      
      // Don't start warm hug if temperature difference is too small
      if (totalSteps <= 0) {
        this.logger.debug(
          `Skipping warm hug for device ${deviceId}: ` +
          `current temp ${startTemp}°C is already close to target ${targetTemp}°C`,
          LogContext.SCHEDULER
        );
        return;
      }
      
      this.logger.info(
        `Starting warm hug for device ${deviceId}: ` +
        `${startTemp}°C → ${targetTemp}°C over ${totalSteps} minutes`,
        LogContext.SCHEDULER
      );
      
      // Store warm hug state
      this.activeWarmHugs.set(deviceId, {
        targetTime,
        targetTemp,
        startTemp,
        currentStep: 0,
        totalSteps
      });
      
      // Execute first step immediately
      this.executeWarmHugStep(deviceId);
    } catch (error) {
      this.logger.error(
        `Error starting warm hug: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.SCHEDULER
      );
    }
  }
  
  /**
   * Execute a step in the warm hug process
   */
  private async executeWarmHugStep(deviceId: string): Promise<void> {
    try {
      // Get warm hug state
      const warmHug = this.activeWarmHugs.get(deviceId);
      if (!warmHug) {
        this.logger.warn(`No active warm hug found for device ${deviceId}`, LogContext.SCHEDULER);
        return;
      }
      
      // Increment step
      warmHug.currentStep++;
      
      // Calculate current target temperature
      const stepProgress = warmHug.currentStep / warmHug.totalSteps;
      const tempDiff = warmHug.targetTemp - warmHug.startTemp;
      const currentTemp = warmHug.startTemp + (tempDiff * stepProgress);
      
      // Round to nearest 0.5°C
      const roundedTemp = Math.round(currentTemp * 2) / 2;
      
      this.logger.debug(
        `Warm hug step ${warmHug.currentStep}/${warmHug.totalSteps} for device ${deviceId}: ` +
        `Setting temperature to ${roundedTemp}°C`,
        LogContext.SCHEDULER
      );
      
      // Set the temperature
      await this.api.setTemperature(deviceId, roundedTemp);
      
      // Update warm hug state
      this.activeWarmHugs.set(deviceId, warmHug);
      
      // Schedule next step if not complete
      if (warmHug.currentStep < warmHug.totalSteps) {
        setTimeout(() => {
          this.executeWarmHugStep(deviceId);
        }, 60 * 1000); // One minute between steps
      } else {
        // Warm hug complete
        this.logger.info(`Warm hug complete for device ${deviceId}`, LogContext.SCHEDULER);
        this.activeWarmHugs.delete(deviceId);
      }
    } catch (error) {
      this.logger.error(
        `Error executing warm hug step: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.SCHEDULER
      );
    }
  }
  
  /**
   * Cancel an active warm hug process
   */
  private cancelWarmHug(deviceId: string): void {
    // Clear warm hug timer
    const warmHugTimer = this.warmHugTimers.get(deviceId);
    if (warmHugTimer) {
      clearTimeout(warmHugTimer);
      this.warmHugTimers.delete(deviceId);
    }
    
    // Remove active warm hug
    if (this.activeWarmHugs.has(deviceId)) {
      this.logger.info(`Canceling warm hug for device ${deviceId}`, LogContext.SCHEDULER);
      this.activeWarmHugs.delete(deviceId);
    }
  }
  
  /**
   * Execute a scheduled event
   */
  private async executeEvent(deviceId: string, event: ScheduledEvent): Promise<void> {
    try {
      this.logger.info(
        `Executing scheduled event for device ${deviceId}: ` +
        `Setting temperature to ${event.temperature}°C`,
        LogContext.SCHEDULER
      );
      
      // Get device status to check if it's on
      const deviceStatus = await this.api.getDeviceStatus(deviceId);
      
      if (deviceStatus) {
        let state = "auto"; // Default state
        
        if (deviceStatus.powerState !== 'on') {
          // Turn on the device with the target temperature
          await this.api.turnDeviceOn(deviceId, event.temperature);
          state = "auto"; // Device was turned on, so state is auto
        } else {
          // Device is already on, just set temperature
          await this.api.setTemperature(deviceId, event.temperature);
          state = "auto"; // Temperature was changed, state remains auto
        }
        
        // Emit event for successful execution
        this.emit('scheduledEventExecuted', {
          deviceId,
          temperature: event.temperature,
          state
        });
      } else {
        this.logger.error(`Failed to get device status for event execution on device ${deviceId}`, LogContext.SCHEDULER);
      }
    } catch (error) {
      this.logger.error(
        `Error executing event: ${error instanceof Error ? error.message : String(error)}`,
        LogContext.SCHEDULER
      );
    } finally {
      // Clean up
      this.nextEvents.delete(deviceId);
      this.eventTimers.delete(deviceId);
      
      // Schedule the next event
      setTimeout(() => {
        this.scheduleNextEvent(deviceId);
      }, 1000);
    }
  }
  
  /**
   * Generate a unique ID for an event
   */
  private generateEventId(): string {
    return 'evt_' + Math.random().toString(36).substring(2, 15) + 
           Math.random().toString(36).substring(2, 15);
  }
  
  /**
   * Clean up resources when shutting down
   */
  public cleanup(): void {
    this.logger.info('Cleaning up scheduler resources', LogContext.SCHEDULER);
    
    // Clear all timers
    this.eventTimers.forEach(timer => clearTimeout(timer));
    this.warmHugTimers.forEach(timer => clearTimeout(timer));
    
    // Clear maps
    this.eventTimers.clear();
    this.warmHugTimers.clear();
    this.activeWarmHugs.clear();
    this.nextEvents.clear();
  }}