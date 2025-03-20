/**
 * Enhanced logger utility with context-aware logging
 * and support for debug/verbose modes
 */
import { Logger } from 'homebridge';

/**
 * Logger context types for more detailed logging
 */
export enum LogContext {
  PLATFORM = 'PLATFORM',
  API = 'API',
  ACCESSORY = 'ACCESSORY',
  CHARACTERISTIC = 'CHARACTERISTIC',
  HOMEKIT = 'HOMEKIT',
  SCHEDULER = 'SCHEDULER'
}

/**
 * Enhanced logger with context support and debug mode
 */
export class EnhancedLogger {
  private readonly timestampEnabled: boolean;
  private readonly debugMode: boolean;

  constructor(
    private readonly logger: Logger,
    debugMode = false,
    timestampEnabled = true
  ) {
    this.debugMode = debugMode;
    this.timestampEnabled = timestampEnabled;
  }
  
  /**
   * Enable or disable debug mode
   */
  public setDebugMode(enabled: boolean): void {
    (this as any).debugMode = enabled;
  }
  
  /**
   * Format a message with timestamp and context
   */
  private formatMessage(message: string, context?: LogContext): string {
    let formattedMessage = '';
    
    // Add timestamp if enabled
    if (this.timestampEnabled) {
      formattedMessage += `[${new Date().toISOString()}] `;
    }
    
    // Add context if provided
    if (context) {
      formattedMessage += `[${context}] `;
    }
    
    // Add the actual message
    formattedMessage += message;
    
    return formattedMessage;
  }
  
  /**
   * Log an informational message
   */
  public info(message: string, context?: LogContext): void {
    this.logger.info(this.formatMessage(message, context));
  }
  
  /**
   * Log a warning message
   */
  public warn(message: string, context?: LogContext): void {
    this.logger.warn(this.formatMessage(message, context));
  }
  
  /**
   * Log an error message
   */
  public error(message: string, context?: LogContext): void {
    this.logger.error(this.formatMessage(message, context));
  }
  
  /**
   * Log a debug message (only in debug mode)
   */
  public debug(message: string, context?: LogContext): void {
    if (this.debugMode) {
      this.logger.debug(this.formatMessage(message, context));
    }
  }
  
  /**
   * Log a verbose debug message (only in debug mode)
   */
  public verbose(message: string, context?: LogContext): void {
    if (this.debugMode) {
      this.logger.debug(this.formatMessage(`VERBOSE: ${message}`, context));
    }
  }
  
  /**
   * Log a HomeKit interaction
   */
  public homekit(action: string, characteristic: string, value?: any): void {
    let message = `HomeKit ${action}: ${characteristic}`;
    if (value !== undefined) {
      message += ` → ${JSON.stringify(value)}`;
    }
    
    this.debug(message, LogContext.HOMEKIT);
  }
  
  /**
   * Log an API request or response
   */
  public api(method: string, endpoint: string, status?: number, data?: any): void {
    let message = `${method} ${endpoint}`;
    if (status) {
      message += ` (Status: ${status})`;
    }
    
    this.debug(message, LogContext.API);
    
    if (data && this.debugMode) {
      try {
        this.verbose(`${method} ${endpoint} data: ${JSON.stringify(data)}`, LogContext.API);
      } catch (error) {
        this.verbose(`${method} ${endpoint} data: [Cannot stringify data]`, LogContext.API);
      }
    }
  }
  
  /**
   * Log accessory state
   */
  public state(deviceId: string, state: Record<string, any>): void {
    this.debug(`Device ${deviceId} state: ${JSON.stringify(state)}`, LogContext.ACCESSORY);
  }
}
