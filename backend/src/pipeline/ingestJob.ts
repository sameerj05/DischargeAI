import type { AppContext } from "../context.js";
import { logRef } from "../crypto/sumId.js";
import type { ActiveLink } from "../db/repos/activeLinks.js";
import type { JobStage } from "../db/repos/jobs.js";
import type { InputKind } from "../docstore/types.js";
import { caregiverLinkEmail, patientLinkEmail, type LinkEmail } from "../email/templates.js";
import { normalizeText } from "../extract/text.js";
import type { AgentRun } from "./agent.js";

/**
 * What POST /ingest hands to the background job. Only audio needs it: pasted text and PDFs already
 * have their text on the summary item (`raw-text`) before the 202 goes out, so the job reads it from
 * there, and a restart loses nothing for them.
 */
export interface PendingInput {
  sumId: string;
  kind: InputKind;
  file?: { buffer: Buffer; mimeType: string; fileName?: string };
}

export function epochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * The team contract's async steps after the 202, as a persisted stage machine:
 *   received -> (transcribing: audio only) -> simplifying -> stored -> emailing -> done
 *   any stage --error--> failed
 * By the time the job runs, the clinician text is already on the summary item as `raw-text`: the
 * route stored pasted text as it came and ran pdfToText on a PDF before answering. The job sends that
 * text to the DischargeAI agent on AgentCore (session id = the sum-id) and waits, saves the agent's
 * whole response as `llm-summary` on the same item, then emails the link to the patient and the
 * caregiverEmail whatever status the agent gave. Nothing here translates.
 */
export async function runIngestJob(ctx: AppContext, jobId: string, pending?: PendingInput): Promise<void> {
  const { jobs, activeLinks, summaries, audit, clock, log } = ctx;
  const job = await jobs.get(jobId);
  if (!job) return;
  const link = await activeLinks.getBySumId(job.sumId);
  if (!link) {
    await jobs.setStage(jobId, "failed", clock.nowIso(), "link_missing");
    return;
  }
  const ref = logRef(job.sumId);
  const setStage = async (stage: JobStage, error?: string) => {
    await jobs.setStage(jobId, stage, clock.nowIso(), error);
    await audit.append({ event: "job.stage", sumId: job.sumId, actor: "system", at: clock.nowIso(), details: { jobId, stage, ...(error ? { error } : {}) } });
    log.info({ jobId, link: ref, stage }, "job stage");
  };

  try {
    const item = await summaries.get(job.sumId);
    if (!item) throw new Error("summary item missing from the document store");

    // 1. The clinician text is on the item already, except for audio, which is transcribed here
    //    (speech to text is too slow to wait for before answering) and then saved the same way.
    let text = item["raw-text"] ?? "";
    if (!text) {
      if (job.inputKind !== "audio" || !pending?.file) throw new Error("restart_before_transcription: the audio was lost when the process restarted");
      await setStage("transcribing");
      // Transcribe Medical reads the clip from the audio bucket by key.
      const r = await ctx.speechToText.transcribe({ audio: pending.file.buffer, mimeType: pending.file.mimeType, fileName: pending.file.fileName, audioKey: link.audioKey ?? undefined });
      await jobs.mergeMeta(jobId, { speechProvider: r.provider, transcribeJobName: r.jobName, transcribeMs: r.latencyMs }, clock.nowIso());
      text = normalizeText(r.transcript);
      if (!text) throw new Error("empty_input_after_transcription");
      await summaries.update(job.sumId, { "raw-text": text, meta: { ...(item.meta ?? {}), transcript: { provider: r.provider, jobName: r.jobName, latencyMs: r.latencyMs } } });
    }

    // 2. Send the text to the agent, wait, save its response on the item.
    await setStage("simplifying");
    const run = await synthesizeLink(ctx, link, text, job.inputKind);
    await jobs.mergeMeta(jobId, { provider: ctx.agent.name, agentRuntimeArn: ctx.agent.runtimeArn, agentMs: run.latencyMs, sourceChars: text.length }, clock.nowIso());
    await setStage("stored");

    // 3. Email the link to the patient and the caregiver.
    await setStage("emailing");
    await emailLinks(ctx, link);
    await setStage("done");
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    log.error({ jobId, link: ref, err: { name: (err as Error)?.name, message } }, "job failed");
    await jobs.setStage(jobId, "failed", clock.nowIso(), message.slice(0, 500));
    await activeLinks.setStatus(job.sumId, "failed").catch(() => undefined);
    await summaries.update(job.sumId, { status: "failed" }).catch(() => undefined);
    await audit.append({ event: "job.stage", sumId: job.sumId, actor: "system", at: clock.nowIso(), details: { jobId, stage: "failed", error: message.slice(0, 200) } });
  }
}

