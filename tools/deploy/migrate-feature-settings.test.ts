import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = join(import.meta.dirname, "..", "..", "deploy", "migrate-feature-settings.sh");

type Options = {
  identities?: boolean;
  managed?: boolean;
  ocrImageGlobs?: boolean;
  services?: string;
  settings?: boolean;
};

function run({
  identities = true,
  managed = false,
  ocrImageGlobs = false,
  services = "",
  settings = true,
}: Options): string {
  const root = mkdtempSync(join(tmpdir(), "fdrive-feature-migrate-"));
  try {
    const script = join(root, "migrate.sh");
    const bin = join(root, "bin");
    mkdirSync(bin);
    copyFileSync(source, script);
    chmodSync(script, 0o755);
    const log = join(root, "docker.log");
    const docker = join(bin, "docker");
    writeFileSync(
      docker,
      `#!/bin/bash
if [[ "$1" == inspect ]]; then
  if [[ $* == *FDRIVE_FEATURES_MANAGED* ]]; then [[ $MANAGED == true ]] && printf managed; fi
  if [[ $* == *'range .Config.Env'* ]]; then [[ $OCR_IMAGE_GLOBS == true ]] && printf 'OCR_IMAGE_GLOBS=sftpgo/Scans/*'; fi
  exit 0
fi
if [[ "$1" == compose ]]; then
  if [[ $* == *'ps --status running --services'* ]]; then printf '%s\\n' "$SERVICES"; exit 0; fi
  if [[ $* == *'ps -q api'* ]]; then [[ $MANAGED == true ]] && printf api-container; exit 0; fi
  if [[ $* == *"to_regclass('app.settings')"* ]]; then [[ $SETTINGS == true ]] && printf t; exit 0; fi
  if [[ $* == *"to_regclass('app.identities')"* ]]; then [[ $IDENTITIES == true ]] && printf t; exit 0; fi
  if [[ $* == *'SELECT EXISTS (SELECT 1 FROM app.identities)'* ]]; then [[ $IDENTITIES == true ]] && printf t; exit 0; fi
  if [[ $* == *"key = 'indexer.ocr_image_globs'"* ]]; then [[ $OCR_IMAGE_GLOBS == true ]] && printf t; exit 0; fi
fi
printf '%s\\n' "$*" >> "$LOG"
if [[ $* == *'--file=-'* ]]; then cat >> "$LOG"; fi
exit 0
`,
    );
    chmodSync(docker, 0o755);
    execFileSync("bash", [script, "-f", "compose.yaml"], {
      env: {
        ...process.env,
        IDENTITIES: String(identities),
        LOG: log,
        MANAGED: String(managed),
        OCR_IMAGE_GLOBS: String(ocrImageGlobs),
        PATH: `${bin}:${process.env.PATH}`,
        SERVICES: services,
        SETTINGS: String(settings),
      },
    });
    return existsSync(log) ? execFileSync("cat", [log], { encoding: "utf8" }) : "";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("migrate-feature-settings.sh", () => {
  it("skips a fresh install with no running services", () => expect(run({})).toBe(""));

  it("does not infer enabled features for an unconfigured managed stack", () => {
    expect(run({ managed: true, services: "api\nindexer\nembed\nimage-embed\nocr\ntika" })).toBe(
      "",
    );
  });

  it("skips an old database that has not created the settings schema", () => {
    expect(run({ services: "api\nindexer", settings: false })).toBe("");
  });

  it("records only actual running legacy workers", () => {
    const sql = run({ services: "api\nindexer\nembed\nimage-embed\n" });
    expect(sql).toContain('"thumbnails":true');
    expect(sql).toContain('"textSearch":true');
    expect(sql).toContain('"searchOcr":false');
    expect(sql).toContain('"semanticSearch":true');
    expect(sql).toContain('"imageSearch":true');
    expect(sql).toContain('"pdfOcr":false');
    expect(sql).toContain("ON CONFLICT (key) DO NOTHING");
  });

  it("preserves an explicitly configured legacy OCR image policy", () => {
    const sql = run({ ocrImageGlobs: true, services: "api\nindexer" });
    expect(sql).toContain('"searchOcr":true');
    expect(sql).toContain("indexer.ocr_image_globs");
    expect(sql).toContain("legacy_ocr_globs");
  });

  it("keeps a legacy core-only installation complete with every optional feature off", () => {
    const sql = run({ services: "api" });
    expect(sql).toContain('"thumbnails":false');
    expect(sql).toContain('"textSearch":false');
    expect(sql).toContain('"searchOcr":false');
    expect(sql).toContain('"semanticSearch":false');
    expect(sql).toContain('"imageSearch":false');
    expect(sql).toContain('"pdfOcr":false');
    expect(sql).toContain('"walkthroughComplete":true');
  });

  it("uses an insert that leaves an existing configuration unchanged", () => {
    const sql = run({ services: "api\nindexer" });
    expect(sql).toContain("ON CONFLICT (key) DO NOTHING");
  });
});
