/** F3 regression tests: the egress gate and its clearances, including bypass attempts. */
import { describe, expect, it } from "vitest";
import {
  type EgressClearance,
  EgressGate,
  type ProviderPolicy,
  verifyClearance,
} from "./egress-gate.ts";
import { AmosError } from "./errors.ts";

const policies: ProviderPolicy[] = [
  {
    providerId: "cloud-strict",
    location: "cloud",
    enabled: true,
    allowPersonalData: false,
    origin: "https://strict.example",
  },
  {
    providerId: "cloud-trusted",
    location: "cloud",
    enabled: true,
    allowPersonalData: true,
    origin: "https://trusted.example",
  },
  {
    providerId: "ollama",
    location: "local",
    enabled: true,
    allowPersonalData: true,
    origin: "http://127.0.0.1:11434",
  },
  {
    providerId: "off",
    location: "cloud",
    enabled: false,
    allowPersonalData: true,
    origin: "https://off.example",
  },
];
const gate = new EgressGate(policies);
const asMessages = (contents: readonly unknown[]) => ({ messages: contents });

function denied(fn: () => unknown, fragment?: string): AmosError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AmosError);
    expect((error as AmosError).code).toBe("PRIVACY_VIOLATION");
    if (fragment) expect((error as AmosError).message).toContain(fragment);
    return error as AmosError;
  }
  throw new Error("expected PRIVACY_VIOLATION");
}

describe("EgressGate.authorizeForProvider", () => {
  it("issues a clearance holding exactly the serialised body, bound to the provider origin", () => {
    const c = gate.authorizeForProvider(
      "cloud-strict",
      [{ label: "public", content: "hello" }],
      asMessages,
    );
    expect(c).toMatchObject({
      providerId: "cloud-strict",
      origin: "https://strict.example",
      label: "public",
      body: '{"messages":["hello"]}',
      contentType: "application/json",
    });
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("refuses personal data for a provider that does not allow it", () => {
    denied(
      () =>
        gate.authorizeForProvider(
          "cloud-strict",
          [{ label: "personal", content: "my notes" }],
          asMessages,
        ),
      "allowPersonalData",
    );
    expect(
      gate.authorizeForProvider("cloud-trusted", [{ label: "personal", content: "x" }], asMessages)
        .label,
    ).toBe("personal");
  });

  it("keeps local_only data off cloud providers even when they allow personal data", () => {
    denied(() =>
      gate.authorizeForProvider(
        "cloud-trusted",
        [{ label: "local_only", content: "x" }],
        asMessages,
      ),
    );
    expect(
      gate.authorizeForProvider("ollama", [{ label: "local_only", content: "x" }], asMessages)
        .label,
    ).toBe("local_only");
  });

  it("uses the most restrictive label of all items (one private item taints the request)", () => {
    denied(() =>
      gate.authorizeForProvider(
        "cloud-trusted",
        [
          { label: "public", content: "a" },
          { label: "local_only", content: "b" },
        ],
        asMessages,
      ),
    );
  });

  it("never sends secrets, even to a local provider", () => {
    denied(
      () => gate.authorizeForProvider("ollama", [{ label: "secret", content: "k" }], asMessages),
      "never",
    );
  });

  it("refuses unknown and disabled providers", () => {
    denied(
      () =>
        gate.authorizeForProvider(
          "not-configured",
          [{ label: "public", content: "x" }],
          asMessages,
        ),
      "Unknown provider",
    );
    denied(
      () => gate.authorizeForProvider("off", [{ label: "public", content: "x" }], asMessages),
      "disabled",
    );
  });

  it("refuses requests that declare no data, and items without valid labels", () => {
    denied(() => gate.authorizeForProvider("cloud-trusted", [], asMessages), "declare");
    denied(() => gate.authorizeForProvider("cloud-trusted", undefined as never, asMessages));
    denied(
      () => gate.authorizeForProvider("ollama", [{ content: "unlabelled" } as never], asMessages),
      "no valid privacy label",
    );
    denied(() =>
      gate.authorizeForProvider("ollama", [{ label: "PUBLIC", content: "x" } as never], asMessages),
    );
    denied(() => gate.authorizeForProvider("ollama", [null as never], asMessages));
  });

  it("serialises at authorisation time, so later mutation cannot change what is sent", () => {
    const content = { text: "approved" };
    const c = gate.authorizeForProvider("cloud-strict", [{ label: "public", content }], asMessages);
    content.text = "swapped after the check";
    expect(c.body).toBe('{"messages":[{"text":"approved"}]}');
  });

  it("gives the body builder a frozen list of contents", () => {
    gate.authorizeForProvider("cloud-strict", [{ label: "public", content: "a" }], (contents) => {
      expect(Object.isFrozen(contents)).toBe(true);
      return contents;
    });
  });

  it("rejects bodies that cannot be serialised", () => {
    denied(
      () => gate.authorizeForProvider("cloud-strict", [{ label: "public", content: 1n }], (c) => c),
      "serialised",
    );
    denied(
      () =>
        gate.authorizeForProvider(
          "cloud-strict",
          [{ label: "public", content: "x" }],
          () => undefined,
        ),
      "serialised",
    );
  });
});

describe("EgressGate construction", () => {
  it("rejects duplicate provider ids and incomplete policies (e.g. from untyped callers)", () => {
    denied(
      () => new EgressGate([policies[0] as ProviderPolicy, policies[0] as ProviderPolicy]),
      "Duplicate",
    );
    denied(
      () =>
        new EgressGate([
          { ...(policies[0] as ProviderPolicy), allowPersonalData: undefined as never },
        ]),
      "incomplete",
    );
    denied(
      () => new EgressGate([{ ...(policies[0] as ProviderPolicy), enabled: "yes" as never }]),
      "incomplete",
    );
  });

  it("is not affected by later changes to the policy objects it was given", () => {
    const mutable: ProviderPolicy = { ...(policies[0] as ProviderPolicy) };
    const g = new EgressGate([mutable]);
    (mutable as { allowPersonalData: boolean }).allowPersonalData = true;
    denied(() =>
      g.authorizeForProvider("cloud-strict", [{ label: "personal", content: "x" }], asMessages),
    );
  });
});

describe("verifyClearance (used by the transport)", () => {
  const genuine = gate.authorizeForProvider(
    "cloud-strict",
    [{ label: "public", content: "x" }],
    asMessages,
  );

  it("accepts a genuine clearance for its own origin", () => {
    expect(verifyClearance(genuine, new URL("https://strict.example/v1/chat"))).toBe(genuine);
  });

  it("rejects forged and copied clearances", () => {
    const forged: EgressClearance = { ...genuine };
    denied(
      () => verifyClearance(forged, new URL("https://strict.example/v1")),
      "without an egress clearance",
    );
    denied(() => verifyClearance({ body: "{}" }, new URL("https://strict.example")));
    denied(() => verifyClearance("{}", new URL("https://strict.example")));
    denied(() => verifyClearance(null, new URL("https://strict.example")));
  });

  it("rejects a clearance used for another origin (local clearance sent to the cloud)", () => {
    const local = gate.authorizeForProvider(
      "ollama",
      [{ label: "local_only", content: "x" }],
      asMessages,
    );
    denied(
      () => verifyClearance(local, new URL("https://trusted.example/v1")),
      "issued for http://127.0.0.1:11434",
    );
    denied(() => verifyClearance(genuine, new URL("https://strict.example.evil.test/")));
    denied(() => verifyClearance(genuine, new URL("http://strict.example/"))); // scheme is part of the origin
  });
});
