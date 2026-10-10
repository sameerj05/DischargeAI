/**
 * Makes sure the team's DynamoDB table exists with TTL enabled, idempotently:
 *   table   DYNAMO_TABLE  (default discharge-summaries; Secrets Manager key dynamodb-table)
 *   key     DYNAMO_PK     (default uid, string HASH key, no sort key; secret key dynamodb-table-pk)
 *   TTL     expiresAt     (epoch seconds, written on every item)
 * Existing table: left alone. TTL already ENABLED (or ENABLING) on expiresAt: left alone. Missing
 * table: created PAY_PER_REQUEST. Prints what it found and did, never values.
 *   npm run setup-dynamo                                      (real AWS, standard credential chain)
 *   DYNAMO_ENDPOINT=http://localhost:8000 npm run setup-dynamo (DynamoDB Local)
 * IAM: dynamodb:DescribeTable, DescribeTimeToLive, UpdateTimeToLive (CreateTable only when missing).
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
import { bootstrapSecrets } from "../src/config/secrets.js";
import { createDynamoClient } from "../src/docstore/dynamo.js";
import { loadDotEnv } from "../src/dotenv.js";
import { createLogger } from "../src/logger.js";

loadDotEnv();
const boot = await bootstrapSecrets(process.env, createLogger(process.env.LOG_LEVEL ?? "warn"));
const config = loadConfig(boot.env);
const TableName = config.DYNAMO_TABLE;
const HashKey = config.DYNAMO_PK;
const client = createDynamoClient({ region: config.AWS_REGION, endpoint: config.DYNAMO_ENDPOINT });

let existed = true;
let keySchema: { AttributeName?: string; KeyType?: string }[] | undefined;
try {
  const d = await client.send(new DescribeTableCommand({ TableName }));
  keySchema = d.Table?.KeySchema;
} catch (err) {
  if (!(err instanceof ResourceNotFoundException)) throw err;
  existed = false;
}

if (!existed) {
  await client.send(
    new CreateTableCommand({
      TableName,
      AttributeDefinitions: [{ AttributeName: HashKey, AttributeType: "S" }],
      KeySchema: [{ AttributeName: HashKey, KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName });
  keySchema = [{ AttributeName: HashKey, KeyType: "HASH" }];
} else if (keySchema?.[0]?.AttributeName !== HashKey || keySchema.length !== 1) {
  console.error(JSON.stringify({ table: TableName, problem: "key schema differs from the configured hash key", expected: HashKey, found: keySchema }));
  process.exit(2);
}

const before = await client.send(new DescribeTimeToLiveCommand({ TableName }));
const status = before.TimeToLiveDescription?.TimeToLiveStatus;
let ttlChanged = false;
if (status !== "ENABLED" && status !== "ENABLING") {
  await client.send(new UpdateTimeToLiveCommand({ TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } }));
  ttlChanged = true;
}
const after = await client.send(new DescribeTimeToLiveCommand({ TableName }));
console.log(
  JSON.stringify({
    table: TableName,
    hashKey: HashKey,
    endpoint: config.DYNAMO_ENDPOINT ?? `aws:${config.AWS_REGION}`,
    configSource: boot.source,
    created: !existed,
    ttlChanged,
    ttl: after.TimeToLiveDescription,
  }),
);
