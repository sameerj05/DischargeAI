import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audioKeyFor, type AudioObject, type AudioStore } from "./types.js";

/**
 * Local filesystem twin of the S3 audio bucket: AUDIO_DIR/<linkIdHash>.bin (sealed bytes) plus
 * <linkIdHash>.json (the metadata S3 keeps as object metadata). The purge job deletes both at day 30.
 */
export class LocalAudioStore implements AudioStore {
  readonly name = "local" as const;
  readonly location: string;

  constructor(dir: string) {
    this.location = dir;
    mkdirSync(dir, { recursive: true });
  }

  private paths(linkIdHash: string) {
    if (!/^[0-9a-f]{64}$/.test(linkIdHash)) throw new Error("audio store: linkIdHash must be a sha256 hex string");
    return { bin: join(this.location, `${linkIdHash}.bin`), meta: join(this.location, `${linkIdHash}.json`) };
  }

  async put(input: { linkIdHash: string; body: Buffer; contentType: string; keyVersion: number; expiresAt: number; createdAt: string }): Promise<AudioObject> {
    const p = this.paths(input.linkIdHash);
    const meta: AudioObject = {
      key: audioKeyFor(input.linkIdHash),
      bytes: input.body.length,
      contentType: input.contentType,
      keyVersion: input.keyVersion,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
    };
    writeFileSync(p.bin, input.body, { mode: 0o600 });
    writeFileSync(p.meta, JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }

  async head(linkIdHash: string): Promise<AudioObject | null> {
    const p = this.paths(linkIdHash);
    if (!existsSync(p.meta) || !existsSync(p.bin)) return null;
    const meta = JSON.parse(readFileSync(p.meta, "utf8")) as AudioObject;
    return { ...meta, bytes: statSync(p.bin).size };
  }

  async get(linkIdHash: string): Promise<{ body: Buffer; meta: AudioObject } | null> {
    const meta = await this.head(linkIdHash);
    if (!meta) return null;
    return { body: readFileSync(this.paths(linkIdHash).bin), meta };
  }

  async delete(linkIdHash: string): Promise<AudioObject | null> {
    const meta = await this.head(linkIdHash);
    const p = this.paths(linkIdHash);
    rmSync(p.bin, { force: true });
    rmSync(p.meta, { force: true });
    return meta;
  }

  async listExpired(nowEpochSeconds: number): Promise<{ linkIdHash: string; meta: AudioObject }[]> {
    const out: { linkIdHash: string; meta: AudioObject }[] = [];
    for (const f of readdirSync(this.location)) {
      if (!f.endsWith(".json")) continue;
      const linkIdHash = f.slice(0, -".json".length);
      const meta = await this.head(linkIdHash).catch(() => null);
      if (meta && meta.expiresAt <= nowEpochSeconds) out.push({ linkIdHash, meta });
    }
    return out;
  }
}
