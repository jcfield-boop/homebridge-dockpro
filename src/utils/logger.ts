/**
 * Enhanced logger utility with context-aware logging
 * and configurable verbosity levels
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
  private readonly logLevel: LogLevel;

  /**
   * Create a new enhanced logger
   * 
   * @param logger - Homebridge logger instance
   * @param logLevelString - Log level as string or legacy boolean options
   * @param timestampEnabled - Whether to include timestamps in log messages
   */
  constructor(
    private readonly logger: Logger,
    logLevelString: string | boolean | {debugMode?: boolean, verboseLogging?: boolean} = 'normal',
    private readonly timestampEnabled = true
  ) {
    // Handle different input types for backward compatibility
    if (typeof logLevelString === 'string') {
      // New string-based config
      switch (logLevelString) {
        case 'verbose':
          this.logLevel = LogLevel.VERBOSE;
          break;
        case 'debug':
          this.logLevel = LogLevel.DEBUG;
          break;
        default:
          this.logLevel = LogLevel.INFO;
      }
    } else if (typeof logLevelString === 'boolean') {
      // Legacy boolean debug mode
      this.logLevel = logLevelString ? LogLevel.DEBUG : LogLevel.INFO;
    } else if (typeof logLevelString === 'object') {
      // Legacy combined options
      const config = logLevelString;
      if (config.verboseLogging) {
        this.logLevel = LogLevel.VERBOSE;
      } else if (config.debugMode) {
        this.logLevel = LogLevel.DEBUG;
      } else {
        this.logLevel = LogLevel.INFO;
      }
    } else {
      // Default to INFO level
      this.logLevel = LogLevel.INFO;
    }
    
    // Log the selected level on startup
    const levelNames = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE'];
    this.info(`Logger initialized at ${levelNames[this.logLevel]} level`, LogContext.PLATFORM);
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
   * Log a HomeKit interaction
   */
  public homekit(action: string, characteristic: string, value?: any): void {
    if (this.logLevel >= LogLevel.DEBUG) {
      const message = `HomeKit ${action}: ${characteristic}` + 
        (value !== undefined ? ` → ${JSON.stringify(value)}` : '');
      
      this.debug(message, LogContext.HOMEKIT);
    }
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
  
  /**
   * Get current log level
   */
  public getLogLevel(): LogLevel {
    return this.logLevel;
  }
}