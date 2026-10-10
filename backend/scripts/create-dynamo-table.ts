/**
 * Creates the DynamoDB table for DOC_STORE=dynamo (`discharge_records` by default, env DYNAMO_TABLE)
 * and enables TTL on `expiresAt`, the attribute every item carries (lane-4 contract).
 *   DYNAMO_ENDPOINT=http://localhost:8000 npm run create-table     (DynamoDB Local)
 *   AWS_REGION=us-west-2 npm run create-table                      (real AWS; standard credential chain)
 * Idempotent: an existing table is left alone, TTL is (re)enabled.
 * IAM: dynamodb:CreateTable, dynamodb:DescribeTable, dynamodb:UpdateTimeToLive, dynamodb:DescribeTimeToLive.
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { loadConfig } from "../src/config.js";
import { createDynamoClient } from "../src/docstore/dynamo.js";
import { loadDotEnv } from "../src/dotenv.js";

loadDotEnv();
const config = loadConfig();
const TableName = config.DYNAMO_TABLE;
const client = createDynamoClient({ tableName: TableName, region: config.AWS_REGION, endpoint: config.DYNAMO_ENDPOINT });

let existed = true;
try {
  await client.send(new DescribeTableCommand({ TableName }));
} catch (err) {
  if (!(err instanceof ResourceNotFoundException)) throw err;
  existed = false;
}

if (!existed) {
  await client.send(
    new CreateTableCommand({
      TableName,
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName });
}

const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName }));
if (ttl.TimeToLiveDescription?.TimeToLiveStatus !== "ENABLED") {
  await client.send(
    new UpdateTimeToLiveCommand({ TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } }),
  );
}
const after = await client.send(new DescribeTimeToLiveCommand({ TableName }));
console.log(
  JSON.stringify({
    table: TableName,
    endpoint: config.DYNAMO_ENDPOINT ?? `aws:${config.AWS_REGION}`,
    created: !existed,
    ttl: after.TimeToLiveDescription,
  }),
);
