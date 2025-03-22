/**
 * Enhanced logger utility with context-aware logging
 * and support for debug/verbose modes with configurable log levels
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
 * Log levels to control verbosity
 */
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  VERBOSE = 4
}

/**
 * Enhanced logger with context support and configurable verbosity
 */
export class EnhancedLogger {
  private readonly timestampEnabled: boolean;
  private readonly logLevel: LogLevel;

  constructor(
    private readonly logger: Logger,
    debugMode = false,
    timestampEnabled = true,
    verboseLogging = false
  ) {
    // Set appropriate log level based on config
    if (verboseLogging) {
      this.logLevel = LogLevel.VERBOSE;
    } else if (debugMode) {
      this.logLevel = LogLevel.DEBUG;
    } else {
      this.logLevel = LogLevel.INFO;
    }
    
    this.timestampEnabled = timestampEnabled;
  }
  
  /**
   * Enable or disable debug mode
   */
  public setDebugMode(enabled: boolean): void {
    // This now controls whether we're at DEBUG level or not
    if (enabled) {
      (this as any).logLevel = LogLevel.DEBUG;
    } else {
      (this as any).logLevel = LogLevel.INFO;
    }
  }
  
  /**
   * Set verbosity level
   */
  public setVerboseMode(enabled: boolean): void {
    if (enabled) {
      (this as any).logLevel = LogLevel.VERBOSE;
    } else if ((this as any).logLevel === LogLevel.VERBOSE) {
      // Only downgrade if currently verbose
      (this as any).logLevel = LogLevel.DEBUG;
    }
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
    if (this.logLevel >= LogLevel.INFO) {
      this.logger.info(this.formatMessage(message, context));
    }
  }
  
  /**
   * Log a warning message
   */
  public warn(message: string, context?: LogContext): void {
    if (this.logLevel >= LogLevel.WARN) {
      this.logger.warn(this.formatMessage(message, context));
    }
  }
  
  /**
   * Log an error message - always shown regardless of log level
   */
  public error(message: string, context?: LogContext): void {
    this.logger.error(this.formatMessage(message, context));
  }
  
  /**
   * Log a debug message (only in debug mode or higher)
   */
  public debug(message: string, context?: LogContext): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      this.logger.debug(this.formatMessage(message, context));
    }
  }
  
  /**
   * Log a verbose debug message (only in verbose mode)
   */
  public verbose(message: string, context?: LogContext): void {
    if (this.logLevel >= LogLevel.VERBOSE) {
      this.logger.debug(this.formatMessage(`VERBOSE: ${message}`, context));
    }
  }
  
  /**
   * Log wait messages at very verbose level
   */
  public waitMessage(message: string): void {
    // Only log these at VERBOSE level and only when under specific conditions
    if (this.logLevel >= LogLevel.VERBOSE) {
      // Only log every 10th wait message to reduce spam
      if (message.includes('Waiting') && Math.random() < 0.1) {
        this.logger.debug(this.formatMessage(message, LogContext.API));
      }
    }
  }
  
  /**
   * Log a HomeKit interaction
   */
  public homekit(action: string, characteristic: string, value?: any): void {
    const message = `HomeKit ${action}: ${characteristic}` + 
      (value !== undefined ? ` → ${JSON.stringify(value)}` : '');
    
    this.debug(message, LogContext.HOMEKIT);
  }
  
  /**
   * Log an API request or response
   */
  public api(method: string, endpoint: string, status?: number, data?: any): void {
    // Always log completed requests (with status)
    if (status) {
      const message = `${method} ${endpoint} (Status: ${status})`;
      this.debug(message, LogContext.API);
      
      // Only log data at verbose level
      if (data && this.logLevel >= LogLevel.VERBOSE) {
        try {
          this.verbose(`${method} ${endpoint} data: ${JSON.stringify(data)}`, LogContext.API);
        } catch {
          this.verbose(`${method} ${endpoint} data: [Cannot stringify data]`, LogContext.API);
        }
      }
    } else {
      // Starting requests only logged at debug level
      if (this.logLevel >= LogLevel.DEBUG) {
        this.debug(`${method} ${endpoint}`, LogContext.API);
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