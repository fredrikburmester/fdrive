import { describeStorageProvider } from "@fdrive/testkit";
import { createS3Client } from "./client.js";
import { createFakeS3Server } from "./fake/server.js";
import { createS3StorageProvider } from "./storage-provider.js";

const ALICE = { accessKeyId: "alice-key", secretAccessKey: "alice-secret" };

function factory(prefix: string) {
  return () => {
    const server = createFakeS3Server({ keys: [ALICE] });
    const client = createS3Client({
      endpoint: "http://s3.test",
      region: "us-east-1",
      credential: ALICE,
      fetch: server.fetch,
    });
    return {
      storage: createS3StorageProvider({ client: async () => client, bucket: "bucket", prefix }),
    };
  };
}

describeStorageProvider("S3 fake server", factory(""), { overwritesOnMove: true });

describeStorageProvider("S3 fake server under a prefix", factory("team/drive"), {
  overwritesOnMove: true,
});
