from dataclasses import dataclass
import uuid

from app.messages.models import Message, MessageEnvelope


@dataclass(frozen=True, slots=True)
class StoredMessage:
    message: Message
    envelopes: list[MessageEnvelope]


@dataclass(frozen=True, slots=True)
class SentMessagesPage:
    messages: list[StoredMessage]
    next_message_id: uuid.UUID | None
    has_more: bool


@dataclass(frozen=True, slots=True)
class MailboxEntry:
    envelope: MessageEnvelope
    message: Message


@dataclass(frozen=True, slots=True)
class MailboxPage:
    entries: list[MailboxEntry]
    next_seq: int
    has_more: bool
