import { GenericContainer, Wait } from "testcontainers";

/** Disposable Apache mod_dav server: exercises collection redirects that SFTPGo tolerates. */
export async function startApacheWebdav() {
  const credential = { username: "alice", password: "fdrive-test-password" };
  const config = `
DavLockDB /tmp/DavLock
<Directory /usr/local/apache2/htdocs/dav>
  Dav On
  Options Indexes
  AuthType Basic
  AuthName "fdrive integration"
  AuthUserFile /tmp/dav-passwords
  Require valid-user
</Directory>
`;
  const container = await new GenericContainer("httpd:2.4")
    .withCopyContentToContainer([{ content: config, target: "/tmp/dav.conf" }])
    .withCommand([
      "sh",
      "-c",
      [
        "sed -i 's/^#LoadModule dav_module/LoadModule dav_module/;s/^#LoadModule dav_fs_module/LoadModule dav_fs_module/' conf/httpd.conf",
        "cat /tmp/dav.conf >> conf/httpd.conf",
        "mkdir -p htdocs/dav",
        "chown www-data:www-data htdocs/dav",
        `htpasswd -bc /tmp/dav-passwords ${credential.username} ${credential.password}`,
        "exec httpd-foreground",
      ].join(" && "),
    ])
    .withExposedPorts(80)
    .withWaitStrategy(Wait.forHttp("/", 80))
    .start();
  return {
    baseUrl: `http://${container.getHost()}:${container.getMappedPort(80)}/dav/`,
    credential,
    stop: async () => {
      await container.stop();
    },
  };
}
