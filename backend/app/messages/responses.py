from __future__ import annotations

from datetime import UTC, datetime

from app.messages.models import Message, MessageEnvelope
from app.messages.schemas import (
    EnvelopeResponse,
    MailboxEnvelopeResponse,
    MailboxPageResponse,
    MessageResponse,
    SentMessagesPageResponse,
)

from app.messages.types import MailboxPage, SentMessagesPage, StoredMessage


def utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def envelope_response(
    envelope: MessageEnvelope, *, include_payload: bool = True
) -> EnvelopeResponse:
    return EnvelopeResponse(
        id=envelope.id,
        message_id=envelope.message_id,
        recipient_device_id=envelope.recipient_device_id,
        recipient_user_id=envelope.recipient_user_id,
        mailbox_seq=envelope.mailbox_seq,
        protocol_version=envelope.protocol_version,
        envelope_type=envelope.envelope_type,
        payload=envelope.payload if include_payload else None,
        created_at=utc(envelope.created_at),
        expires_at=utc(envelope.expires_at),
        delivered_at=(utc(envelope.delivered_at) if envelope.delivered_at else None),
        payload_purged_at=(
            utc(envelope.payload_purged_at) if envelope.payload_purged_at else None
        ),
    )


def message_response(
    stored: StoredMessage, *, include_payload: bool = True
) -> MessageResponse:
    message = stored.message
    return MessageResponse(
        id=message.id,
        chat_id=message.chat_id,
        chat_seq=message.chat_seq,
        sender_user_id=message.sender_user_id,
        sender_device_id=message.sender_device_id,
        client_message_id=message.client_message_id,
        created_at=utc(message.created_at),
        envelopes=[
            envelope_response(item, include_payload=include_payload)
            for item in stored.envelopes
        ],
    )


def sent_message_response(stored: StoredMessage) -> MessageResponse:
    """Map metadata without reading the deferred envelope payload."""
    return message_response(stored, include_payload=False)


def sent_messages_response(page: SentMessagesPage) -> SentMessagesPageResponse:
    return SentMessagesPageResponse(
        messages=[sent_message_response(message) for message in page.messages],
        next_message_id=page.next_message_id,
        has_more=page.has_more,
    )


def mailbox_response(page: MailboxPage) -> MailboxPageResponse:
    return MailboxPageResponse(
        envelopes=[
            mailbox_envelope_response(entry.envelope, entry.message)
            for entry in page.entries
        ],
        next_seq=page.next_seq,
        has_more=page.has_more,
    )


def mailbox_envelope_response(
    envelope: MessageEnvelope, message: Message
) -> MailboxEnvelopeResponse:
    return MailboxEnvelopeResponse(
        **envelope_response(envelope).model_dump(),
        chat_id=message.chat_id,
        chat_seq=message.chat_seq,
        sender_user_id=message.sender_user_id,
        sender_device_id=message.sender_device_id,
        client_message_id=message.client_message_id,
        message_created_at=utc(message.created_at),
    )
