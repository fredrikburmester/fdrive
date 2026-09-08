import { dirname, resolve } from "node:path";
export type OfficeProduct = "onlyoffice" | "collabora";
export function parseProduct(value: string | undefined): OfficeProduct {
  if (value === undefined || value === "onlyoffice") return "onlyoffice";
  if (value === "collabora") return value;
  throw new Error("OFFICE_E2E_PRODUCT must be onlyoffice or collabora");
}
export function fixtureCompose(
  sharedServicesPath: string,
  product: OfficeProduct,
  officePort: number,
  apiPort: number,
  webPort: number,
  workerToken: string,
) {
  const common = {
    extends: { file: sharedServicesPath, service: product },
    restart: "no",
    extra_hosts: ["host.docker.internal:host-gateway"],
  };
  const onlyoffice = {
    init: true,
    build: {
      context: resolve(dirname(sharedServicesPath), "../.."),
      dockerfile: "deploy/office/Dockerfile.onlyoffice",
    },
    restart: "no",
    stop_grace_period: "65s",
    extra_hosts: ["host.docker.internal:host-gateway"],
    volumes: ["office_onlyoffice_data:/var/www/onlyoffice/Data"],
    healthcheck: {
      test: ["CMD", "curl", "-fs", "http://127.0.0.1:8099/health"],
      interval: "3s",
      timeout: "2s",
      retries: 30,
    },
    environment: {
      WOPI_ENABLED: "true",
      JWT_ENABLED: "true",
      ALLOW_PRIVATE_IP_ADDRESS: "true",
      ALLOW_META_IP_ADDRESS: "false",
      FDRIVE_WORKER_TOKEN: workerToken,
      FDRIVE_OFFICE_SETTINGS_URL: `http://host.docker.internal:${apiPort}/api/v1/internal/office`,
      NODE_CONFIG:
        '{"wopi":{"wopiZone":"external-http"},"services":{"CoAuthoring":{"request-filtering-agent":{"allowMetaIPAddress":false}}}}',
    },
    ports: [`127.0.0.1:${officePort}:80`],
  };
  const collabora = {
    ...common,
    depends_on: { "collabora-keys": { condition: "service_completed_successfully" } },
    ports: [`127.0.0.1:${officePort}:9980`],
    command: [
      "--o:ssl.enable=false",
      "--o:ssl.termination=false",
      "--o:mount_jail_tree=false",
      "--o:storage.wopi.alias_groups[@mode]=groups",
      `--o:storage.wopi.alias_groups.group[0].host=http://host.docker.internal:${apiPort}`,
      "--o:storage.wopi.alias_groups.group[0].host[@allow]=true",
      "--o:storage.wopi.max_file_size=104857600",
      `--o:net.content_security_policy=frame-ancestors http://127.0.0.1:${webPort};`,
      `--o:server_name=127.0.0.1:${officePort}`,
      "--o:logging.level=warning",
    ],
  };
  return {
    services:
      product === "onlyoffice"
        ? { onlyoffice }
        : {
            "collabora-keys": { extends: { file: sharedServicesPath, service: "collabora-keys" } },
            collabora,
          },
    volumes: { office_onlyoffice_data: {}, office_collabora_keys: {} },
  };
}

export function parsePort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    [3001, 3002, 58090, 58091].includes(port)
  ) {
    throw new Error("Office fixture requires a valid port distinct from the development servers");
  }
  return port;
}
