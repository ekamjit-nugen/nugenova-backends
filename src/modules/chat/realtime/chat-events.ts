/**
 * In-process event names for the chat realtime layer. MessagesService emits
 * these via EventEmitter2 after a successful write; ChatGateway listens
 * (@OnEvent) and fans the corresponding socket event out to the conversation
 * room. Going through the event bus keeps MessagesService free of any socket /
 * gateway dependency (no circular import).
 */
export const CHAT_MESSAGE_NEW = 'chat.message.new';
export const CHAT_MESSAGE_UPDATED = 'chat.message.updated';
export const CHAT_MESSAGE_DELETED = 'chat.message.deleted';

/** Payload for CHAT_MESSAGE_NEW / CHAT_MESSAGE_UPDATED. */
export interface ChatMessageEvent {
  conversationId: string;
  message: Record<string, unknown>;
}

/** Payload for CHAT_MESSAGE_DELETED. */
export interface ChatMessageDeletedEvent {
  conversationId: string;
  messageId: string;
}
