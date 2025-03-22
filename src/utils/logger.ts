/**
 * Enhanced logger utility with context-aware logging
 * and configurable verbosity levels
 */
import { Logger } from 'homebridge';

/**
 * Logger context types for categorizing log messages
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
  ERROR = 0,  // Always shown
  WARN = 1,   // Warnings
  INFO = 2,   // Normal information
  DEBUG = 3,  // Detailed debugging info
  VERBOSE = 4 // Very detailed logs
}

/**
 * Valid log level string values for configuration
 */
export type LogLevelString = 'normal' | 'debug' | 'verbose' | 'api_detail';

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
    // Convert any input format to a valid LogLevel
    this.logLevel = this.determineLogLevel(logLevelInput);
    
    // Log the selected level on startup
    const levelNames = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE'];
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
        case 'api_detail': return LogLevel.VERBOSE; // Map api_detail to VERBOSE for simplicity
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
   */
  public verbose(message: string, context?: LogContext): void {
    if (this.logLevel >= LogLevel.VERBOSE) {
      // Use debug level for verbose messages to avoid cluttering output
      this.logger.debug(this.formatMessage(message, context));
    }
  }
  
  /**
   * API detail logging - maps to verbose level for simplicity
   */
  public apiDetail(message: string): void {
    if (this.logLevel >= LogLevel.VERBOSE) {
      this.logger.debug(this.formatMessage(`API_DETAIL: ${message}`, LogContext.API));
    }
  }
  
  /**
   * Check if verbose logging is enabled
   * Utility method to avoid unnecessary string concatenation in verbose logs
   */
  public isVerboseEnabled(): boolean {
    return this.logLevel >= LogLevel.VERBOSE;
  }

  /**
   * Check if API detail logging is enabled
   * For backward compatibility, maps to verbose level
   */
  public isApiDetailEnabled(): boolean {
    return this.logLevel >= LogLevel.VERBOSE;
  }
}