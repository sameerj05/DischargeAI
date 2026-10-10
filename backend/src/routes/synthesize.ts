import { Router } from "express";
import { z } from "zod";
import type { StoredSummary } from "../agents/types.js";
import type { AppContext } from "../context.js";
import { hashLinkId, hashPrefix, isLinkIdShaped } from "../crypto/linkId.js";
import { SK, pkFor } from "../docstore/types.js";
import { AppError, badRequest, gone, notFound } from "../errors.js";
import { isEmptyText, normalizeText } from "../extract/text.js";
import { resolveLanguages } from "../agents/pipeline.js";
import { epochSeconds, storePipelineResult, type RawDocument } from "../pipeline/ingestJob.js";

const Body = z.object({
  text: z.string().optional(),
  linkId: z.string().optional(),
  languages: z.array(z.string()).optional(),
  language: z.string().optional(),
});

/**
 * POST /synthesize (provider): runs the lane-3 pipeline (simplify -> safety check -> translate)
 * and returns the fixed JSON per language.
 *   { text, languages? }    dry run: nothing is stored; the response is the pipeline output.
 *   { linkId, languages?, text? }  re-synthesis: runs on the record's stored clinician text (or the
 *                           new text, which replaces it) and overwrites the record's simplified and
 *                           translation documents, so a re-run after a teammate improves a prompt is
 *                           one call. Languages picked here are added to the link's synthesis set.
 */
export function synthesizeRouter(ctx: AppContext): Router {
  const r = Router();

  r.post("/synthesize", async (req, res) => {
    const body = Body.parse(req.body ?? {});
    const requested = [...(body.languages ?? []), ...(body.language ? [body.language] : [])];
    const { unsupported } = resolveLanguages(requested);
    if (unsupported.length) throw badRequest("unsupported_language", `Unsupported language(s): ${unsupported.join(", ")} (see GET /languages)`);

    if (!body.linkId) {
      if (isEmptyText(body.text)) throw badRequest("empty_input", "Provide text (or a linkId to re-synthesize a record)");
      const result = await ctx.pipeline.run({ rawText: normalizeText(body.text!), languages: requested });
      await ctx.audit.append({ event: "synthesize.run", actor: "provider", at: ctx.clock.nowIso(), details: { stored: false, languages: result.meta.languages, provider: result.meta.provider, model: result.meta.model, fidelity: result.meta.safetyChecks.fidelity, sourceChars: result.meta.sourceChars } });
      res.json({ perLanguage: result.perLanguage, meta: result.meta, stored: null });
      return;
    }

    if (!isLinkIdShaped(body.linkId)) throw badRequest("invalid_link", "linkId must be the 22-character id");
    const linkIdHash = hashLinkId(body.linkId);
    const link = await ctx.links.getByHash(linkIdHash);
    if (!link) throw notFound("link_not_found", "No record exists for this linkId");
    if (link.status === "purged") throw gone("link_purged", "This record was permanently deleted after 30 days");
    if (link.status === "expired" || !link.encKey || new Date(link.expiresAt).getTime() <= ctx.clock.now().getTime()) {
      throw gone("link_expired", "This record expired 30 days after it was created");
    }
    const key = link.encKey;

    let text: string;
    let inputKind: StoredSummary["inputKind"] = "text";
    const existingRaw = await ctx.secureDocs.getJson<RawDocument>({ linkIdHash, sk: SK.raw, key }).catch(() => null);
    if (!isEmptyText(body.text)) {
      text = normalizeText(body.text!);
      const raw: RawDocument = { text, kind: "text", linkId: body.linkId };
      await ctx.secureDocs.putJson({ linkIdHash, sk: SK.raw, key, keyVersion: link.keyVersion, value: raw, expiresAtEpochSeconds: epochSeconds(link.expiresAt), createdAt: ctx.clock.nowIso() });
    } else if (existingRaw) {
      text = existingRaw.text;
      inputKind = existingRaw.kind;
    } else {
      throw new AppError(409, "source_missing", "This record has no stored clinician text yet; pass text or wait for the ingest job");
    }

    const picked = resolveLanguages([...requested, ...link.languages, ...(link.language ? [link.language] : [])]).languages.map((l) => l.code);
    const previous = await ctx.secureDocs.getJson<StoredSummary>({ linkIdHash, sk: SK.simplified, key }).catch(() => null);
    const job = await ctx.jobs.create({ linkIdHash, inputKind, now: ctx.clock.nowIso(), meta: { synthesize: true, languages: picked, sourceChars: text.length } });
    try {
      await ctx.jobs.setStage(job.id, "simplifying", ctx.clock.nowIso());
      const result = await ctx.pipeline.run({
        rawText: text,
        languages: picked,
        preferredLanguage: link.language ?? undefined,
        onStage: (stage) => ctx.jobs.setStage(job.id, stage, ctx.clock.nowIso()),
      });

      // Translations from an earlier synthesis that were not regenerated now describe a stale summary: delete them, with receipts.
      const pk = pkFor(linkIdHash);
      let staleDeleted = 0;
      for (const sk of await ctx.secureDocs.listKeys(linkIdHash)) {
        if (!sk.startsWith(SK.translationPrefix)) continue;
        if (result.meta.languages.includes(sk.slice(SK.translationPrefix.length))) continue;
        await ctx.docStore.delete(pk, sk);
        staleDeleted += 1;
        await ctx.audit.append({ event: "record.deleted", linkIdHash, actor: "provider", at: ctx.clock.nowIso(), details: { store: ctx.docStore.name, table: ctx.docStore.tableName, sk, reason: "resynthesized", job: "synthesize", jobId: job.id, receipt: true } });
      }

      const synthesisCount = (previous?.synthesisCount ?? (previous ? 1 : 0)) + 1;
      const { documents } = await storePipelineResult(ctx, link, result, { inputKind: previous?.inputKind ?? inputKind, synthesisCount });
      await ctx.links.setLanguages(linkIdHash, picked);
      const status = result.meta.safetyChecks.fidelity === "failed" ? "needs_review" : "ready";
      await ctx.links.setStatus(linkIdHash, status);
      await ctx.jobs.mergeMeta(job.id, { provider: result.meta.provider, model: result.meta.model, usage: result.meta.usage, llmMs: result.meta.latencyMs, fixture: result.meta.fixture, stages: result.meta.stages, fidelity: result.meta.safetyChecks.fidelity, documents }, ctx.clock.nowIso());
      await ctx.jobs.setWarnings(job.id, result.meta.safetyChecks.warnings, ctx.clock.nowIso());
      await ctx.jobs.setStage(job.id, status === "ready" ? "done" : "needs_review", ctx.clock.nowIso());
      await ctx.audit.append({ event: "record.synthesized", linkIdHash, actor: "provider", at: ctx.clock.nowIso(), details: { jobId: job.id, languages: result.meta.languages, provider: result.meta.provider, model: result.meta.model, fidelity: result.meta.safetyChecks.fidelity, documents, staleTranslationsDeleted: staleDeleted, synthesisCount, newText: !isEmptyText(body.text) } });
      ctx.log.info({ link: hashPrefix(linkIdHash), jobId: job.id, languages: result.meta.languages, status }, "record synthesized");

      res.json({
        perLanguage: result.perLanguage,
        meta: result.meta,
        stored: { linkRef: hashPrefix(linkIdHash), status, documents, staleTranslationsDeleted: staleDeleted, synthesisCount, jobId: job.id, expiresAt: link.expiresAt },
      });
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      await ctx.jobs.setStage(job.id, "failed", ctx.clock.nowIso(), message.slice(0, 500));
      throw err;
    }
  });

  return r;
}
