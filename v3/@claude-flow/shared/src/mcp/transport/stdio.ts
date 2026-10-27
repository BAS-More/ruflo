/**
 * V3 MCP Stdio Transport
 *
 * Standard I/O transport for MCP communication:
 * - Optimized JSON parsing with streaming
 * - Per-message byte cap (DEFAULT_MAX_MESSAGE_BYTES)
 * - Graceful shutdown handling
 *
 * Performance Targets:
 * - Message parsing: <5ms
 * - Response sending: <2ms
 */

import { EventEmitter } from 'events';
import {
  ITransport,
  TransportType,
  MCPRequest,
  MCPResponse,
  MCPNotification,
  RequestHandler,
  NotificationHandler,
  TransportHealthStatus,
  ILogger,
} from '../types.js';
import { LineSplitter, LineEvent, resolveMaxMessageBytes } from './limits.js';

/**
 * Stdio Transport Configuration
 */
export interface StdioTransportConfig {
  inputStream?: NodeJS.ReadableStream;
  outputStream?: NodeJS.WritableStream;
  maxMessageSize?: number;
}

/**
 * Stdio Transport Implementation
 *
 * Splits stdin on raw bytes with a size-capped LineSplitter (transport/limits.ts)
 */
export class StdioTransport extends EventEmitter implements ITransport {
  public readonly type: TransportType = 'stdio';

  private requestHandler?: RequestHandler;
  private notificationHandler?: NotificationHandler;
  private splitter?: LineSplitter;
  private onData?: (chunk: Buffer | string) => void;
  private onEnd?: () => void;
  private running = false;
  private messageBuffer = '';

  // Statistics
  private messagesReceived = 0;
  private messagesSent = 0;
  private errors = 0;

  private readonly inputStream: NodeJS.ReadableStream;
  private readonly outputStream: NodeJS.WritableStream;
  private readonly maxMessageSize: number;

  constructor(
    private readonly logger: ILogger,
    config: StdioTransportConfig = {}
  ) {
    super();
    this.inputStream = config.inputStream || process.stdin;
    this.outputStream = config.outputStream || process.stdout;
    this.maxMessageSize = resolveMaxMessageBytes(config.maxMessageSize); // 1 MiB default
  }

  /**
   * Start the transport
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Stdio transport already running');
    }

    this.logger.info('Starting stdio transport');

    // Split on raw bytes rather than readline, which buffers a line of any
    // length before it can be measured.
    const splitter = new LineSplitter(this.maxMessageSize);
    this.splitter = splitter;
    this.onData = (chunk) => this.dispatch(splitter.push(chunk));

    // Handle close: flush a final unterminated line first
    this.onEnd = () => {
      this.dispatch(splitter.end());
      this.detach();
      this.handleClose();
    };
    this.inputStream.on('data', this.onData);
    this.inputStream.on('end', this.onEnd);

    // Handle errors on input stream
    this.inputStream.on('error', (error) => {
      this.handleError(error);
    });

    this.running = true;
    this.logger.info('Stdio transport started');
  }

  /**
   * Stop the transport
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping stdio transport');
    this.running = false;

    if (this.splitter) {
      this.detach();
      this.inputStream.pause();
      this.handleClose();
    }

    this.logger.info('Stdio transport stopped');
  }

  /**
   * Register request handler
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  /**
   * Register notification handler
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Get health status
   */
  async getHealthStatus(): Promise<TransportHealthStatus> {
    return {
      healthy: this.running,
      metrics: {
        messagesReceived: this.messagesReceived,
        messagesSent: this.messagesSent,
        errors: this.errors,
      },
    };
  }

  /**
   * Remove the input listeners
   */
  private detach(): void {
    if (this.onData) this.inputStream.removeListener('data', this.onData);
    if (this.onEnd) this.inputStream.removeListener('end', this.onEnd);
    this.onData = undefined;
    this.onEnd = undefined;
    this.splitter = undefined;
  }

