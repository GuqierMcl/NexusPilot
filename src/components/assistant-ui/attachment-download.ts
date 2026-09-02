import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

import { appendAiRuntimeAuthorization } from "@/lib/ai-runtime/endpoint";

interface SaveRuntimeAttachmentOptions {
  attachmentId: string;
  baseUrl: string;
  accessToken: string | null;
  name: string;
  selectDestination?: (options: {
    title: string;
    defaultPath: string;
  }) => Promise<string | null>;
  request?: typeof fetch;
  persist?: (path: string, contents: Uint8Array) => Promise<void>;
}

export async function saveRuntimeAttachment({
  attachmentId,
  baseUrl,
  accessToken,
  name,
  selectDestination = save,
  request = fetch,
  persist = writeFile,
}: SaveRuntimeAttachmentOptions): Promise<"saved" | "cancelled"> {
  const destinationPath = await selectDestination({
    title: "保存附件",
    defaultPath: name,
  });
  if (!destinationPath) return "cancelled";

  const response = await request(
    `${baseUrl.replace(/\/+$/, "")}/v1/attachments/${encodeURIComponent(attachmentId)}/content`,
    { headers: appendAiRuntimeAuthorization(undefined, accessToken) },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  await persist(destinationPath, new Uint8Array(await response.arrayBuffer()));
  return "saved";
}
