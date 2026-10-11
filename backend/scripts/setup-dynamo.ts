/**
 * Idempotent setup of the DynamoDB table the backend writes to: creates it when missing (single hash
 * key named by DYNAMO_PK, `uid`; pay per request) and enables TTL on `expiresAt`. Safe to re-run:
 * an existing table is described, not changed; TTL already ENABLED is left alone.
 *   npm run setup-dynamo                                   team account (table name and key from Secrets Manager or env)
 * IAM: dynamodb:DescribeTable, CreateTable, DescribeTimeToLive, UpdateTimeToLive.
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { loadRuntimeEnv } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import { createDynamoClient } from "../src/docstore/dynamo.js";

const { env, secrets } = await loadRuntimeEnv();
const config = loadConfig(env);
const TableName = config.DYNAMO_TABLE;
const keyAttribute = config.DYNAMO_PK;
const client = createDynamoClient({ region: config.AWS_REGION });

let existed = true;
let keySchema: { AttributeName?: string; KeyType?: string }[] | undefined;
let status: string | undefined;
try {
  const d = await client.send(new DescribeTableCommand({ TableName }));
  keySchema = d.Table?.KeySchema;
  status = d.Table?.TableStatus;
} catch (err) {
  if (!(err instanceof ResourceNotFoundException)) throw err;
  existed = false;
}

if (!existed) {
  await client.send(
    new CreateTableCommand({
      TableName,
      AttributeDefinitions: [{ AttributeName: keyAttribute, AttributeType: "S" }],
      KeySchema: [{ AttributeName: keyAttribute, KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 90 }, { TableName });
  const d = await client.send(new DescribeTableCommand({ TableName }));
  keySchema = d.Table?.KeySchema;
  status = d.Table?.TableStatus;
}

const hashKey = keySchema?.find((k) => k.KeyType === "HASH")?.AttributeName;
const keyMatches = hashKey === keyAttribute && (keySchema?.length ?? 0) === 1;

const ttlBefore = (await client.send(new DescribeTimeToLiveCommand({ TableName }))).TimeToLiveDescription;
let ttlChanged = false;
if (ttlBefore?.TimeToLiveStatus !== "ENABLED" && ttlBefore?.TimeToLiveStatus !== "ENABLING") {
  await client.send(new UpdateTimeToLiveCommand({ TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" } }));
  ttlChanged = true;
}
const ttlAfter = (await client.send(new DescribeTimeToLiveCommand({ TableName }))).TimeToLiveDescription;
client.destroy();

const report = {
  table: TableName,
  target: `aws:${config.AWS_REGION}`,
  configSource: secrets.source,
  created: !existed,
  status,
  keySchema,
  expectedKey: keyAttribute,
  keyMatches,
  ttl: { before: ttlBefore?.TimeToLiveStatus ?? "unknown", after: ttlAfter?.TimeToLiveStatus ?? "unknown", attribute: ttlAfter?.AttributeName ?? null, changed: ttlChanged },
};
console.log(JSON.stringify(report, null, 2));
if (!keyMatches) {
  console.error(`WARNING: the table's hash key is "${hashKey}" (${keySchema?.length} key attributes) but DYNAMO_PK is "${keyAttribute}"; set DYNAMO_PK to match or use a different table.`);
  process.exit(2);
}
