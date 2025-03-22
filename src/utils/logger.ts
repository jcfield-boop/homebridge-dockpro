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
  VERBOSE = 4,
  API_DETAIL = 5
}

/**
 * Valid log level string values for configuration
 */
export type LogLevelString = 'normal' | 'debug' | 'verbose';

/**
 * Enhanced logger with context support and configurable verbosity
 */
export class EnhancedLogger {
  private readonly logLevel: LogLevel;

  /**
   * Create a new enhanced logger
   * 
   * @param logger - Homebridge logger instance
   * @param logLevelInput - Log level specification (string, boolean or object)
   * @param timestampEnabled - Whether to include timestamps in log messages
   */
  constructor(
    private readonly logger: Logger,
    logLevelInput: string | boolean | {debugMode?: boolean, verboseLogging?: boolean} = 'normal',
    private readonly timestampEnabled = true
  ) {
    // Convert any string input to a valid LogLevel
    this.logLevel = this.determineLogLevel(logLevelInput);
    
    // Log the selected level on startup
    const levelNames = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE', 'API_DETAIL'];
    this.info(`Logger initialized at ${levelNames[this.logLevel]} level`, LogContext.PLATFORM);
  }
  
  /**
   * Determine LogLevel from various input formats
   * Handles both string-based config and legacy boolean flags
   */
  private determineLogLevel(
    input: string | boolean | {debugMode?: boolean, verboseLogging?: boolean}
  ): LogLevel {
    // Handle string input (both typed and untyped)
    if (typeof input === 'string') {
      switch (input.toLowerCase()) {
        case 'verbose': return LogLevel.VERBOSE;
        case 'debug': return LogLevel.DEBUG;
        case 'normal': 
        default: return LogLevel.INFO;
      }
    }
    
    // Handle boolean debug flag (legacy)
    if (typeof input === 'boolean') {
      return input ? LogLevel.DEBUG : LogLevel.INFO;
    }
    
    // Handle object with boolean flags (legacy)
    if (input && typeof input === 'object') {
      if (input.verboseLogging) {
        return LogLevel.VERBOSE;
      } else if (input.debugMode) {
        return LogLevel.DEBUG;
      }
    }
    
    // Default fallback
    return LogLevel.INFO;
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
   * Modified to improve visibility in logs
   */
  public verbose(message: string, context?: LogContext): void {
    if (this.logLevel >= LogLevel.VERBOSE) {
      // Don't prepend "VERBOSE:" as it makes logs harder to read
      this.logger.debug(this.formatMessage(message, context));
    }
  }
  
  /**
   * NEW: Log detailed API information (only in highest verbosity mode)
   * For extremely detailed debugging of API calls, parameters, responses, etc.
   */
  public apiDetail(message: string): void {
    if (this.logLevel >= LogLevel.API_DETAIL) {
      this.logger.debug(this.formatMessage(`API_DETAIL: ${message}`, LogContext.API));
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
      this.info(message, LogContext.API);
      
      // Only log data at verbose level or higher
      if (data && this.logLevel >= LogLevel.VERBOSE) {
        try {
          this.verbose(`${method} ${endpoint} data: ${JSON.stringify(data)}`, LogContext.API);
        } catch {
          this.verbose(`${method} ${endpoint} data: [Cannot stringify data]`, LogContext.API);
        }
      }
    } else {
      // Starting requests logged at info level
      if (this.logLevel >= LogLevel.INFO) {
        this.info(`${method} ${endpoint}`, LogContext.API);
      }
    }
  }
  
  /**
   * Log API wait/throttling information
   * Only logs at API_DETAIL level to reduce noise
   */
  public apiWait(message: string): void {
    if (this.logLevel >= LogLevel.API_DETAIL) {
      this.debug(`Wait: ${message}`, LogContext.API);
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

  /**
   * NEW: Check if verbose logging is enabled
   * Utility method to avoid unnecessary string concatenation in verbose logs
   */
  public isVerboseEnabled(): boolean {
    return this.logLevel >= LogLevel.VERBOSE;
  }

  /**
   * NEW: Check if API detail logging is enabled
   */
  public isApiDetailEnabled(): boolean {
    return this.logLevel >= LogLevel.API_DETAIL;
  }
}