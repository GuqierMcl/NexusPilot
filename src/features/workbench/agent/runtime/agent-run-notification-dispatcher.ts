import {
    getRuntimeConversation,
    getRuntimeConversationMessages,
} from "@/lib/ai-runtime/conversations";
import {
    canSendBackgroundNativeNotification,
    sendBackgroundNativeNotification,
} from "@/lib/tauri/native-notifications";

import {
    createAgentRunNotificationContent,
    type AgentRunNotificationCandidate,
    type AgentRunNotificationPreferences,
} from "./agent-run-notification";

export async function dispatchAgentRunNotification(input: {
    candidate: AgentRunNotificationCandidate;
    preferences: AgentRunNotificationPreferences;
}): Promise<boolean> {
    if (
        !input.preferences.systemNotificationsEnabled ||
        !input.preferences.backgroundNotifications ||
        (input.candidate.kind === "failed" && !input.preferences.notifyOnFailure)
    ) {
        return false;
    }

    if (!(await canSendBackgroundNativeNotification())) {
        return false;
    }

    const [conversation, messages] = await Promise.all([
        getRuntimeConversation(input.candidate.conversationId, undefined, {
            silent: true,
        }),
        getRuntimeConversationMessages(
            "ai_sdk",
            input.candidate.conversationId,
            undefined,
            { silent: true },
        ),
    ]);
    const notification = createAgentRunNotificationContent({
        candidate: input.candidate,
        conversationTitle: conversation.title,
        messages,
        showReplyPreview: input.preferences.showReplyPreview,
    });

    return await sendBackgroundNativeNotification(notification);
}
