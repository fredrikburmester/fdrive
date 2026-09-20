import type { OrganizeSharing, OrganizeSuggestion } from "@fdrive/contracts";
import { createMemoryStorage } from "@fdrive/core/testing";
import { describe, expect, it, vi } from "vitest";
import { AiProviderError } from "../model.ts";
import type { TypeSafeAnswer, TypeSafeClient, TypeSafeRequest } from "../typesafe.ts";
import type { OrganizeItem } from "./agent.ts";
import { triageNames, verifySuggestions } from "./assist.ts";

const SHARE_ALL: OrganizeSharing = { contents: true, otherFileNames: true };
const NO_OTHER_NAMES: OrganizeSharing = { contents: true, otherFileNames: false };

function item(path: string, overrides: Partial<OrganizeItem> = {}): OrganizeItem {
  return {
    path,
    kind: "file",
    size: 2048,
    modifiedAt: new Date("2026-05-02T09:00:00.000Z"),
    ...overrides,
  };
}

function suggestion(
  path: string,
  destination: string,
  overrides: Partial<OrganizeSuggestion> = {},
): OrganizeSuggestion {
  return {
    path,
    kind: "file",
    destination,
    target: `${destination}/${path.split("/").pop()}`,
    reason: "Because.",
    newFolder: false,
    conflict: false,
    ...overrides,
  };
}

function fakeClient(answer: (request: TypeSafeRequest) => Record<string, TypeSafeAnswer>) {
  const requests: TypeSafeRequest[] = [];
  const client: TypeSafeClient = {
    async systemOne(request) {
      requests.push(request);
      return answer(request);
    },
    async ping() {
      return { ok: true, message: "ok" };
    },
  };
  return { client, requests };
}

/** A Score answer putting `fits` on the top level and the remainder on "Wrong". */
function fitScore(fits: number): TypeSafeAnswer {
  return {
    type: "score",
    score: fits * 2,
    confidence: 1,
    probabilities: { "0": 1 - fits, "1": 0, "2": fits },
  };
}

function nouls(...values: number[]): Record<string, TypeSafeAnswer> {
  return Object.fromEntries(
    values.map((noul, index) => [`q${index}`, { type: "noul", noul } as const]),
  );
}

const SIGNAL = new AbortController().signal;

describe("triageNames", () => {
  it("flags only the items whose name is judged to say too little", async () => {
    const { client } = fakeClient(() => nouls(0.1, 0.49, 0.5, 0.95));
    const items = [
      item("/Inbox/scan001.pdf"),
      item("/Inbox/IMG_2231.jpg"),
      item("/Inbox/borderline.pdf"),
      item("/Inbox/tax-return-2025.pdf"),
    ];

    const unclear = await triageNames({ client, items, signal: SIGNAL });

    expect([...unclear]).toEqual(["/Inbox/scan001.pdf", "/Inbox/IMG_2231.jpg"]);
  });

  it("asks one question per item about the matching state entry, and sends no contents", async () => {
    const { client, requests } = fakeClient(() => nouls(0.9, 0.9));

    await triageNames({
      client,
      items: [item("/Inbox/a.pdf"), item("/Inbox/photos", { kind: "dir", size: 0 })],
      signal: SIGNAL,
    });

    expect(requests).toHaveLength(1);
    const request = requests[0] as TypeSafeRequest;
    expect(Object.keys(request.questions)).toEqual(["q0", "q1"]);
    expect(request.questions.q0?.instructions).toContain("`items[0]`");
    expect(request.questions.q1?.instructions).toContain("`items[1]`");
    expect(request.state).toEqual({
      drive: "One person's file drive.",
      items: [
        { name: "a.pdf", kind: "file", folder: "/Inbox", size: "2.0 KB", modified: "2026-05-02" },
        { name: "photos", kind: "dir", folder: "/Inbox", modified: "2026-05-02" },
      ],
    });
    expect(JSON.stringify(request)).not.toContain("excerpt");
  });

  it("splits a large selection across requests", async () => {
    const { client, requests } = fakeClient(() => ({}));
    const items = Array.from({ length: 60 }, (_value, index) => item(`/Inbox/${index}.pdf`));

    await triageNames({ client, items, signal: SIGNAL });

    expect(requests).toHaveLength(2);
    expect(Object.keys(requests[0]?.questions ?? {})).toHaveLength(50);
    expect(Object.keys(requests[1]?.questions ?? {})).toHaveLength(10);
  });

  it("leaves out a date it does not have", async () => {
    const { client, requests } = fakeClient(() => nouls(0.9));

    await triageNames({
      client,
      items: [item("/Inbox/a.pdf", { modifiedAt: null })],
      signal: SIGNAL,
    });

    expect((requests[0] as TypeSafeRequest).state).toEqual({
      drive: "One person's file drive.",
      items: [{ name: "a.pdf", kind: "file", folder: "/Inbox", size: "2.0 KB" }],
    });
  });

  it("flags nothing when TypeSafe refuses the request", async () => {
    const client: TypeSafeClient = {
      systemOne: vi.fn(async () => {
        throw new AiProviderError("TypeSafe rejected the API key.");
      }),
      async ping() {
        return { ok: false, message: "no" };
      },
    };

    const unclear = await triageNames({ client, items: [item("/Inbox/a.pdf")], signal: SIGNAL });

    expect([...unclear]).toEqual([]);
  });
});

