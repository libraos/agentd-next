import { describe, expect, it } from "vite-plus/test";

import { decodeFrame, FrameType, INITIAL_WINDOW, MAX_FRAME_PAYLOAD } from "./frames.ts";
import { Multiplexer, type MuxStream, type StreamEvent } from "./mux.ts";

const link = () => {
  const toHost: Array<Uint8Array> = [];
  const toDevice: Array<Uint8Array> = [];
  const hostStreams: Array<{ stream: MuxStream; events: Array<StreamEvent> }> = [];
  const host = new Multiplexer({
    role: "host",
    send: (frame) => toDevice.push(frame),
    onHttpStream: (stream) => {
      const entry = { stream, events: [] as Array<StreamEvent> };
      stream.onEvent = (event) => entry.events.push(event);
      hostStreams.push(entry);
    },
    onWsStream: (stream) => {
      const entry = { stream, events: [] as Array<StreamEvent> };
      stream.onEvent = (event) => entry.events.push(event);
      hostStreams.push(entry);
    },
  });
  const device = new Multiplexer({ role: "device", send: (frame) => toHost.push(frame) });
  const flush = () => {
    while (toHost.length > 0 || toDevice.length > 0) {
      for (const frame of toHost.splice(0)) host.receive(frame);
      for (const frame of toDevice.splice(0)) device.receive(frame);
    }
  };
  return { host, device, toHost, toDevice, hostStreams, flush };
};

const bodyBytes = (frames: ReadonlyArray<Uint8Array>) =>
  frames
    .map(decodeFrame)
    .filter((frame) => frame.type === FrameType.BODY)
    .reduce((total, frame) => total + frame.payload.length, 0);

describe("Multiplexer", () => {
  it("stops a stream at zero credit and resumes on WINDOW", () => {
    const { device, toHost, hostStreams, host, flush } = link();
    const stream = device.openHttp({ method: "POST", path: "/upload", headers: {} });
    host.receive(toHost.shift()!);
    stream.write(new Uint8Array(INITIAL_WINDOW + 50_000).fill(7));
    expect(bodyBytes(toHost)).toBe(INITIAL_WINDOW);
    expect(stream.sendCredit).toBe(0);
    expect(stream.bufferedAmount).toBe(50_000);

    const delivered = toHost.splice(0);
    delivered.forEach((frame) => host.receive(frame));
    const [received] = hostStreams;
    for (const event of received!.events) {
      if (event.type === "data") received!.stream.release(event.credit);
    }
    flush();
    expect(stream.bufferedAmount).toBe(0);
    const total = received!.events
      .filter((event) => event.type === "data")
      .reduce((sum, event) => sum + (event.type === "data" ? event.data.length : 0), 0);
    expect(total).toBe(INITIAL_WINDOW + 50_000);
  });

  it("carries a WebSocket message larger than one frame as one message", () => {
    const { device, hostStreams, flush } = link();
    const stream = device.openWs({ path: "/ws", headers: {}, protocols: [] });
    const text = "x".repeat(MAX_FRAME_PAYLOAD * 2 + 10);
    stream.sendText(text);
    flush();
    const messages = hostStreams[0]!.events.filter((event) => event.type === "text");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type === "text" && messages[0]!.text).toBe(text);
  });

  it("answers a PING", async () => {
    const { device, flush } = link();
    const answered = device.ping();
    flush();
    await answered;
  });

  it("refuses an even stream id from the device side", () => {
    const { host } = link();
    const frame = new Uint8Array([
      FrameType.HTTP_OPEN,
      0,
      0,
      0,
      2,
      ...new TextEncoder().encode("{}"),
    ]);
    expect(() => host.receive(frame)).toThrow();
  });
});
