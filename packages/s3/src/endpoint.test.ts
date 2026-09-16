import { describe, expect, it } from "vitest";
import { candidateProblem, parseEndpoint } from "./endpoint.js";

describe("candidateProblem", () => {
  it.each([
    ["not a url", "S3 address is invalid"],
    ["ftp://host/bucket", "S3 address must use http or https"],
    ["http://user:pw@host/bucket", "S3 address must not include credentials"],
    ["http://host/bucket?x=1", "S3 address must not include a query or fragment"],
    ["http://host/bucket#frag", "S3 address must not include a query or fragment"],
    ["http://169.254.169.254/bucket", "S3 address targets a prohibited metadata host"],
    ["http://[fd00:ec2::254]/bucket", "S3 address targets a prohibited metadata host"],
    ["http://host/bucket/../x", "S3 bucket name is invalid: x"],
    ["http://host/Bucket", "S3 bucket name is invalid: Bucket"],
    ["http://host/ab", "S3 bucket name is invalid: ab"],
    ["http://host/bucket/a%00b", "S3 prefix segment is invalid: a%00b"],
    ["http://host/bucket/%zz", "S3 prefix segment is invalid: %zz"],
  ])("rejects %s", (url, problem) => {
    expect(candidateProblem(url)).toBe(problem);
  });

  it("reports a missing bucket", () => {
    expect(candidateProblem("http://host")).toContain("must name the bucket");
    expect(candidateProblem("http://host/")).toContain("must name the bucket");
  });

  it("accepts a bucket with and without a prefix", () => {
    expect(candidateProblem("https://minio.local:9000/media")).toBeNull();
    expect(candidateProblem("https://minio.local:9000/media/team%20drive/photos/")).toBeNull();
  });
});

describe("parseEndpoint", () => {
  it("splits origin, bucket and decoded prefix", () => {
    expect(parseEndpoint("https://minio.local:9000/media")).toEqual({
      endpoint: "https://minio.local:9000",
      bucket: "media",
      prefix: "",
    });
    expect(parseEndpoint("http://s3.test/bucket/team%20drive/photos/")).toEqual({
      endpoint: "http://s3.test",
      bucket: "bucket",
      prefix: "team drive/photos",
    });
  });

  it("throws for anything candidateProblem rejects", () => {
    expect(() => parseEndpoint("http://host/")).toThrow("must name the bucket");
  });
});
