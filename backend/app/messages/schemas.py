import base64
import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field, field_serializer


PROTOCOL_VERSION_PLAINTEXT = 0
PLAINTEXT_ENVELOPE_TYPE = "PLAINTEXT"
MAX_ENVELOPE_PAYLOAD_BYTES = 64 * 1024


class ClientEnvelopeRequest(BaseModel):
    recipient_device_id: uuid.UUID
    protocol_version: int
    envelope_type: str
    payload: str


class SendMessageRequest(BaseModel):
    chat_id: uuid.UUID
    client_message_id: uuid.UUID
    envelopes: Annotated[list[ClientEnvelopeRequest], Field(min_length=1)]


class DestinationDeviceResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    protocol_version: int


class EnvelopeResponse(BaseModel):
    id: uuid.UUID
    message_id: uuid.UUID
    recipient_device_id: uuid.UUID
    recipient_user_id: uuid.UUID
    mailbox_seq: int
    protocol_version: int
    envelope_type: str
    payload: bytes | None
    created_at: datetime
    expires_at: datetime
    delivered_at: datetime | None
    payload_purged_at: datetime | None

    @field_serializer("payload", when_used="json")
    def encode_payload(self, value: bytes | None) -> str | None:
        if value is None:
            return None
        return base64.b64encode(value).decode("ascii")


class MessageResponse(BaseModel):
    id: uuid.UUID
    chat_id: uuid.UUID
    chat_seq: int
    sender_user_id: uuid.UUID
    sender_device_id: uuid.UUID
    client_message_id: uuid.UUID
    created_at: datetime
    envelopes: list[EnvelopeResponse]


class MailboxEnvelopeResponse(EnvelopeResponse):
    chat_id: uuid.UUID
    chat_seq: int
    sender_user_id: uuid.UUID
    sender_device_id: uuid.UUID
    client_message_id: uuid.UUID
    message_created_at: datetime


class MailboxPageResponse(BaseModel):
    envelopes: list[MailboxEnvelopeResponse]
    next_seq: int
    has_more: bool


class SentMessagesPageResponse(BaseModel):
    messages: list[MessageResponse]
    next_message_id: uuid.UUID | None
    has_more: bool
