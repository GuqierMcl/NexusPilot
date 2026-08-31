export const DOCUMENTATION_URL = "https://docs.nexuspilot.dev";

interface OpenDocumentationDependencies {
    openUrl: (url: string) => Promise<void>;
    reportError: (message: string) => void;
}

export async function openDocumentation({
    openUrl,
    reportError,
}: OpenDocumentationDependencies): Promise<boolean> {
    try {
        await openUrl(DOCUMENTATION_URL);
        return true;
    } catch {
        reportError("无法打开在线文档，请稍后重试。");
        return false;
    }
}
