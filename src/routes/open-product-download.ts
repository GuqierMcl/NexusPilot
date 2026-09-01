export const PRODUCT_DOWNLOAD_URL = "https://nexuspilot.dev/#download";

interface OpenProductDownloadDependencies {
    openUrl: (url: string) => Promise<void>;
    reportError: (message: string) => void;
}

export async function openProductDownload({
    openUrl,
    reportError,
}: OpenProductDownloadDependencies): Promise<boolean> {
    try {
        await openUrl(PRODUCT_DOWNLOAD_URL);
        return true;
    } catch {
        reportError("无法打开 NexusPilot 官网，请稍后重试。");
        return false;
    }
}
