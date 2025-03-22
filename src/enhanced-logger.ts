/**
 * Enhanced logger utility with context-aware logging and configurable verbosity
 */
import { Logger } from 'homebridge';

/**
 * Logger context types for more detailed logging
 */
export enum LogContext {
  PLATFORM = 'PLATFORM',
  API = 'API',
  ACCESSORY = 'ACCESSORY',
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
   * @param logLevelInput - Log level specification (string)
   * @param timestampEnabled - Whether to include timestamps in log messages
   */
  constructor(
    private readonly logger: Logger,
    logLevelInput: LogLevelString = 'normal',
    private readonly timestampEnabled = true
  ) {
    // Set log level based on input
    switch (logLevelInput) {
      case 'verbose':
        this.logLevel = LogLevel.VERBOSE;
        break;
      case 'debug':
        this.logLevel = LogLevel.DEBUG;
        break;
      case 'normal':
      default:
        this.logLevel = LogLevel.INFO;
        break;
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
      this.logger.debug(this.formatMessage(message, context));
    }
  }
  
  /**
   * Check if verbose logging is enabled
   */
  public isVerboseEnabled(): boolean {
    return this.logLevel >= LogLevel.VERBOSE;
  }

  /**
   * Check if debug logging is enabled
   */
  public isDebugEnabled(): boolean {
    return this.logLevel >= LogLevel.DEBUG;
  }
}