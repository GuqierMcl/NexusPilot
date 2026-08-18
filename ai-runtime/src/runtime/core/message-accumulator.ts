import type { ConversationId, MessageId, PartId, TextPart } from "./types";

export interface TextPartSnapshotInput {
  id: PartId;
  conversationId: ConversationId;
  messageId: MessageId;
  created: number;
  completed: number;
}

export class MessageAccumulator {
  private textBuffer = "";

  get text(): string {
    return this.textBuffer;
  }

  get textLength(): number {
    return this.textBuffer.length;
  }

  appendText(delta: string): void {
    if (delta.length === 0) {
      return;
    }

    this.textBuffer += delta;
  }

  clear(): void {
    this.textBuffer = "";
  }

  toTextPart(input: TextPartSnapshotInput): TextPart {
    return {
      id: input.id,
      conversationId: input.conversationId,
      messageId: input.messageId,
      type: "text",
      text: this.textBuffer,
      time: {
        start: input.created,
        end: input.completed,
      },
    };
  }
}