  /**
   * Route splitter output
   */
  private dispatch(events: LineEvent[]): void {
    for (const event of events) {
      if ('line' in event) {
        this.handleLine(event.line);
      } else {
        this.handleOversized(event.oversized);
      }
    }
  }

  /**
   * Reply to a line over the size cap; the splitter discards the rest of it
   */
  private handleOversized(seen: number): void {
    this.logger.warn('Message exceeds maximum size', {
      size: seen,
      max: this.maxMessageSize,
    });
    this.sendError(null, -32600, `Message exceeds maximum size of ${this.maxMessageSize} bytes`)
      .catch(() => undefined);
  }

  /**
   * Handle incoming line
   */
  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    try {
      const message = JSON.parse(line);
      this.messagesReceived++;

      // Validate JSON-RPC format
      if (message.jsonrpc !== '2.0') {
        this.logger.warn('Invalid JSON-RPC version', { received: message.jsonrpc });
        await this.sendError(message.id, -32600, 'Invalid JSON-RPC version');
        return;
      }

      if (!message.method) {
        this.logger.warn('Missing method in request');
        await this.sendError(message.id, -32600, 'Missing method');
        return;
      }

      // Determine if this is a request or notification
      if (message.id !== undefined) {
        // Request - needs response
        await this.handleRequest(message as MCPRequest);
      } else {
        // Notification - no response needed
        await this.handleNotification(message as MCPNotification);
      }
    } catch (error) {
      this.errors++;
      this.logger.error('Failed to parse message', { error, line: line.substring(0, 100) });
      await this.sendError(null, -32700, 'Parse error');
    }
  }

  /**
   * Handle MCP request
   */
  private async handleRequest(request: MCPRequest): Promise<void> {
    if (!this.requestHandler) {
      this.logger.warn('No request handler registered');
      await this.sendError(request.id, -32603, 'No request handler');
      return;
    }

    try {
      const startTime = performance.now();
      const response = await this.requestHandler(request);
      const duration = performance.now() - startTime;

      this.logger.debug('Request processed', {
        method: request.method,
        duration: `${duration.toFixed(2)}ms`,
      });

      await this.sendResponse(response);
    } catch (error) {
      this.logger.error('Request handler error', { method: request.method, error });
      await this.sendError(
        request.id,
        -32603,
        error instanceof Error ? error.message : 'Internal error'
      );
    }
  }

  /**
   * Handle MCP notification
   */
  private async handleNotification(notification: MCPNotification): Promise<void> {
    if (!this.notificationHandler) {
      this.logger.debug('Notification received but no handler', { method: notification.method });
      return;
    }

    try {
      await this.notificationHandler(notification);
    } catch (error) {
      this.logger.error('Notification handler error', { method: notification.method, error });
      // Notifications don't send error responses
    }
  }

  /**
   * Send response to stdout
   */
  private async sendResponse(response: MCPResponse): Promise<void> {
    const json = JSON.stringify(response);
    await this.write(json);
    this.messagesSent++;
  }

  /**
   * Send error response
   */
  private async sendError(id: string | number | null, code: number, message: string): Promise<void> {
    const response: MCPResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    await this.sendResponse(response);
    this.errors++;
  }

  /**
   * Send notification to stdout
   */
  async sendNotification(notification: MCPNotification): Promise<void> {
    const json = JSON.stringify(notification);
    await this.write(json);
    this.messagesSent++;
  }

  /**
   * Write to output stream
   */
  private write(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.outputStream.write(data + '\n', (error) => {
        if (error) {
          this.errors++;
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Handle stream close
   */
  private handleClose(): void {
    this.logger.info('Stdio stream closed');
    this.running = false;
    this.emit('close');
  }

  /**
   * Handle stream error
   */
  private handleError(error: Error): void {
    this.logger.error('Stdio stream error', error);
    this.errors++;
    this.emit('error', error);
  }
}

/**
 * Create stdio transport
 */
export function createStdioTransport(
  logger: ILogger,
  config: StdioTransportConfig = {}
): StdioTransport {
  return new StdioTransport(logger, config);
}