describe("verifySuggestions", () => {
  function drive() {
    return createMemoryStorage({
      "/Finance/Receipts/rent-2025.pdf": "a",
      "/Finance/Receipts/power-2025.pdf": "b",
      "/Photos/Holiday/IMG_1.jpg": "c",
    });
  }

  it("flags a destination the model does not put on the top level", async () => {
    const { client } = fakeClient(() => ({ q0: fitScore(0.9), q1: fitScore(0.49) }));

    const doubtful = await verifySuggestions({
      client,
      storage: drive(),
      suggestions: [
        suggestion("/Inbox/rent-2026.pdf", "/Finance/Receipts"),
        suggestion("/Inbox/taxes-2023.pdf", "/Photos/Holiday"),
      ],
      share: SHARE_ALL,
      signal: SIGNAL,
    });

    expect([...doubtful]).toEqual(["/Inbox/taxes-2023.pdf"]);
  });

  it("shows what an existing destination already holds when other names are shared", async () => {
    const { client, requests } = fakeClient(() => ({ q0: fitScore(1) }));

    await verifySuggestions({
      client,
      storage: drive(),
      suggestions: [suggestion("/Inbox/rent-2026.pdf", "/Finance/Receipts")],
      share: SHARE_ALL,
      signal: SIGNAL,
    });

    expect((requests[0] as TypeSafeRequest).state).toMatchObject({
      suggestions: [
        {
          item: "rent-2026.pdf",
          movingFrom: "/Inbox",
          destination: "/Finance/Receipts",
          destinationHolds: ["rent-2025.pdf", "power-2025.pdf"],
        },
      ],
    });
  });

  it("sends no folder contents when the person did not share other file names", async () => {
    const storage = drive();
    const list = vi.spyOn(storage, "list");
    const { client, requests } = fakeClient(() => ({ q0: fitScore(1) }));

    await verifySuggestions({
      client,
      storage,
      suggestions: [suggestion("/Inbox/rent-2026.pdf", "/Finance/Receipts")],
      share: NO_OTHER_NAMES,
      signal: SIGNAL,
    });

    expect(list).not.toHaveBeenCalled();
    expect(JSON.stringify(requests[0]?.state)).not.toContain("destinationHolds");
  });

  it("says a new folder is new and never claims to know what it holds", async () => {
    const { client, requests } = fakeClient(() => ({ q0: fitScore(1) }));

    await verifySuggestions({
      client,
      storage: drive(),
      suggestions: [
        suggestion("/Inbox/rent-2026.pdf", "/Finance/Receipts/2026", { newFolder: true }),
      ],
      share: SHARE_ALL,
      signal: SIGNAL,
    });

    expect((requests[0] as TypeSafeRequest).state).toMatchObject({
      suggestions: [{ destination: "/Finance/Receipts/2026", destinationIsNew: true }],
    });
    expect(JSON.stringify(requests[0]?.state)).not.toContain("destinationHolds");
  });

  it("leaves a suggestion alone when its answer never comes back", async () => {
    const { client } = fakeClient(() => ({ q1: fitScore(0.1) }));

    const doubtful = await verifySuggestions({
      client,
      storage: drive(),
      suggestions: [
        suggestion("/Inbox/a.pdf", "/Finance/Receipts"),
        suggestion("/Inbox/b.pdf", "/Photos/Holiday"),
      ],
      share: SHARE_ALL,
      signal: SIGNAL,
    });

    expect([...doubtful]).toEqual(["/Inbox/b.pdf"]);
  });

  it("asks nothing when there are no suggestions", async () => {
    const { client, requests } = fakeClient(() => ({}));

    const doubtful = await verifySuggestions({
      client,
      storage: drive(),
      suggestions: [],
      share: SHARE_ALL,
      signal: SIGNAL,
    });

    expect([...doubtful]).toEqual([]);
    expect(requests).toEqual([]);
  });
});
