/**
 * Consumes the SQS email queue (EMAIL_QUEUE=sqs on the API side) and sends each message with the
 * configured transport, mirroring the "SQS -> Lambda" option. Two entry points:
 *   npm run email-worker                      long-polling loop (ReceiveMessage / DeleteMessage)
 *   export { handler }                        Lambda handler for an SQS event source mapping
 * IAM: sqs:ReceiveMessage, sqs:DeleteMessage, plus the transport's (ses:SendEmail for SES).
 */
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig } from "../src/config.js";
import { bootstrapSecrets } from "../src/config/secrets.js";
import { loadDotEnv } from "../src/dotenv.js";
import { createMailer, type Mailer } from "../src/email/mailer.js";
import type { QueuedEmail } from "../src/email/queue.js";
import { createLogger } from "../src/logger.js";

loadDotEnv();
const config = loadConfig((await bootstrapSecrets(process.env)).env);
const log = createLogger(config.LOG_LEVEL);
let mailer: Mailer | undefined;

async function getMailer(): Promise<Mailer> {
  mailer ??= await createMailer(config, log);
  return mailer;
}

async function sendOne(body: string): Promise<void> {
  const msg = JSON.parse(body) as QueuedEmail;
  const m = await getMailer();
  const sent = await m.send({ to: msg.to, subject: msg.subject, text: msg.text });
  log.info({ kind: msg.kind, transport: sent.transport, messageId: sent.messageId, link: msg.linkIdHash.slice(0, 8) }, "queued email sent");
}

/** Lambda entry point: an SQS event source mapping delivers { Records: [{ body }] }. */
export async function handler(event: { Records?: { body: string; messageId?: string }[] }): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    try {
      await sendOne(record.body);
    } catch (err) {
      log.error({ err: { message: (err as Error).message } }, "queued email failed");
      if (record.messageId) failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

async function loop(): Promise<void> {
  if (!config.SQS_QUEUE_URL) throw new Error("SQS_QUEUE_URL is required");
  const sqs = new SQSClient({ region: config.AWS_REGION });
  log.info({ queue: config.SQS_QUEUE_URL.split("/").pop(), transport: config.EMAIL_TRANSPORT }, "email worker polling");
  for (;;) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: config.SQS_QUEUE_URL, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 60 }),
    );
    for (const m of Messages ?? []) {
      try {
        await sendOne(m.Body ?? "{}");
        await sqs.send(new DeleteMessageCommand({ QueueUrl: config.SQS_QUEUE_URL, ReceiptHandle: m.ReceiptHandle }));
      } catch (err) {
        log.error({ err: { message: (err as Error).message } }, "queued email failed; left on queue");
      }
    }
  }
}

const isMain = process.argv[1]?.endsWith("email-worker.ts") || process.argv[1]?.endsWith("email-worker.js");
if (isMain) {
  loop().catch((err) => {
    log.error({ err: { message: (err as Error).message } }, "email worker stopped");
    process.exit(1);
  });
}
