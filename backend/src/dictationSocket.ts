import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AppContext } from "./context.js";
import { AudioQueue, dictationError } from "./pipeline/liveDictation.js";

export function attachDictationSocket(server: Server, ctx: AppContext) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/dictation") { socket.destroy(); return; }
    const allowed = new Set([`http://${request.headers.host}`, `https://${request.headers.host}`, new URL(ctx.config.PATIENT_APP_URL).origin]);
    if (request.headers.origin && !allowed.has(request.headers.origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    if (sockets.clients.size >= 8) { socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws));
  });
  sockets.on("connection", ws => {
    const controller = new AbortController();
    const audio = new AudioQueue();
    let started = false; let stopped = false;
    const send = (value: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    const fail = (message: string) => { send({ type: "error", message }); ws.close(1008); controller.abort(); audio.cancel(); };
    let idleTimer = setTimeout(() => fail("Dictation authentication timed out."), 5000);
    const durationTimer = setTimeout(() => fail("Dictation reached the 15-minute limit. Start another dictation to continue."), 15 * 60_000);
    let finishTimer: NodeJS.Timeout | undefined;
    const refreshIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => fail("The microphone stopped sending audio. Start dictation again."), 30_000); };
    ws.on("message", (data, binary) => {
      try {
        if (binary) {
          if (!started || stopped) throw new Error("Start dictation before sending audio.");
          const bytes = Buffer.from(data as Buffer);
          if (!bytes.length || bytes.length % 2) throw new Error("Invalid PCM audio frame.");
          audio.push(bytes); refreshIdle(); return;
        }
        const message = JSON.parse(data.toString());
        if (!started) {
          const given = Buffer.from(typeof message.key === "string" ? message.key : "");
          const expected = Buffer.from(ctx.config.PROVIDER_API_KEY);
          if (message.type !== "start" || given.length !== expected.length || !timingSafeEqual(given, expected)) {
            fail("Missing or invalid provider key."); return;
          }
          if (!ctx.liveDictation) { fail("Live dictation is not configured on this server."); return; }
          if (!Number.isInteger(message.sampleRate) || message.sampleRate < 16000 || message.sampleRate > 48000) {
            fail("Unsupported microphone sample rate."); return;
          }
          started = true; refreshIdle();
          send({ type: "ready", provider: ctx.liveDictation.name });
          void (async () => {
            try {
              for await (const result of ctx.liveDictation!.transcribe(audio, message.sampleRate, controller.signal)) {
                if (ws.bufferedAmount > 256 * 1024) throw new Error("Client is too slow");
                send({ type: "transcript", ...result });
              }
              send({ type: "done" }); ws.close(1000);
            } catch (error) {
              if (!controller.signal.aborted) {
                ctx.log.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "live dictation failed");
                fail(dictationError(error));
              }
            }
          })();
        } else if (message.type === "stop" && !stopped) {
          stopped = true; clearTimeout(idleTimer); audio.end();
          finishTimer = setTimeout(() => fail("Transcription took too long to finish. Your displayed text is saved."), 15_000);
        } else throw new Error("Invalid dictation message.");
      } catch { fail("Invalid dictation message or audio stream."); }
    });
    ws.on("error", () => { controller.abort(); audio.cancel(); });
    ws.on("close", () => {
      clearTimeout(idleTimer); clearTimeout(durationTimer); clearTimeout(finishTimer);
      controller.abort(); audio.cancel();
    });
  });
  return { close() { for (const ws of sockets.clients) ws.terminate(); sockets.close(); } };
}
