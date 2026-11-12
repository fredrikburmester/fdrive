# ML server

One Rust server, `services/ml`, that takes over text embeddings, image embeddings and document
text extraction from three containers (`embed`, `image-embed`, `tika`) and their runtime
controllers. The server is built and verified on its own. Nothing runs it yet: no compose file,
published image or API setting refers to it. Contract, configuration and checks are in its
[README](../../services/ml/README.md).

## Outcome

An installation runs one `ml` container where it ran three. The indexer and the API keep calling
the same HTTP contracts at new base URLs (`http://ml:8080/text`, `/image`, `/extract`), the
owner's feature switches load and unload models as before, and an existing index keeps its
vectors. Image indexing is about 2.5 times faster than today and queries find more, from the
two changes the [benchmark](#image-model-benchmark-2026-11-12) led to.

## Verified on 2026-11-12

Measured against the services being replaced, on the same inputs. The image rows were measured
with the full-precision vision tower, before the server moved to the 8-bit one; they show that
everything around the model (decoding, resizing, tokenizing) matches the Python service.

| Unit | Result |
| --- | --- |
| Text | Cosine similarity 1.00000000 with TEI `cpu-1.9.2` on eight multilingual inputs, one of them 1,205 tokens cut to 512. Largest element difference 5.1e-07. |
| Image | 13 thumbnails in the indexer's format (256 px WebP): cosine at least 0.999999 with the Python service. Originals that are not thumbnails: lowest 0.99987, a JPEG, from the decoder. Ten queries: cosine 1.000000, and ranking stored vectors gives the same order. |
| Extraction | Word for word the same as Tika 3.2.1 on the generated `.doc`, `.docx`, `.pptx`, `.rtf` and `.xlsx` fixtures. On 190 Apache POI sample documents, 86% of the distinct words Tika returns. All 1,541 files of that corpus extract or fail cleanly. |

With the full-precision vision tower, on Linux arm64 in Docker with four threads and averaged
over four runs each, the image unit took 525 ms per image and 150 ms per query, against 500 ms
and 185 ms for the Python service. The image is 215 MB, against 1.63 GB for `image-embed` and
938 MB for TEI.

Memory was worse with that tower: 2.9 GiB of private memory with image search on, where the
Python service held 0.6 GiB of private memory plus 2.3 GiB of weights mapped from the model
file, which the kernel can drop under pressure. Text search adds about 1.0 GiB. Switching both
off returns all but about 0.9 GiB.

As shipped, with the 8-bit vision tower, the same setup takes 179 ms per image and 135 ms per
query and holds 1.65 GiB of private memory with image search on.

## Remaining

### Switch the stack over

- Compose (`deploy/compose.yaml`, `deploy/compose.dev.yaml`): one `ml` service with a models
  volume replaces `tika`, `embed` and `image-embed`. Point `FDRIVE_EMBED_URL`,
  `FDRIVE_IMAGE_EMBED_URL`, `FDRIVE_TIKA_URL`, their `*_RUNTIME_URL` twins and the indexer's
  `EMBED_URL`, `IMAGE_EMBED_URL` and `TIKA_URL` at the unit prefixes. Fold
  `FDRIVE_EMBED_THREADS`, `FDRIVE_IMAGE_EMBED_THREADS` and the Tika JVM settings into one thread
  and one memory setting.
- API: `fetchRuntimeStatus` in `apps/api/src/system/runtime-status.ts` replaces the URL path
  with `/runtime`. It has to append instead, as the feature probe already does, or the three
  units answer for each other on the public health endpoint.
- Images workflow: publish `ml`; drop `tika`, `embed` with its arm64 source build, and
  `image-embed`.
- Remove `services/image-embed`, `deploy/runtime/Dockerfile.{tika,tei,tei-arm64,image-embed}`
  and the generic controller in `services/runtime`. The ONLYOFFICE controller stays.
- Documentation: [indexer](../INDEXER.md), [search](../SEARCH-AND-AI.md),
  [development](../DEVELOPMENT.md), the deploy README and reference, and the generated env
  example.
- Run the indexer against the real stack: a reindex with text search, semantic search and image
  search on, with `deploy/wait-ready.ts` passing.

Upgrade behavior to state in the release notes: the first start downloads both models again
(490 MB and 2.6 GB) into the new volume, and no file is re-embedded. The old `data/models`
directory and `fdrive-image-embed-models` volume can then be deleted.

### Measure on amd64

Speed, memory and search quality are from arm64. Repeat the image benchmark on a real amd64
host before the switch, since that is what most installations run and quantized arithmetic
takes a different code path there. Under emulation without AVX2, 60 images came out with a
cosine of 0.98 against their ARM vectors and the same distance from full precision as on ARM
(0.91), so the path that was reachable shows no extra loss. AVX2 and AVX-512 are untested, and
so is speed.

### Lower the image unit's memory

PyTorch maps the weights file and never copies it, so its weights are file-backed pages
(`file_mapped` 2.31 GiB, `anon` 0.59 GiB in the container's `memory.stat`). ONNX Runtime copies
the weights into private memory: `anon` 2.87 GiB with the full-precision vision tower, 1.65 GiB
as shipped. What is left is mostly the text tower's token table. Option to measure: getting ONNX
Runtime to map that tower's external weight file.

Dropping the models leaves about 0.9 GiB with the allocator, where stopping the old containers
returned everything. `MALLOC_MMAP_THRESHOLD_=1048576` brought that to 0.65 GiB in one run;
measure it properly before setting it in the image.

### Close extraction gaps that matter

Not read today: iWork (`.pages`, `.numbers`, `.key`), legacy Visio (`.vsd`), Publisher (`.pub`),
WordPerfect (`.wpd`), `.xlsb` and Huffman-compressed MOBI. These answer 422 and the indexer
records them as unsupported. Text inside embedded objects (documents attached to a `.msg`,
workbooks behind a chart) is skipped, which is most of the remaining difference from Tika. Add
a format when a real library shows it is missed.

## Image model benchmark, 2026-11-12

1,000 photos from the Crossmodal-3600 set, prepared as the indexer prepares them (256 px WebP),
each searched for with its first English and its first Swedish caption. "First hit" is how often
the right photo comes back first; the margin of error is about 1.5 points. Speed and memory are
from an Apple M-series CPU with four threads; amd64 is not measured.

| Image model | First hit, English | First hit, Swedish | Per image | Memory |
| --- | --- | --- | --- | --- |
| SigLIP 2 large, as shipped today | 66.8% | 56.6% | 461 ms | 3.0 GB |
| Large, queries lowercased | 71.3% | 66.9% | 461 ms | 3.0 GB |
| Large, image tower in 8-bit, queries lowercased | 70.1% | 66.7% | 163 ms | 2.1 GB |
| Base patch 16, queries lowercased | 72.1% | 63.4% | 132 ms | 2.0 GB |
| Base patch 32, queries lowercased | 70.4% | 62.1% | 35 ms | 1.7 GB |
| So400m, queries lowercased | 71.5% | 68.8% | 806 ms | 3.9 GB |

Findings:

- Queries are not lowercased today, in the Python service or in this server, and the model was
  trained on lowercased text. Lowercasing them is worth 4 points in English and 10 in Swedish,
  changes no stored vector, and applies to the Python service as much as to this one.
- The 8-bit image tower of the large model indexes 2.8 times faster for about one point. Its
  vectors can share an index with existing full-precision ones: a half-and-half index scored
  71.2% and 66.6%. Nothing in fdrive compares image vectors with each other.
- 8-bit query towers are unusable: Swedish first hits fall from 57% to 14% on the large model.
  8-bit image towers of the base and So400m models are unusable too (first hits of 51% and 14%).
- The base models need a re-embed of every library and a 768-wide vector column. Base patch 32
  is 13 times faster than today's model at about 5 points of Swedish quality. Its coarser
  patches may hurt searches for small details, which this test set does not measure.
- So400m is slower and not measurably better.

The 8-bit tower chooses its number ranges from everything in one inference call, so the same
image embedded alone and in a batch of eight gave vectors with a cosine of 0.97. Search quality
is the same either way (first hits of 69.5% and 66.0% one at a time), and one at a time costs
13% of the speed (184 ms against 163 ms), so the server embeds one image per call and a vector
never depends on the rest of a request.

Shipped from this: lowercased queries, here and as a separate fix to the Python service
(`fix/image-search-lowercase-queries`), and the 8-bit vision tower of the large model with the
full-precision text tower. A base model stays an option if indexing speed still matters.

## Decided

- OCR stays as it is. It rewrites people's PDFs through `ocrmypdf`; this server never writes to
  storage.
- The indexer stays a separate Python service. It needs the database and the file mounts that
  this server deliberately does not have. Porting it is a separate decision.