/**
 * Sends the clinician text for a link to the DischargeAI agent, with the link's sum-id as the
 * AgentCore session id, and saves the agent's whole response on the summary item as `llm-summary`
 * (plus `sum-id`, `status: ready` and the run metadata). Shared by the ingest job and
 * POST /synthesize { sumId }. Throws when the agent fails; the caller marks the job.
 */
export async function synthesizeLink(ctx: AppContext, link: ActiveLink, text: string, inputKind: InputKind): Promise<AgentRun> {
  const { activeLinks, summaries } = ctx;
  const run = await ctx.agent.invoke(text, link.sumId);
  const current = await summaries.get(link.sumId);
  await summaries.update(link.sumId, {
    "llm-summary": run.response,
    "sum-id": link.sumId,
    status: "ready",
    inputKind,
    meta: { ...(current?.meta ?? {}), provider: ctx.agent.name, agentRuntimeArn: ctx.agent.runtimeArn, latencyMs: run.latencyMs, sourceChars: text.length },
  });
  await activeLinks.setStatus(link.sumId, "ready");
  ctx.log.info({ link: logRef(link.sumId), latencyMs: run.latencyMs }, "agent response saved");
  return run;
}

/**
 * The team contract's step 5: "Send email w/ link to the patient at both email, and caregiverEmail".
 * Console by default, SMTP, SES, or SQS + worker. Returns who was sent to.
 */
export async function emailLinks(ctx: AppContext, link: ActiveLink): Promise<{ patient: boolean; caregiver: boolean }> {
  const patient = await ctx.patients.getById(link.patientID);
  if (!patient) return { patient: false, caregiver: false };
  const url = ctx.patientUrl(link.sumId);
  const deliveries: { kind: "patient" | "caregiver"; mail: LinkEmail }[] = [];
  if (patient.email) deliveries.push({ kind: "patient", mail: patientLinkEmail({ to: patient.email, link: url, expiresAt: link.expiresAt }) });
  else await ctx.audit.append({ event: "email.skipped", sumId: link.sumId, actor: "system", at: ctx.clock.nowIso(), details: { kind: "patient", reason: "no_email_on_patient_row" } });
  if (patient.caregiverEmail) deliveries.push({ kind: "caregiver", mail: caregiverLinkEmail({ to: patient.caregiverEmail, link: url, expiresAt: link.expiresAt }) });

  for (const { kind, mail } of deliveries) {
    const at = ctx.clock.nowIso();
    if (ctx.emailQueue) {
      const r = await ctx.emailQueue.enqueue({ ...mail, sumId: link.sumId, kind, enqueuedAt: at });
      await ctx.audit.append({ event: "email.queued", sumId: link.sumId, actor: "system", at, details: { kind, queue: "sqs", messageId: r.messageId } });
    } else {
      const sent = await ctx.mailer.send(mail);
      await ctx.audit.append({ event: "email.sent", sumId: link.sumId, actor: "system", at, details: { kind, transport: sent.transport, messageId: sent.messageId } });
    }
  }
  if (deliveries.length) await ctx.activeLinks.markEmailed(link.sumId, ctx.clock.nowIso());
  return { patient: deliveries.some((d) => d.kind === "patient"), caregiver: deliveries.some((d) => d.kind === "caregiver") };
}
