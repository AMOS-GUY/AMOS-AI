/** F2 regression tests: privacy labels, relabelling and the egress decision table. */
import { describe, expect, it } from "vitest";
import { AmosError } from "./errors.ts";
import {
  combineLabels,
  DEFAULT_UNCLASSIFIED_LABEL,
  decideEgress,
  PRIVACY_LABELS,
  type PrivacyLabel,
  parsePrivacyLabel,
  type Recipient,
  relabel,
} from "./privacy.ts";

const provider = (
  over: Partial<Extract<Recipient, { kind: "model_provider" }>> = {},
): Recipient => ({
  kind: "model_provider",
  providerId: "p",
  location: "cloud",
  enabled: true,
  allowPersonalData: false,
  ...over,
});

function privacyError(fn: () => unknown): AmosError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AmosError);
    expect((error as AmosError).code).toBe("PRIVACY_VIOLATION");
    return error as AmosError;
  }
  throw new Error("expected PRIVACY_VIOLATION");
}

describe("labels", () => {
  it("treats unclassified data as local_only, never public", () => {
    expect(DEFAULT_UNCLASSIFIED_LABEL).toBe("local_only");
  });

  it("rejects unknown, mis-cased and non-string labels", () => {
    for (const bad of [
      "PUBLIC",
      "Public",
      "unknown",
      "",
      " public",
      null,
      undefined,
      0,
      {},
      ["public"],
    ]) {
      privacyError(() => parsePrivacyLabel(bad));
    }
    for (const good of PRIVACY_LABELS) expect(parsePrivacyLabel(good)).toBe(good);
  });

  it("combines to the most restrictive label", () => {
    expect(combineLabels(["public"])).toBe("public");
    expect(combineLabels(["public", "personal"])).toBe("personal");
    expect(combineLabels(["personal", "local_only", "public"])).toBe("local_only");
    expect(combineLabels(["public", "secret", "personal"])).toBe("secret");
  });

  it("refuses to combine nothing (a forgotten label must not become public)", () => {
    privacyError(() => combineLabels([]));
  });

  it("fails closed when any label in a combination is invalid", () => {
    privacyError(() => combineLabels(["public", "publik" as PrivacyLabel]));
    privacyError(() => combineLabels(["public", undefined as unknown as PrivacyLabel]));
  });
});

describe("relabel", () => {
  const owner = { kind: "owner_reclassification", reason: "published on my website" } as const;

  it("always allows raising a label", () => {
    expect(relabel("public", "local_only")).toBe("local_only");
    expect(relabel("personal", "secret")).toBe("secret");
    expect(relabel("personal", "personal")).toBe("personal");
  });

  it("requires an explicit owner reclassification with a reason to lower one", () => {
    privacyError(() => relabel("local_only", "public"));
    privacyError(() =>
      relabel("local_only", "public", { kind: "owner_reclassification", reason: "  " }),
    );
    privacyError(() => relabel("personal", "public", { kind: "approved", reason: "x" } as never));
    privacyError(() => relabel("personal", "public", null as never));
    expect(relabel("local_only", "public", owner)).toBe("public");
  });

  it("never lowers secret, even with owner authorisation", () => {
    for (const to of ["public", "personal", "local_only"] as const) {
      expect(privacyError(() => relabel("secret", to, owner)).message).toContain("never");
    }
  });

  it("validates both labels", () => {
    privacyError(() => relabel("public", "nope" as PrivacyLabel));
    privacyError(() => relabel("nope" as PrivacyLabel, "secret"));
  });
});

describe("decideEgress — model providers", () => {
  it("never sends secret data, whatever the provider policy", () => {
    for (const location of ["local", "cloud"] as const) {
      expect(decideEgress("secret", provider({ location, allowPersonalData: true })).allowed).toBe(
        false,
      );
    }
  });

  it("sends nothing to a disabled provider", () => {
    for (const label of ["public", "personal"] as const) {
      expect(
        decideEgress(label, provider({ enabled: false, allowPersonalData: true })).allowed,
      ).toBe(false);
    }
  });

  it("sends public data to any enabled provider", () => {
    expect(decideEgress("public", provider()).allowed).toBe(true);
  });

  it("sends personal data only when allowPersonalData is exactly true", () => {
    expect(decideEgress("personal", provider({ allowPersonalData: true })).allowed).toBe(true);
    expect(decideEgress("personal", provider({ allowPersonalData: false })).allowed).toBe(false);
    // Values that slip past TypeScript must not grant permission.
    for (const v of ["true", 1, undefined, null, {}]) {
      expect(decideEgress("personal", provider({ allowPersonalData: v as never })).allowed).toBe(
        false,
      );
    }
  });

  it("keeps local_only data on local providers that allow personal data", () => {
    expect(
      decideEgress("local_only", provider({ location: "local", allowPersonalData: true })).allowed,
    ).toBe(true);
    expect(
      decideEgress("local_only", provider({ location: "local", allowPersonalData: false })).allowed,
    ).toBe(false);
    expect(
      decideEgress("local_only", provider({ location: "cloud", allowPersonalData: true })).allowed,
    ).toBe(false);
    expect(
      decideEgress("local_only", provider({ location: "Local" as never, allowPersonalData: true }))
        .allowed,
    ).toBe(false);
  });

  it("matches the complete documented decision table", () => {
    const table: Array<[PrivacyLabel, "local" | "cloud", boolean, boolean]> = [];
    for (const label of PRIVACY_LABELS) {
      for (const location of ["local", "cloud"] as const) {
        for (const allow of [false, true]) {
          const expected =
            label === "public" ||
            (label === "personal" && allow) ||
            (label === "local_only" && allow && location === "local");
          table.push([label, location, allow, expected]);
        }
      }
    }
    for (const [label, location, allow, expected] of table) {
      expect(
        decideEgress(label, provider({ location, allowPersonalData: allow })).allowed,
        `${label}/${location}/${allow}`,
      ).toBe(expected);
    }
  });
});

describe("decideEgress — other recipients and malformed input", () => {
  it("allows only public data to external tools and remote clients (no policy exists yet)", () => {
    for (const recipient of [
      { kind: "external_tool", toolId: "t" },
      { kind: "remote_client", clientId: "c" },
    ] as const) {
      expect(decideEgress("public", recipient).allowed).toBe(true);
      for (const label of ["personal", "local_only", "secret"] as const) {
        expect(decideEgress(label, recipient).allowed).toBe(false);
      }
    }
  });

  it("denies unknown recipient kinds, null recipients and unknown labels", () => {
    expect(decideEgress("public", { kind: "webhook" } as never).allowed).toBe(false);
    expect(decideEgress("public", null as never).allowed).toBe(false);
    expect(
      decideEgress("publik" as PrivacyLabel, provider({ allowPersonalData: true })).allowed,
    ).toBe(false);
  });

  it("explains every denial", () => {
    const d = decideEgress("local_only", provider({ allowPersonalData: true }));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/never leaves this machine/);
  });
});
