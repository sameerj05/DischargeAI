import type { Config } from "../config.js";
import { DynamoSummaryStore } from "./dynamo.js";
import type { SummaryStore } from "./types.js";

/** The team's DynamoDB table (`discharge-summaries`, hash key `uid`, TTL `expiresAt`). */
export function createSummaryStore(config: Config): SummaryStore {
  return new DynamoSummaryStore({ tableName: config.DYNAMO_TABLE, keyAttribute: config.DYNAMO_PK, region: config.AWS_REGION });
}

export type { SummaryStore, SummaryItem, SummaryPatch, SummaryStatus, SummaryMeta, InputKind } from "./types.js";
