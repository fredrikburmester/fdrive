import { expect, it } from "vitest";
import { isProhibitedMetadataHost } from "./metadata-hosts.ts";

it("recognises every cloud metadata host, case-insensitively and with IPv6 brackets", () => {
  expect(isProhibitedMetadataHost("169.254.169.254")).toBe(true);
  expect(isProhibitedMetadataHost("Metadata.Google.Internal")).toBe(true);
  expect(isProhibitedMetadataHost("[fd00:ec2::254]")).toBe(true);
  expect(isProhibitedMetadataHost(new URL("http://[FD00:EC2::254]/").hostname)).toBe(true);
});

it("lets ordinary hosts through", () => {
  expect(isProhibitedMetadataHost("minio.local")).toBe(false);
  expect(isProhibitedMetadataHost("169.254.169.2540")).toBe(false);
  expect(isProhibitedMetadataHost("")).toBe(false);
});
