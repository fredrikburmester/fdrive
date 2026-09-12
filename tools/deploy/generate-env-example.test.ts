import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConfigKeyDef, Subsystem } from "../../apps/api/src/config-keys.ts";
import {
  applyComposePassthroughBlock,
  applyPreflightKnownKeysBlock,
  COMPOSE_PASSTHROUGH_EXCLUDED_KEYS,
  ENV_EXAMPLE_EXCLUDED_KEYS,
  groupBySubsystem,
  knownFdriveKeys,
  renderApiEnvExample,
  renderComposePassthroughLines,
  renderEnvExample,
  renderEnvExampleEntry,
  renderKnownFdriveKeysBashArray,
  renderQuickstartEnvExample,
} from "./generate-env-example.ts";

const CONFIGURED: ConfigKeyDef = {
  key: "FDRIVE_TEST_KEY",
  description: "A test key.",
  default: "fallback",
  example: "fallback",
  secret: false,
  subsystem: "core",
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const deployDir = join(scriptDir, "..", "..", "deploy");

describe("groupBySubsystem", () => {
  it("groups in SUBSYSTEMS order and drops empty groups", () => {
    const keys: ConfigKeyDef[] = [
      { ...CONFIGURED, key: "A", subsystem: "office" },
      { ...CONFIGURED, key: "B", subsystem: "core" },
      { ...CONFIGURED, key: "C", subsystem: "core" },
    ];
    const groups = groupBySubsystem(keys);
    expect(groups.map((g) => g.subsystem)).toEqual(["core", "office"]);
    expect(groups[0]?.entries.map((e) => e.key)).toEqual(["B", "C"]);
    expect(groups[1]?.entries.map((e) => e.key)).toEqual(["A"]);
  });

  it("returns an empty array for an empty key list", () => {
    expect(groupBySubsystem([])).toEqual([]);
  });
});

describe("renderEnvExampleEntry", () => {
  it("renders a secret key as an active change-me line", () => {
    const rendered = renderEnvExampleEntry({ ...CONFIGURED, secret: true, default: null });
    expect(rendered).toContain("FDRIVE_TEST_KEY (secret)");
    expect(rendered).toContain("FDRIVE_TEST_KEY=change-me");
    expect(rendered).not.toContain("#FDRIVE_TEST_KEY");
  });

  it("renders a non-secret key with a default as a commented line showing the default", () => {
    const rendered = renderEnvExampleEntry(CONFIGURED);
    expect(rendered).toContain("# default: fallback");
    expect(rendered).toContain("#FDRIVE_TEST_KEY=fallback");
    expect(rendered).not.toContain("# example:");
  });

  it("shows a separate example line when the example differs from the default", () => {
    const rendered = renderEnvExampleEntry({ ...CONFIGURED, example: "other" });
    expect(rendered).toContain("# default: fallback");
    expect(rendered).toContain("# example: other");
  });

  it("renders a non-secret key with no default as a commented, empty line plus its example", () => {
    const rendered = renderEnvExampleEntry({ ...CONFIGURED, default: null, example: "sample" });
    expect(rendered).toContain("# example: sample");
    expect(rendered).toContain("#FDRIVE_TEST_KEY=");
    expect(rendered).not.toContain("# default:");
  });
});

describe("renderEnvExample", () => {
  it("is deterministic across repeated calls", () => {
    expect(renderEnvExample()).toBe(renderEnvExample());
  });

  it("excludes keys in the excluded set and never lists them", () => {
    const rendered = renderEnvExample([CONFIGURED], [], new Set(["FDRIVE_TEST_KEY"]));
    expect(rendered).not.toContain("FDRIVE_TEST_KEY");
  });

  it("keeps quick-start to secrets and an optional connection", () => {
    const rendered = renderQuickstartEnvExample();
    expect(rendered).toContain("FDRIVE_MASTER_KEY");
    expect(rendered).toContain("POSTGRES_PASSWORD");
    expect(rendered).toContain("SFTPGO_URL");
    expect(rendered).not.toContain("FDRIVE_PROFILES");
  });

  it("points the quick-start reader at the resource limits it deliberately omits", () => {
    // The CPU/memory caps and thread counts live only in REFERENCE.md; the
    // template's header is the one cue an operator reading it alone gets.
    const rendered = renderQuickstartEnvExample();
    expect(rendered).not.toContain("FDRIVE_EMBED_CPUS");
    expect(rendered).toContain("processing worker resource limits: REFERENCE.md");
  });

  it("ends with a trailing newline", () => {
    expect(renderEnvExample().endsWith("\n")).toBe(true);
  });
});

describe("renderComposePassthroughLines", () => {
  it("excludes secret keys", () => {
    const lines = renderComposePassthroughLines(
      [{ ...CONFIGURED, secret: true }],
      new Set<string>(),
    );
    expect(lines).toEqual([]);
  });

  it("excludes keys in the excluded set", () => {
    const lines = renderComposePassthroughLines([CONFIGURED], new Set(["FDRIVE_TEST_KEY"]));
    expect(lines).toEqual([]);
  });

  // The compose shell-style "${KEY:-}" text below is a literal bash
  // interpolation placeholder this module renders into YAML, not a JS
  // template string; biome's noTemplateCurlyInString does not apply.
  it("renders a KEY line with a shell-style default at six-space indent for an included key", () => {
    const lines = renderComposePassthroughLines([CONFIGURED], new Set<string>());
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose interpolation syntax, not a JS template string.
    expect(lines).toEqual(["      FDRIVE_TEST_KEY: ${FDRIVE_TEST_KEY:-}"]);
  });
});

describe("applyComposePassthroughBlock", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose interpolation syntax, not a JS template string.
  const OLD_LINE = "      OLD: ${OLD:-}";
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal compose interpolation syntax, not a JS template string.
  const NEW_LINE = "      NEW: ${NEW:-}";
  const source = [
    "services:",
    "  api:",
    "    environment:",
    "      FIXED: value",
    "      # BEGIN GENERATED CONFIG KEYS (tools/deploy/generate-env-example.ts)",
    OLD_LINE,
    "      # END GENERATED CONFIG KEYS",
    "    depends_on:",
    "      db:",
  ].join("\n");

  it("replaces the lines between the markers, keeping the markers and everything else", () => {
    const updated = applyComposePassthroughBlock(source, [NEW_LINE]);
    expect(updated).toContain("      FIXED: value");
    expect(updated).toContain(NEW_LINE);
    expect(updated).not.toContain("OLD:");
    expect(updated).toContain("    depends_on:");
  });

  it("throws when the begin marker is missing", () => {
    expect(() => applyComposePassthroughBlock("no markers here", [])).toThrow(/markers/);
  });

  it("throws when the end marker is missing", () => {
    const missingEnd = source.replace(/\n\s+# END GENERATED CONFIG KEYS/, "");
    expect(() => applyComposePassthroughBlock(missingEnd, [])).toThrow(/markers/);
  });

  it("throws when the end marker appears before the begin marker", () => {
    const swapped = [
      "      # END GENERATED CONFIG KEYS",
      "      # BEGIN GENERATED CONFIG KEYS (tools/deploy/generate-env-example.ts)",
    ].join("\n");
    expect(() => applyComposePassthroughBlock(swapped, [])).toThrow(/markers/);
  });
});

describe("knownFdriveKeys", () => {
  it("only includes FDRIVE_ prefixed keys", () => {
    const nonFdrive: ConfigKeyDef = { ...CONFIGURED, key: "DATABASE_URL" };
    const fdrive: ConfigKeyDef = { ...CONFIGURED, key: "FDRIVE_TEST_KEY" };
    expect(knownFdriveKeys([nonFdrive, fdrive], [], new Set<string>())).toEqual([
      "FDRIVE_TEST_KEY",
    ]);
  });

  it("excludes ENV_EXAMPLE_EXCLUDED_KEYS entries", () => {
    const excluded: ConfigKeyDef = { ...CONFIGURED, key: "FDRIVE_EXCLUDED" };
    expect(knownFdriveKeys([excluded], [], new Set(["FDRIVE_EXCLUDED"]))).toEqual([]);
  });

  it("includes FDRIVE_-prefixed DEPLOY_EXTRA_KEYS entries", () => {
    const deployOnly: ConfigKeyDef = { ...CONFIGURED, key: "FDRIVE_DEPLOY_ONLY" };
    expect(knownFdriveKeys([], [deployOnly], new Set<string>())).toEqual(["FDRIVE_DEPLOY_ONLY"]);
  });

  it("uses the real tables by default and returns only FDRIVE_ keys", () => {
    for (const key of knownFdriveKeys()) {
      expect(key.startsWith("FDRIVE_")).toBe(true);
    }
    expect(knownFdriveKeys().length).toBeGreaterThan(0);
  });
});

describe("renderKnownFdriveKeysBashArray", () => {
  it("renders an empty array literal for no keys", () => {
    expect(renderKnownFdriveKeysBashArray([])).toEqual(["KNOWN_FDRIVE_KEYS=(", ")"]);
  });

  it("renders one quoted, four-space-indented line per key", () => {
    expect(renderKnownFdriveKeysBashArray(["FDRIVE_A", "FDRIVE_B"])).toEqual([
      "KNOWN_FDRIVE_KEYS=(",
      '    "FDRIVE_A"',
      '    "FDRIVE_B"',
      ")",
    ]);
  });
});

describe("applyPreflightKnownKeysBlock", () => {
  const source = [
    "#!/bin/bash",
    "# BEGIN GENERATED KNOWN FDRIVE KEYS (tools/deploy/generate-env-example.ts)",
    "KNOWN_FDRIVE_KEYS=(",
    ")",
    "# END GENERATED KNOWN FDRIVE KEYS",
    "echo done",
  ].join("\n");

  it("replaces the array lines between the markers", () => {
    const updated = applyPreflightKnownKeysBlock(source, [
      "KNOWN_FDRIVE_KEYS=(",
      '    "FDRIVE_A"',
      ")",
    ]);
    expect(updated).toContain('"FDRIVE_A"');
    expect(updated).toContain("echo done");
  });

  it("throws when the markers are missing", () => {
    expect(() => applyPreflightKnownKeysBlock("no markers", [])).toThrow(/markers/);
  });
});

describe("COMPOSE_PASSTHROUGH_EXCLUDED_KEYS and ENV_EXAMPLE_EXCLUDED_KEYS", () => {
  it("both only reference real CONFIG_KEYS keys", async () => {
    const { CONFIG_KEYS } = await import("../../apps/api/src/config-keys.ts");
    const validKeys = new Set(CONFIG_KEYS.map((entry) => entry.key));
    for (const key of COMPOSE_PASSTHROUGH_EXCLUDED_KEYS) {
      expect(validKeys.has(key)).toBe(true);
    }
    for (const key of ENV_EXAMPLE_EXCLUDED_KEYS) {
      expect(validKeys.has(key)).toBe(true);
    }
  });
});

describe("generated file diff", () => {
  it("deploy/.env.example matches the quick-start render right now", () => {
    const committed = readFileSync(join(deployDir, ".env.example"), "utf-8");
    expect(committed).toBe(renderQuickstartEnvExample());
  });

  it("deploy/compose.yaml's generated block matches renderComposePassthroughLines() right now", () => {
    const committed = readFileSync(join(deployDir, "compose.yaml"), "utf-8");
    const regenerated = applyComposePassthroughBlock(committed, renderComposePassthroughLines());
    expect(committed).toBe(regenerated);
  });

  it("deploy/preflight.sh's known-keys array matches knownFdriveKeys() right now", () => {
    const committed = readFileSync(join(deployDir, "preflight.sh"), "utf-8");
    const regenerated = applyPreflightKnownKeysBlock(
      committed,
      renderKnownFdriveKeysBashArray(knownFdriveKeys()),
    );
    expect(committed).toBe(regenerated);
  });
});

describe("compose interpolation", () => {
  // deploy/.env feeds every compose file update.sh passes to docker compose,
  // so a `${FDRIVE_*}` reference in one of them is a key an operator is meant
  // to set there and preflight.sh must accept it. compose.dev.yaml is left
  // out: tools/orchestration drives it, not deploy/.env.
  const composeFiles = [
    "compose.yaml",
    "compose.arm64.yaml",
    "compose.sftpgo.yaml",
    "compose.office.collabora.yaml",
  ];

  it.each(composeFiles)("every FDRIVE_* key %s interpolates is a known preflight key", (file) => {
    const source = readFileSync(join(deployDir, file), "utf-8");
    const referenced = new Set(
      [...source.matchAll(/\$\{(FDRIVE_[A-Z0-9_]+)/g)]
        .map((match) => match[1])
        .filter((key): key is string => key !== undefined),
    );
    const known = new Set(knownFdriveKeys());
    const missing = [...referenced].filter((key) => !known.has(key)).sort();
    expect(missing).toEqual([]);
  });
});

describe("Subsystem", () => {
  it("type is usable as a plain string union", () => {
    const subsystem: Subsystem = "core";
    expect(subsystem).toBe("core");
  });
});

it("keeps the complete API env reference generated from the config catalog", () => {
  const rendered = renderApiEnvExample();
  expect(readFileSync(join(deployDir, "../apps/api/.env.example"), "utf8")).toBe(rendered);
  expect(rendered).not.toContain("FDRIVE_PUBLIC_URL=");
  expect(rendered).toContain("#FDRIVE_SETUP_TOKEN=");
  expect(knownFdriveKeys()).toContain("FDRIVE_SETUP_TOKEN");
  const compose = readFileSync(join(deployDir, "compose.yaml"), "utf8");
  expect(compose).toContain("FDRIVE_SETUP_TOKEN: ${FDRIVE_SETUP_TOKEN:-}");
  expect(compose).toContain("FDRIVE_OFFICE_PUBLIC_URL: ${FDRIVE_OFFICE_PUBLIC_URL:-}");
});
