import { expect, it, vi } from "vitest";
import { editorDiagnostics, editorExceptionSummary, editorFailureSummary } from "./diagnostics";

it("extracts allowlisted failure labels and status codes without leaking opaque log data", () => {
  expect(
    editorFailureSummary(
      'INFO safe\nERROR wopiClient CheckFileInfo statusCode: 403 access_token=SECRET https://secret.test\nWARN ETIMEDOUT code="503"',
    ),
  ).toEqual([
    '{"labels":["wopiClient","CheckFileInfo"],"codes":["403"]}',
    '{"labels":["ETIMEDOUT"],"codes":["503"]}',
  ]);
  expect(editorFailureSummary("ERROR opaque secret")).toEqual(['{"labels":[],"codes":[]}']);
});

it("reads only owned ONLYOFFICE service diagnostics", async () => {
  const execute = vi
    .fn<typeof import("./process").run>()
    .mockResolvedValue("ERROR GetFile statusCode: 404");
  const state = {
    product: "onlyoffice",
    officeContainer: "fixture",
  } as import("./state").OfficeFixtureState;
  expect(await editorDiagnostics(state, execute)).toEqual([
    '{"labels":["GetFile"],"codes":["404"]}',
  ]);
  expect(execute.mock.calls[0]?.[1]).toContain("fixture");
  expect(await editorDiagnostics({ ...state, product: "collabora" }, execute)).toEqual([]);
});

it("reports exception identifiers without source URLs, tokens or message content", () => {
  const text =
    "TypeError: Cannot read properties of undefined (reading 'GetContentPosition')\n at Shape.OnKeyDown (https://secret.test/sdk.js?access_token=SECRET:1:2)\n at Shape.OnKeyDown (https://secret.test/sdk.js:2:3)";
  expect(editorExceptionSummary(text)).toEqual({
    kind: "TypeError",
    properties: ["GetContentPosition"],
    functions: ["Shape.OnKeyDown"],
  });
  expect(editorExceptionSummary("RangeError opaque SECRET")).toEqual({
    kind: "RangeError",
    properties: [],
    functions: [],
  });
  expect(editorExceptionSummary("opaque access_token=SECRET")).toBeNull();
  expect(editorFailureSummary(`ERROR ${text.split("\n")[0]}`)).toEqual([
    '{"labels":["GetContentPosition"],"codes":[],"exception":{"kind":"TypeError","properties":["GetContentPosition"],"functions":[]}}',
  ]);
});

it("preserves bounded numeric engine codes without opaque messages or long identifiers", () => {
  expect(
    editorFailureSummary(
      "ERROR errorCode: -84 code=4 ERROR: -1 status=200 code=123456 errorCode=1.23 access_token=SECRET",
    ),
  ).toEqual(['{"labels":[],"codes":["-84","4","-1","200"]}']);
});
