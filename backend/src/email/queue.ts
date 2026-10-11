import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { LinkEmail } from "./templates.js";

/** Message shape on the queue. scripts/email-worker.ts consumes it (loop or Lambda handler). */
export interface QueuedEmail extends LinkEmail {
  sumId: string;
  kind: "patient" | "caregiver";
  enqueuedAt: string;
}

export interface EmailQueue {
  enqueue(msg: QueuedEmail): Promise<{ messageId: string }>;
}

/** EMAIL_QUEUE=sqs: SendMessage to SQS_QUEUE_URL instead of sending inline. IAM: sqs:SendMessage. */
export function createSqsEmailQueue(opts: { queueUrl: string; region: string; client?: SQSClient }): EmailQueue {
  const client = opts.client ?? new SQSClient({ region: opts.region });
  return {
    async enqueue(msg) {
      const r = await client.send(new SendMessageCommand({ QueueUrl: opts.queueUrl, MessageBody: JSON.stringify(msg) }));
      return { messageId: r.MessageId ?? "" };
    },
  };
}
