import { aadFor, openJson, sealJson } from "../crypto/envelope.js";
import type { DocumentStore } from "./types.js";
import { uidFor } from "./types.js";

/**
 * Encrypt-then-store and fetch-then-decrypt around the document store. Every payload is sealed with
 * the link's data key and bound (AAD) to its uid, document name and key version. Items are addressed
 * by the link hash, never the raw id, so the purge job can find them from the SQL row alone.
 */
export class SecureDocs {
  constructor(private readonly store: DocumentStore) {}

  async putJson(input: {
    linkIdHash: string;
    doc: string;
    key: Buffer;
    keyVersion: number;
    value: unknown;
    expiresAtEpochSeconds: number;
    createdAt: string;
  }): Promise<void> {
    const uid = uidFor(input.linkIdHash);
    const sealed = sealJson(input.key, input.value, aadFor(uid, input.doc, input.keyVersion));
    await this.store.put({
      uid,
      doc: input.doc,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      tag: sealed.tag,
      keyVersion: input.keyVersion,
      expiresAt: input.expiresAtEpochSeconds,
      createdAt: input.createdAt,
    });
  }

  /** Returns null when the document is absent. Throws when the key is wrong or gone. */
  async getJson<T>(input: { linkIdHash: string; doc: string; key: Buffer }): Promise<T | null> {
    const uid = uidFor(input.linkIdHash);
    const item = await this.store.get(uid, input.doc);
    if (!item) return null;
    return openJson<T>(input.key, item, aadFor(uid, input.doc, item.keyVersion));
  }

  async has(linkIdHash: string, doc: string): Promise<boolean> {
    return (await this.store.get(uidFor(linkIdHash), doc)) !== null;
  }

  async deleteAll(linkIdHash: string): Promise<number> {
    return this.store.deleteAll(uidFor(linkIdHash));
  }

  async count(linkIdHash: string): Promise<number> {
    return (await this.store.list(uidFor(linkIdHash))).length;
  }

  /** Document names on the link's item: raw, simplified, translation#<lang>... */
  async listDocs(linkIdHash: string): Promise<string[]> {
    return (await this.store.list(uidFor(linkIdHash))).map((i) => i.doc);
  }
}
