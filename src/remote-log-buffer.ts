import pino from 'pino';
import type { WriteOutcome } from './remote-log-buffer.types.js';

type LogRecord = Record<string, unknown>;

type RemoteLogBufferOptions = {
  sourceUrl: string;
  sourceToken: string;
  /** Records below this level leave only when marked `ship: true`. */
  shipLevel: pino.Level;
  fetchImplementation?: typeof fetch;
};

const MAX_BUFFERED_RECORDS = 100;
const SEND_TIMEOUT_MS = 3000;
const ERROR_LEVEL = pino.levels.values.error ?? 50;
const WARN_LEVEL = pino.levels.values.warn ?? 40;

function isRecord(value: unknown): value is LogRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(line: string): LogRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Accepts pino's numeric levels and the labels a `formatters.level` hook writes instead. */
function levelOf(record: LogRecord): number {
  if (typeof record.level === 'number') {
    return record.level;
  }
  if (typeof record.level === 'string') {
    return pino.levels.values[record.level] ?? 0;
  }
  return 0;
}

/**
 * Batches log lines for a Better Stack HTTP source. It never throws and never logs its own
 * failures: a log line about a failed send would feed this same buffer and fail the same way on
 * every flush. Whoever owns it decides when to flush — a request's `after` hook on a serverless
 * function, a timer on a long-running process.
 */
export class RemoteLogBuffer {
  private readonly sourceUrl: string;
  private readonly sourceToken: string;
  private readonly shipLevel: number;
  private readonly fetchImplementation: typeof fetch;
  private buffer: LogRecord[] = [];
  private droppedRecords = 0;
  private inFlight: Promise<void> | null = null;

  constructor(options: RemoteLogBufferOptions) {
    this.sourceUrl = options.sourceUrl;
    this.sourceToken = options.sourceToken;
    this.shipLevel = pino.levels.values[options.shipLevel] ?? WARN_LEVEL;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public write(line: string): WriteOutcome {
    const record = parse(line);
    if (!record || record.localOnly === true) {
      return 'skipped';
    }
    const level = levelOf(record);
    if (level < this.shipLevel && record.ship !== true) {
      return 'skipped';
    }
    if (this.buffer.length >= MAX_BUFFERED_RECORDS) {
      this.buffer.shift();
      this.droppedRecords += 1;
    }
    this.buffer.push(record);
    // An error is often followed by the process or invocation dying, so it should go out now.
    return level >= ERROR_LEVEL ? 'urgent' : 'buffered';
  }

  public get size(): number {
    return this.buffer.length;
  }

  /** Sends everything buffered; concurrent callers share one send. */
  public async flush(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
    }
    if (this.buffer.length === 0) {
      return;
    }
    this.inFlight = this.send(this.takeBatch());
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private takeBatch(): LogRecord[] {
    const batch = this.buffer;
    this.buffer = [];
    if (this.droppedRecords > 0) {
      batch.push({
        level: WARN_LEVEL,
        time: Date.now(),
        msg: 'remote_log_records_dropped',
        droppedRecords: this.droppedRecords,
      });
      this.droppedRecords = 0;
    }
    return batch;
  }

  private async send(batch: LogRecord[]): Promise<void> {
    try {
      await this.fetchImplementation(this.sourceUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.sourceToken}`,
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      // Dropped: see the class comment.
    }
  }
}
