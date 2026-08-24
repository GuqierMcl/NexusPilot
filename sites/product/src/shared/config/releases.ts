export interface ReleaseRegistryConfig {
  publicBaseUrl: string;
  indexUrl: string;
}

const releasePublicBaseUrl = "https://dl.nexuspilot.dev/releases";

export const releaseRegistry: ReleaseRegistryConfig = {
  publicBaseUrl: releasePublicBaseUrl,
  indexUrl: `${releasePublicBaseUrl}/index.json`,
};
