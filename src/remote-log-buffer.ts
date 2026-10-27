import pino from 'pino';
import type { WriteOutcome } from './remote-log-buffer.types.js';

type LogRecord = Record<string, unknown>;

type RemoteLogBufferOptions = {
  sourceUrl: string;
  sourceToken: string;
  /** Records below this level leave only when marked `ship: true`. */
  shipLevel: pino.Level;
  service: string;
  fetchImplementation?: typeof fetch;
};

const MAX_BUFFERED_RECORDS = 100;
const SEND_TIMEOUT_MS = 3000;
const WARN_LEVEL = 40;
const ERROR_LEVEL = 50;
const LEADING_LEVEL = /^\{"level":(?:"(\w+)"|(\d+))/;

/**
 * Batches log lines for a Better Stack HTTP source. It never throws and never logs into itself: a
 * log line about a failed send would feed this same buffer and fail the same way on every flush.
 * A rejected send is reported once on stderr instead, where the host's own log capture sees it.
 * Whoever owns the buffer decides when to flush — a request's `after` hook on a serverless
 * function, a timer on a long-running process.
 */
export class RemoteLogBuffer {
  private readonly sourceUrl: string;
  private readonly sourceToken: string;
  private readonly shipLevel: number;
  private readonly service: string;
  private readonly fetchImplementation: typeof fetch;
  private buffer: LogRecord[] = [];
  private droppedRecords = 0;
  private readonly pendingSends = new Set<Promise<void>>();
  private lastRejectedStatus: number | null = null;

  public constructor(options: RemoteLogBufferOptions) {
    this.sourceUrl = options.sourceUrl;
    this.sourceToken = options.sourceToken;
    this.shipLevel = pino.levels.values[options.shipLevel] ?? WARN_LEVEL;
    this.service = options.service;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public write(line: string): WriteOutcome {
    const quickLevel = RemoteLogBuffer.leadingLevel(line);
    const isSkippedWithoutParsing =
      quickLevel !== null && quickLevel < this.shipLevel && !line.includes('"ship":true');
    if (isSkippedWithoutParsing) {
      return 'skipped';
    }
    const record = RemoteLogBuffer.parse(line);
    if (!record || record.localOnly === true) {
      return 'skipped';
    }
    const level = RemoteLogBuffer.levelNumber(record.level);
    const isBelowShipLevel = level < this.shipLevel && record.ship !== true;
    if (isBelowShipLevel) {
      return 'skipped';
    }
    if (this.buffer.length >= MAX_BUFFERED_RECORDS) {
      this.buffer.shift();
      this.droppedRecords += 1;
    }
    this.buffer.push(RemoteLogBuffer.withTimestamp(record));
    // An error is often followed by the process or invocation dying; a full buffer drops records.
    const mustShipNow = level >= ERROR_LEVEL || this.buffer.length >= MAX_BUFFERED_RECORDS;
    return mustShipNow ? 'urgent' : 'buffered';
  }

  /**
   * Sends what is buffered at once, beside any send already under way, and resolves once every
   * send has landed — including records written while it waited.
   */
  public async flush(): Promise<void> {
    while (this.buffer.length > 0 || this.pendingSends.size > 0) {
      if (this.buffer.length > 0) {
        this.track(this.send(this.takeBatch()));
      }
      await Promise.all(this.pendingSends);
    }
  }

  private track(send: Promise<void>): void {
    this.pendingSends.add(send);
    void this.forgetWhenSettled(send);
  }

  private async forgetWhenSettled(send: Promise<void>): Promise<void> {
    try {
      await send;
    } finally {
      this.pendingSends.delete(send);
    }
  }

  private takeBatch(): LogRecord[] {
    const batch = this.buffer;
    this.buffer = [];
    if (this.droppedRecords > 0) {
      batch.push(
        RemoteLogBuffer.withTimestamp({
          level: 'warn',
          time: Date.now(),
          service: this.service,
          msg: 'remote_log_records_dropped',
          droppedRecords: this.droppedRecords,
        }),
      );
      this.droppedRecords = 0;
    }
    return batch;
  }

  private async send(batch: LogRecord[]): Promise<void> {
    try {
      const response = await this.fetchImplementation(this.sourceUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.sourceToken}`,
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      this.noteResponseStatus(response.ok ? null : response.status);
    } catch {
      // A network failure drops the batch; see the class comment.
    }
  }

  /** Once per change, so a revoked token says so without flooding the host's logs. */
  private noteResponseStatus(rejectedStatus: number | null): void {
    const isNewRejection = rejectedStatus !== null && rejectedStatus !== this.lastRejectedStatus;
    if (isNewRejection) {
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', service: this.service, msg: 'remote_log_batch_rejected', status: rejectedStatus })}\n`,
      );
    }
    this.lastRejectedStatus = rejectedStatus;
  }

  private static isRecord(value: unknown): value is LogRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private static parse(line: string): LogRecord | null {
    try {
      const value: unknown = JSON.parse(line);
      return RemoteLogBuffer.isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }

  private static levelNumber(level: unknown): number {
    if (typeof level === 'number') {
      return level;
    }
    if (typeof level === 'string') {
      return pino.levels.values[level] ?? 0;
    }
    return 0;
  }

  /** Reads the level pino writes as the first key, so a record below the ship level skips JSON.parse. */
  private static leadingLevel(line: string): number | null {
    const match = LEADING_LEVEL.exec(line);
    if (!match) {
      return null;
    }
    return match[1] ? RemoteLogBuffer.levelNumber(match[1]) : Number(match[2]);
  }

  /** Better Stack orders a batch by `dt`; without it every record shows the batch's arrival time. */
  private static withTimestamp(record: LogRecord): LogRecord {
    const time = typeof record.time === 'number' ? record.time : Date.now();
    return { ...record, dt: new Date(time).toISOString() };
  }
}
