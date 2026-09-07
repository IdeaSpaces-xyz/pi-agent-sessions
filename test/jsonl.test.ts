import { describe, expect, it } from "vitest";
import { JsonlProtocolError, StrictJsonlDecoder, serializeJsonl } from "../src/controller/jsonl.js";

describe("strict JSONL", () => {
  it("keeps Unicode separators inside a record and decodes split UTF-8", () => {
    const records: unknown[] = [];
    const decoder = new StrictJsonlDecoder(1024, (record) => records.push(record));
    const bytes = Buffer.from(`${JSON.stringify({ text: "a b c😀" })}\n`);
    const emoji = bytes.indexOf(Buffer.from("😀"));
    decoder.push(bytes.subarray(0, emoji + 1));
    decoder.push(bytes.subarray(emoji + 1));
    decoder.end();
    expect(records).toEqual([{ text: "a b c😀" }]);
  });

  it("accepts CRLF and a final record without LF", () => {
    const records: unknown[] = [];
    const decoder = new StrictJsonlDecoder(1024, (record) => records.push(record));
    decoder.push('{"a":1}\r\n{"b":2}');
    decoder.end();
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("rejects malformed JSON, invalid UTF-8, and oversized records", () => {
    expect(() => new StrictJsonlDecoder(256, () => {}).push("not json\n")).toThrow(JsonlProtocolError);
    expect(() => new StrictJsonlDecoder(256, () => {}).push(Buffer.from([0xff, 0x0a]))).toThrow("invalid UTF-8");
    expect(() => new StrictJsonlDecoder(256, () => {}).push("x".repeat(257))).toThrow("exceeds 256 bytes");
    expect(() => serializeJsonl({ value: "x".repeat(300) }, 256)).toThrow("exceeds 256 bytes");
  });
});
