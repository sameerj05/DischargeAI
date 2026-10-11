import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { LinkEmail } from "./templates.js";

export interface SentMail {
  messageId: string;
  transport: string;
  /** The console transport returns the rendered message so demos and tests can show it. */
  preview?: { from: string; to: string; subject: string; text: string };
}

export interface Mailer {
  readonly transportName: string;
  send(mail: LinkEmail): Promise<SentMail>;
}

/**
 * nodemailer transports: console (jsonTransport, prints the message), smtp (SMTP_URL), ses
 * (nodemailer SES transport over @aws-sdk/client-sesv2; nodemailer 10 requires the v2 client).
 * IAM for ses: ses:SendEmail; the From identity must be verified in SES.
 */
export async function createMailer(config: Config, log: Logger): Promise<Mailer> {
  let transporter: Transporter;
  let transportName: string = config.EMAIL_TRANSPORT;
  switch (config.EMAIL_TRANSPORT) {
    case "smtp": {
      if (!config.SMTP_URL) throw new Error("EMAIL_TRANSPORT=smtp needs SMTP_URL");
      transporter = nodemailer.createTransport(config.SMTP_URL);
      break;
    }
    case "ses": {
      const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
      transporter = nodemailer.createTransport({
        SES: { sesClient: new SESv2Client({ region: config.AWS_REGION }), SendEmailCommand },
      });
      break;
    }
    case "console":
    default: {
      transporter = nodemailer.createTransport({ jsonTransport: true });
      transportName = "console";
    }
  }

  return {
    transportName,
    async send(mail: LinkEmail): Promise<SentMail> {
      const info = await transporter.sendMail({ from: config.EMAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text });
      if (transportName === "console") {
        const parsed = JSON.parse(String(info.message)) as { from?: { address?: string }; to?: { address?: string }[]; subject: string; text: string };
        const preview = {
          from: parsed.from?.address ?? config.EMAIL_FROM,
          to: parsed.to?.[0]?.address ?? mail.to,
          subject: parsed.subject,
          text: parsed.text,
        };
        // Deliberately printed in full: this is the demo's "email printed" step.
        process.stdout.write(
          `\n===== EMAIL (console transport) =====\nFrom: ${preview.from}\nTo: ${preview.to}\nSubject: ${preview.subject}\n\n${preview.text}\n=====================================\n\n`,
        );
        return { messageId: info.messageId, transport: transportName, preview };
      }
      log.info({ transport: transportName, messageId: info.messageId }, "email sent");
      return { messageId: info.messageId, transport: transportName };
    },
  };
}
