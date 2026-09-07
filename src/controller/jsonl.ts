import type { Readable } from "node:stream";

export class JsonlProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonlProtocolError";
  }
}

export class StrictJsonlDecoder {
  private buffer = Buffer.alloc(0);
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: true });

  constructor(
    private readonly maxLineBytes: number,
    private readonly onRecord: (record: unknown) => void,
  ) {}

  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.buffer = this.buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.buffer, bytes]);
    this.drain(false);
  }

  end(): void {
    this.drain(true);
  }

  private drain(atEnd: boolean): void {
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      this.emit(line);
    }
    if (this.buffer.length > this.maxLineBytes) {
      throw new JsonlProtocolError(`JSONL record exceeds ${this.maxLineBytes} bytes`);
    }
    if (atEnd && this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.emit(line);
    }
  }

  private emit(bytes: Buffer): void {
    const line = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
    if (line.length === 0) return;
    if (line.length > this.maxLineBytes) {
      throw new JsonlProtocolError(`JSONL record exceeds ${this.maxLineBytes} bytes`);
    }
    let text: string;
    try {
      text = this.textDecoder.decode(line);
    } catch {
      throw new JsonlProtocolError("RPC stdout contains invalid UTF-8");
    }
    try {
      this.onRecord(JSON.parse(text));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new JsonlProtocolError(`Invalid JSONL record: ${message}`);
    }
  }
}

export function attachStrictJsonlReader(
  stream: Readable,
  maxLineBytes: number,
  onRecord: (record: unknown) => void,
  onError: (error: Error) => void,
): () => void {
  const decoder = new StrictJsonlDecoder(maxLineBytes, onRecord);
  let stopped = false;
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    cleanup();
    onError(error instanceof Error ? error : new Error(String(error)));
  };
  const onData = (chunk: Buffer | string) => {
    if (stopped) return;
    try {
      decoder.push(chunk);
    } catch (error) {
      fail(error);
    }
  };
  const onEnd = () => {
    if (stopped) return;
    try {
      decoder.end();
    } catch (error) {
      fail(error);
    }
  };
  const cleanup = () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    if (stopped) return;
    stopped = true;
    cleanup();
  };
}

export function serializeJsonl(value: unknown, maxLineBytes: number): string {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > maxLineBytes) {
    throw new JsonlProtocolError(`JSONL record exceeds ${maxLineBytes} bytes`);
  }
  return line;
}
