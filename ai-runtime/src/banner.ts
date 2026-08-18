export const NEXUS_AI_RUNTIME_BANNER = `
███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝

        █████╗ ██╗    ██████╗ ██╗   ██╗███╗   ██╗████████╗██╗███╗   ███╗███████╗
       ██╔══██╗██║    ██╔══██╗██║   ██║████╗  ██║╚══██╔══╝██║████╗ ████║██╔════╝
       ███████║██║    ██████╔╝██║   ██║██╔██╗ ██║   ██║   ██║██╔████╔██║█████╗
       ██╔══██║██║    ██╔══██╗██║   ██║██║╚██╗██║   ██║   ██║██║╚██╔╝██║██╔══╝
       ██║  ██║██║    ██║  ██║╚██████╔╝██║ ╚████║   ██║   ██║██║ ╚═╝ ██║███████╗
       ╚═╝  ╚═╝╚═╝    ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝     ╚═╝╚══════╝
`;

export interface StartupBannerOptions {
  color?: boolean;
}

const CYAN = "\u001b[36m";
const BLUE = "\u001b[34m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

export function colorizeBanner(text: string): string {
  const [firstBlock, ...rest] = text.split("\n\n");
  const secondBlock = rest.join("\n\n");

  return `${BOLD}${CYAN}${firstBlock}${RESET}\n\n${BOLD}${BLUE}${secondBlock}${RESET}`;
}

export function printStartupBanner(
  write: (text: string) => void = console.log,
  options: StartupBannerOptions = {},
): void {
  write(options.color ? colorizeBanner(NEXUS_AI_RUNTIME_BANNER) : NEXUS_AI_RUNTIME_BANNER);
}
