import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { DynamoDocumentStore } from "./dynamo.js";
import { LocalDocumentStore } from "./local.js";
import type { DocumentStore } from "./types.js";

export function createDocumentStore(config: Config, db: Db): DocumentStore {
  if (config.DOC_STORE === "dynamo") {
    return new DynamoDocumentStore({
      tableName: config.DYNAMO_TABLE,
      hashKey: config.DYNAMO_PK,
      region: config.AWS_REGION,
      endpoint: config.DYNAMO_ENDPOINT,
    });
  }
  return new LocalDocumentStore(db);
}

export type { DocumentStore, DocItem } from "./types.js";
export { DOC, uidFor, linkIdHashFromUid } from "./types.js";
