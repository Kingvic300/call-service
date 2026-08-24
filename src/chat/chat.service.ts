import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { Meeting } from '../meeting/entities/meeting.entity';

export interface ChatMessage {
  id: string;
  meetingId: string;
  senderId: string;
  senderName: string;
  /** Reserved for future non-text payloads (spec: "future-ready for images/files/emojis"). */
  type: 'text';
  text: string;
  sentAt: string;
}

/**
 * Room chat with a bounded in-memory history ring buffer per meeting.
 * `type` is deliberately a discriminated field so image/file/emoji message
 * kinds can be added later without changing the wire shape clients already
 * depend on (spec: "future-ready architecture").
 */
@Injectable()
export class ChatService {
  private readonly historyLimit: number;
  private readonly history = new Map<string, ChatMessage[]>();

  constructor(config: ConfigService) {
    this.historyLimit = config.get<number>('CHAT_HISTORY_LIMIT', 200);
  }

  addMessage(
    meeting: Meeting,
    senderId: string,
    senderName: string,
    text: string,
  ): ChatMessage {
    if (!meeting.chatEnabled) {
      throw new ForbiddenException('Chat is disabled in this meeting');
    }
    const trimmed = text.trim();
    if (!trimmed) throw new ForbiddenException('Empty message');

    const message: ChatMessage = {
      id: uuidv4(),
      meetingId: meeting.id,
      senderId,
      senderName,
      type: 'text',
      text: trimmed.slice(0, 4000),
      sentAt: new Date().toISOString(),
    };

    const buffer = this.history.get(meeting.id) ?? [];
    buffer.push(message);
    if (buffer.length > this.historyLimit) buffer.shift();
    this.history.set(meeting.id, buffer);

    return message;
  }

  getHistory(meetingId: string): ChatMessage[] {
    return this.history.get(meetingId) ?? [];
  }

  clearHistory(meetingId: string): void {
    this.history.delete(meetingId);
  }
}
