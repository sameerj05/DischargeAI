import { describe, expect, it } from "vitest";
import { selectAudioStore } from "../src/audiostore/index.js";
import { ruleCoversAudio } from "../src/audiostore/s3.js";
import { loadConfig } from "../src/config.js";

const base = { SECRETS_BOOTSTRAP: "off", LOG_LEVEL: "silent", AUDIO_DIR: "data/test-audio-select" };

describe("audio store selection (AUDIO_STORE=auto, team bucket emraudio-rh)", () => {
  it("defaults to the team bucket name and picks S3 when the secret loaded and the bucket answers", async () => {
    const config = loadConfig(base);
    expect(config.AUDIO_BUCKET).toBe("emraudio-rh");
    expect(config.AUDIO_STORE).toBe("auto");
    const probed: string[] = [];
    const sel = await selectAudioStore(config, { secretLoaded: true, probe: async (bucket, region) => void probed.push(`${bucket}@${region}`) });
    expect(probed).toEqual(["emraudio-rh@us-west-2"]);
    expect(sel.store.name).toBe("s3");
    expect(sel.store.location).toBe("emraudio-rh");
    expect(sel).toMatchObject({ requested: "s3" });
    expect(sel.fallback).toBeUndefined();
  });

  it("falls back to the local directory when the bucket is unreachable (auto) and fails hard when forced", async () => {
    const config = loadConfig(base);
    const sel = await selectAudioStore(config, {
      secretLoaded: true,
      probe: async () => {
        throw Object.assign(new Error("Forbidden"), { name: "403" });
      },
    });
    expect(sel.store.name).toBe("local");
    expect(sel).toMatchObject({ requested: "s3", fallback: { from: "s3", bucket: "emraudio-rh", reason: "Forbidden" } });
    await expect(
      selectAudioStore(loadConfig({ ...base, AUDIO_STORE: "s3" }), {
        secretLoaded: false,
        probe: async () => {
          throw new Error("no route");
        },
      }),
    ).rejects.toThrow(/AUDIO_STORE=s3 but bucket emraudio-rh is unreachable/);
  });

  it("stays local without credentials or when told to, without probing", async () => {
    let probes = 0;
    const probe = async () => void (probes += 1);
    const noCreds = await selectAudioStore(loadConfig(base), { secretLoaded: false, probe });
    expect(noCreds).toMatchObject({ requested: "local" });
    expect(noCreds.store.name).toBe("local");
    const forcedLocal = await selectAudioStore(loadConfig({ ...base, AUDIO_STORE: "local" }), { secretLoaded: true, probe });
    expect(forcedLocal.store.name).toBe("local");
    expect(probes).toBe(0);
  });

  it("recognises an existing lifecycle rule that already expires audio/ within 30 days", () => {
    // The team bucket's rule, as read from AWS: bucket-wide, 30 days, enabled.
    expect(ruleCoversAudio({ ID: "autodelete", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 30 } })).toBe(true);
    expect(ruleCoversAudio({ ID: "legacy", Status: "Enabled", Prefix: "", Expiration: { Days: 7 } })).toBe(true);
    expect(ruleCoversAudio({ ID: "audio-only", Status: "Enabled", Filter: { Prefix: "audio/" }, Expiration: { Days: 30 } })).toBe(true);
    expect(ruleCoversAudio({ ID: "too-long", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 31 } })).toBe(false);
    expect(ruleCoversAudio({ ID: "disabled", Status: "Disabled", Filter: { Prefix: "" }, Expiration: { Days: 30 } })).toBe(false);
    expect(ruleCoversAudio({ ID: "other-prefix", Status: "Enabled", Filter: { Prefix: "logs/" }, Expiration: { Days: 30 } })).toBe(false);
    expect(ruleCoversAudio({ ID: "tagged", Status: "Enabled", Filter: { Tag: { Key: "x", Value: "y" } }, Expiration: { Days: 30 } })).toBe(false);
    expect(ruleCoversAudio({ ID: "no-expiry", Status: "Enabled", Filter: { Prefix: "" }, Transitions: [] })).toBe(false);
  });
});
