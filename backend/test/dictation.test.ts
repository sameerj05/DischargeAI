import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startLocalServer } from "../scripts/local-server.js";
import { AudioQueue, dictationError } from "../src/pipeline/liveDictation.js";
import { DictationTranscript } from "../../frontend/src/dictationTranscript.js";

test("dictation replaces partial hypotheses, preserves segment order, and ignores repeated final results", () => {
  const transcript = new DictationTranscript();
  assert.equal(transcript.update("a", "Take four", true), "Take four");
  assert.equal(transcript.update("a", "Take furosemide", true), "Take furosemide");
  assert.equal(transcript.update("b", "once daily.", true), "Take furosemide once daily.");
  assert.equal(transcript.update("a", "Take furosemide 40 mg", false), "Take furosemide 40 mg once daily.");
  transcript.update("a", "Take four", true); transcript.update("a", "Take furosemide 40 mg", false);
  assert.equal(transcript.update("b", "once daily. Follow up in one week.", false), "Take furosemide 40 mg once daily. Follow up in one week.");
});

test("audio queue drains on stop, rejects overflow and discards buffered audio on cancellation", async () => {
  const queue = new AudioQueue(); queue.push(new Uint8Array([1, 2])); queue.push(new Uint8Array([3, 4])); queue.end();
  const frames = []; for await (const frame of queue) frames.push([...frame]);
  assert.deepEqual(frames, [[1, 2], [3, 4]]); assert.throws(() => queue.push(new Uint8Array(2)), /stopped/);
  const full = new AudioQueue(); assert.throws(() => full.push(new Uint8Array(256 * 1024 + 1)), /too slow/);
  full.push(new Uint8Array(2)); full.cancel();
  assert.equal((await full[Symbol.asyncIterator]().next()).done, true);
});

test("provider failures explain expired credentials and missing streaming permissions without leaking details", () => {
  assert.match(dictationError(Object.assign(new Error("secret"), { name: "ExpiredTokenException" })), /expired/);
  assert.match(dictationError(Object.assign(new Error("secret"), { name: "AccessDeniedException" })), /transcribe:StartMedicalStreamTranscription/);
  assert.ok(!dictationError(new Error("secret")).includes("secret"));
});

test("dictation socket authenticates before invoking a provider and delivers partial and final results", { timeout: 15_000 }, async () => {
  let invoked = 0; let aborted = false;
  const local = await startLocalServer(0, { liveDictation: {
    name: "synthetic-stream-test",
    async *transcribe(audio, sampleRate, signal) {
      invoked++; assert.equal(sampleRate, 16000);
      signal.addEventListener("abort", () => { aborted = true; });
      for await (const frame of audio) { assert.equal(frame.byteLength, 3200); yield { id: "a", text: "Synthetic partial", partial: true }; }
      yield { id: "a", text: "Synthetic final.", partial: false };
    },
  } });
  const connect = async () => { const ws = new WebSocket(local.origin.replace("http:", "ws:") + "/api/dictation", { origin: local.origin }); await once(ws, "open"); return ws; };
  try {
    const invalid = await connect(); const rejected = once(invalid, "message");
    invalid.send(JSON.stringify({ type: "start", key: "wrong", sampleRate: 16000 }));
    assert.match(JSON.parse(String((await rejected)[0])).message, /provider key/); await once(invalid, "close"); assert.equal(invoked, 0);
    const ws = await connect(); const ready = once(ws, "message");
    ws.send(JSON.stringify({ type: "start", key: "local-test-key", sampleRate: 16000 }));
    assert.equal(JSON.parse(String((await ready)[0])).type, "ready");
    const partial = once(ws, "message"); ws.send(Buffer.alloc(3200));
    assert.deepEqual(JSON.parse(String((await partial)[0])), { type: "transcript", id: "a", text: "Synthetic partial", partial: true });
    const rest: object[] = []; ws.on("message", data => rest.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({ type: "stop" })); await once(ws, "close");
    assert.deepEqual(rest, [{ type: "transcript", id: "a", text: "Synthetic final.", partial: false }, { type: "done" }]);
    assert.equal(invoked, 1); assert.equal(aborted, true);
    const unsupported = await connect(); const unsupportedMessage = once(unsupported, "message");
    unsupported.send(JSON.stringify({ type: "start", key: "local-test-key", sampleRate: 8000 }));
    assert.match(JSON.parse(String((await unsupportedMessage)[0])).message, /sample rate/); await once(unsupported, "close"); assert.equal(invoked, 1);
  } finally { await local.close(); }
});

test("dictation socket rejects cross-origin upgrades", { timeout: 10_000 }, async () => {
  const local = await startLocalServer(0);
  try {
    const ws = new WebSocket(local.origin.replace("http:", "ws:") + "/api/dictation", { origin: "https://unrelated.example" });
    const [error] = await once(ws, "error"); assert.match(error.message, /403/);
  } finally { await local.close(); }
});
