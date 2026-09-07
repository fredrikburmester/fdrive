import { expect, it } from "vitest";
import { run, runWithInput } from "./process";

it("captures successful child output without printing arguments", async () => {
  expect(await run(process.execPath, ["-e", "process.stdout.write('fixture')"])).toBe("fixture");
});
it("returns bounded stderr for failed commands", async () => {
  await expect(
    run(process.execPath, ["-e", "process.stderr.write('failed fixture'); process.exit(1)"]),
  ).rejects.toThrow("failed fixture");
  await expect(
    run(process.execPath, ["-e", "setTimeout(()=>{},1000)"], { timeout: 10 }),
  ).rejects.toThrow("failed:");
});
it("pipes input and detects exit failure, timeout and spawn failure", async () => {
  await runWithInput(process.execPath, ["-e", "process.exit(0)"], "x".repeat(1024 * 1024));
  await runWithInput(
    process.execPath,
    ["-e", "process.stdin.on('data',d=>{if(d.toString()!=='hello')process.exit(1)})"],
    "hello",
  );
  await expect(
    runWithInput(process.execPath, ["-e", "process.stderr.write('bad input');process.exit(2)"], ""),
  ).rejects.toThrow("bad input");
  await expect(
    runWithInput(process.execPath, ["-e", "setTimeout(()=>{},1000)"], "", 10),
  ).rejects.toThrow("failed:");
  await expect(runWithInput("/nonexistent-fdrive-fixture-executable", [], "")).rejects.toThrow();
});
