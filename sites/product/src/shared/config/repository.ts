export interface RepositoryBadge {
  alt: string;
  ariaLabel: string;
  href: string;
  src: string;
}

const SHIELDS_BASE_URL = "https://img.shields.io";
const REPOSITORY_SLUG = "GuqierMcl/NexusPilot";

function createGitHubBadge(
  path: string,
  options: Record<string, string>,
  link: Pick<RepositoryBadge, "alt" | "ariaLabel" | "href">,
): RepositoryBadge {
  const params = new URLSearchParams({
    style: "flat",
    labelColor: "18181b",
    ...options,
  });

  return {
    ...link,
    src: `${SHIELDS_BASE_URL}/${path}?${params.toString()}`,
  };
}

export const repository = {
  owner: "GuqierMcl",
  name: "NexusPilot",
  slug: REPOSITORY_SLUG,
  url: `https://github.com/${REPOSITORY_SLUG}`,
  issuesUrl: `https://github.com/${REPOSITORY_SLUG}/issues`,
  contributingUrl: `https://github.com/${REPOSITORY_SLUG}/blob/main/CONTRIBUTING.md`,
  securityUrl: `https://github.com/${REPOSITORY_SLUG}/security/policy`,
  licenseUrl: `https://github.com/${REPOSITORY_SLUG}/blob/main/LICENSE`,
  license: "Apache-2.0",
} as const;

export const repositoryBadges = {
  stars: createGitHubBadge(
    `github/stars/${REPOSITORY_SLUG}`,
    {
      logo: "github",
      label: "Stars",
      color: "6366f1",
    },
    {
      alt: "NexusPilot GitHub Stars",
      ariaLabel: "在 GitHub 查看 NexusPilot 仓库及 Star 数量",
      href: repository.url,
    },
  ),
  forks: createGitHubBadge(
    `github/forks/${REPOSITORY_SLUG}`,
    {
      logo: "github",
      label: "Forks",
      color: "6366f1",
    },
    {
      alt: "NexusPilot GitHub Forks",
      ariaLabel: "查看 NexusPilot GitHub Fork 数量",
      href: `${repository.url}/forks`,
    },
  ),
  license: createGitHubBadge(
    `github/license/${REPOSITORY_SLUG}`,
    {
      label: "License",
      color: "22c55e",
    },
    {
      alt: "NexusPilot License",
      ariaLabel: "查看 NexusPilot Apache-2.0 开源许可证",
      href: repository.licenseUrl,
    },
  ),
  lastCommit: createGitHubBadge(
    `github/last-commit/${REPOSITORY_SLUG}`,
    {
      label: "Last commit",
      color: "0ea5e9",
    },
    {
      alt: "NexusPilot Last Commit",
      ariaLabel: "查看 NexusPilot 最近一次提交",
      href: `${repository.url}/commits/main`,
    },
  ),
} as const satisfies Record<string, RepositoryBadge>;

