import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { blackholeStream, isPipeError, silenceBrokenPipe } from "@/lib/server/broken-pipe";

function fakeStream() {
  const stream = new EventEmitter() as EventEmitter & {
    write: (...args: unknown[]) => boolean;
  };
  stream.write = () => {
    throw new Error("should not write after blackhole");
  };
  return stream;
}

describe("broken-pipe handling", () => {
  it("recognises EPIPE / ECONNRESET / broken-pipe text", () => {
    expect(isPipeError({ code: "EPIPE" })).toBe(true);
    expect(isPipeError({ code: "ECONNRESET" })).toBe(true);
    expect(isPipeError(Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" }))).toBe(true);
    expect(isPipeError(new Error("something else"))).toBe(false);
  });

  it("turns a stream into a no-op writer after a fatal pipe error", () => {
    const stream = fakeStream();
    silenceBrokenPipe(stream as unknown as NodeJS.WriteStream);
    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(stream.write("still here")).toBe(true);
  });

  it("blackholeStream never throws on subsequent writes", () => {
    const stream = fakeStream();
    blackholeStream(stream as unknown as NodeJS.WriteStream);
    expect(stream.write("x")).toBe(true);
  });
});
