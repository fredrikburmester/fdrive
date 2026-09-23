# Releases

The fdrive server ships as Docker images, built and published to the GitHub Container
Registry by [`images.yml`](../.github/workflows/images.yml). The images are listed in the
[deployment reference](../deploy/REFERENCE.md#published-images). FDrive for Mac is released
separately; see [Mac releases](MACOS-RELEASE.md).

## Channels

| Push | Publishes |
| --- | --- |
| A merge to `main` | `main` and `sha-<commit>` images: the edge channel, `FDRIVE_VERSION=main` |
| A `vX.Y.Z` tag on a commit in `main` | `X.Y.Z`, `X.Y` and `latest` images, then a GitHub release |
| A `vX.Y.Z-rc.N` tag on a commit in `main` | `X.Y.Z-rc.N` images and a pre-release; `latest` stays where it is |

Installations follow the newest `vX.Y.Z` release by default; see
[updates and versions](../deploy/README.md#updates-and-versions). Each platform builds on
its own native runner. A channel moves only when every image built and the core stack
(proxy, web, API, backup worker and database) started from them through `compose.yaml`,
so it never mixes images from two commits or moves to a stack that cannot start.

## Cutting a release

Tag a commit that is already on `main`, using semantic versioning:

```sh
git fetch origin main
git tag v0.2.0 origin/main
git push origin v0.2.0
```

The workflow refuses a tag that is not on `main` or not shaped like `v1.2.3` or `v1.2.3-rc.1`.
It builds every image for amd64 and arm64, tags them, and creates the GitHub release with
notes generated from the merged pull requests since the previous release. The release
carries a `compose.yaml` pinned to its version, `compose.sftpgo.yaml` and `init-env.sh` for
[installing without git](../deploy/README.md#installing-without-git). Edit the notes
afterwards to call out anything operators must do.

Every installation on the default channel moves to the new release on its next
`./update.sh`, so tag only what is ready. Fix a bad release with a new patch release rather
than deleting its tag: installations may already have checked it out. If a release's images
fail to publish, `update.sh` stops before touching running containers; re-run the failed
jobs or publish a new patch release.

## First publish of an image

GitHub creates every new container package as private and has no API to change that. After
the first run that publishes an image, which is the first merge to `main` for all of them,
open each package from the [package list](https://github.com/fredrikburmester?tab=packages)
and set **Package settings > Change visibility** to public. Until then installations cannot
pull it, and each run warns about every image an anonymous client cannot pull.
`fdrive-tei-arm64` is only the build base of `fdrive-embed` and can stay private.

## Pull requests

A pull request that changes an image definition or `compose.yaml` builds the amd64 images
and starts the core stack, without publishing anything. The `ci:full` label also builds
the web and api images, whose builds can break on application changes alone.
