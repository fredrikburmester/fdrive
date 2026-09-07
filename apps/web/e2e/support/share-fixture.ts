import type { SeedUser } from "@fdrive/testkit";

/** Shares have disposable owners, independent of other browser suites. */
export const SHARE_USERS: readonly SeedUser[] = [
  { username: "share_owner", password: "share-owner-test-password", permissions: { "/": ["*"] } },
];
export const SHARE_FILES = {
  share_owner: {
    "/hello.txt": "Public hello 日本 100%",
    "/second.txt": "Second shared document",
    "/folder/日本 100%.txt": "Unicode and literal percent",
    "/folder/nested/literal%2f.txt": "Literal percent slash text",
    "/folder/document.docx": "Office shares are download only",
    "/folder/active.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "/folder/readme.md":
      "# Shared notes\n<script>alert(1)</script>\n![tracker](https://example.invalid/pixel)\n",
    "/folder/oversize.txt": "x".repeat(1024 * 1024 + 1),
    "/incoming/.keep": "Upload destination",
  },
};

/** A minimal decodable 1x1 PNG, used to exercise the public gallery and lightbox. */
export function shareImageFixture(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

/** One second of silent PCM, used to exercise native audio Range requests. */
export function shareAudioFixture(): Buffer {
  const wave = Buffer.alloc(16044);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(16000, 40);
  return wave;
}
