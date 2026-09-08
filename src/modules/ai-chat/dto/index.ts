import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body of `POST /ai/chat/conversations`. */
export class CreateConversationDto {
  /** Optional initial title. Auto-derived from the first message when omitted. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}

/** Body of `POST /ai/chat/conversations/:id/messages`. */
export class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  content: string;
}
