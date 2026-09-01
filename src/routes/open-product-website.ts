export const PRODUCT_WEBSITE_URL = "https://nexuspilot.dev/";

interface OpenProductWebsiteDependencies {
    openUrl: (url: string) => Promise<void>;
    reportError: (message: string) => void;
}

export async function openProductWebsite({
    openUrl,
    reportError,
}: OpenProductWebsiteDependencies): Promise<boolean> {
    try {
        await openUrl(PRODUCT_WEBSITE_URL);
        return true;
    } catch {
        reportError("无法打开 NexusPilot 官网，请稍后重试。");
        return false;
    }
}
