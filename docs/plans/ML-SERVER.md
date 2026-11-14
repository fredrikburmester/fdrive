# ML server follow-ups

Text embeddings, image embeddings and document text extraction run in one Rust server,
[`services/ml`](../../services/ml/README.md), which replaced the `embed`, `image-embed` and
`tika` containers. Its README has the contract, the configuration and the measurements behind
the choices. What is left:

## Measure on real amd64 hardware

Speed, memory and search quality were measured on arm64. The 8-bit vision tower takes a
different code path per CPU family, and the one x86 path reachable under emulation (no AVX2)
showed no extra loss: 60 images came out with a cosine of 0.98 against their ARM vectors and
the same distance from full precision as on ARM (0.91). `CI (full)` runs the real-model probes
on an amd64 runner and prints the time per image. Still to do on a real server: the image
benchmark for speed, and a look at search quality after indexing a real library.

## Lower the image unit's memory

PyTorch mapped the weights file and never copied it, so the Python service held 0.59 GiB of
private memory plus 2.31 GiB of file-backed pages the kernel could drop. ONNX Runtime copies
the weights into private memory: 1.65 GiB with image search on, mostly the text tower's token
table. Option to measure: getting ONNX Runtime to map that tower's external weight file.

Dropping the models leaves about 0.9 GiB with the allocator, where stopping the old containers
returned everything. `MALLOC_MMAP_THRESHOLD_=1048576` brought that to 0.65 GiB in one run;
measure it properly before setting it in the image.

## Close extraction gaps that matter

Not read today: iWork (`.pages`, `.numbers`, `.key`), legacy Visio (`.vsd`), Publisher (`.pub`),
WordPerfect (`.wpd`), `.xlsb` and Huffman-compressed MOBI. These answer 422 and the indexer
records them as unsupported. Text inside embedded objects (documents attached to a `.msg`,
workbooks behind a chart) is skipped, which is most of the remaining difference from Tika. Add
a format when a real library shows it is missed.

## A smaller image model, if indexing speed still matters

SigLIP 2 base with 32-pixel patches embeds an image 13 times faster than the full-precision
large tower, at about 5 points of Swedish first-hit rate. It needs every library re-embedded
and a 768-wide vector column. Its coarser patches may hurt searches for small details, which
the benchmark's test set does not measure.

## Decided

- OCR stays as it is. It rewrites people's PDFs through `ocrmypdf`; this server never writes to
  storage.
- The indexer stays a separate Python service. It needs the database and the file mounts that
  this server deliberately does not have. Porting it is a separate decision.
