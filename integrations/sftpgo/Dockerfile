FROM golang:1.25.8-bookworm@sha256:4557cf171e3cdf5053a298d5171b1a5f5734d920260c25f22c79e94760eb2084 AS source
WORKDIR /src
RUN git init && git remote add origin https://github.com/drakkan/sftpgo.git && \
    git fetch --depth 1 origin 9888a3d169aed9011ae6e4f7a97ae735c1643068 && \
    git checkout --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = 9888a3d169aed9011ae6e4f7a97ae735c1643068
COPY enforcement.patch /tmp/enforcement.patch
RUN git apply --unidiff-zero --check /tmp/enforcement.patch && git apply --unidiff-zero /tmp/enforcement.patch
COPY internal/ internal/
RUN gofmt -w internal/fdrivelease internal/vfs/fdrive_lease*.go internal/httpd/fdrive_lease.go \
    internal/config/fdrive_lease*.go internal/config/config.go internal/vfs/cryptfs.go \
    internal/vfs/osfs.go internal/httpd/api_http_user.go internal/httpd/server.go internal/dataprovider/user.go
ENV GOFLAGS=-mod=readonly

FROM source AS verify
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go test -race ./internal/fdrivelease && go test -race ./internal/vfs ./internal/config -run TestFdrive -count=1

FROM verify AS build
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags '-s -w -X github.com/drakkan/sftpgo/v2/internal/version.commit=fdrive-local-v1-9888a3d1' -o /sftpgo .
RUN tar --exclude=.git -czf /fdrive-sftpgo-source.tar.gz .

FROM drakkan/sftpgo:v2.7.5@sha256:9011fe608d336d3daf6ed6224b16fd40443aab8f3335e0b20853d6a539c58738
COPY --from=build /sftpgo /usr/local/bin/sftpgo
COPY --from=build /fdrive-sftpgo-source.tar.gz /usr/share/sftpgo/fdrive-source.tar.gz
LABEL org.opencontainers.image.source="https://github.com/fredrikburmester/fdrive-web" \
      org.opencontainers.image.description="Optional fdrive local filesystem write enforcement for SFTPGo"
