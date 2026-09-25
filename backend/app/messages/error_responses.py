from dataclasses import dataclass

from app.chats.errors import ChatNotFoundError
from app.messages.errors import (
    DeliveryTargetsChangedError,
    DuplicateDestinationError,
    EnvelopeNotFoundError,
    InvalidEnvelopeError,
)


@dataclass(frozen=True)
class MessageErrorDescription:
    code: str
    message: str
    status: int


def describe_message_error(
    error: ChatNotFoundError | DeliveryTargetsChangedError | DuplicateDestinationError
    | EnvelopeNotFoundError | InvalidEnvelopeError,
) -> MessageErrorDescription:
    if isinstance(error, ChatNotFoundError):
        return MessageErrorDescription("message_rejected", "chat not found", 404)
    if isinstance(error, EnvelopeNotFoundError):
        return MessageErrorDescription("envelope_not_found", "envelope not found", 404)
    if isinstance(error, DuplicateDestinationError):
        return MessageErrorDescription("message_rejected", "duplicate recipient device", 422)
    if isinstance(error, InvalidEnvelopeError):
        return MessageErrorDescription("message_rejected", str(error), 422)
    if isinstance(error, DeliveryTargetsChangedError):
        return MessageErrorDescription(
            "delivery_targets_changed",
            "Destination devices changed; refresh and retry.",
            409,
        )
    raise TypeError(f"Unsupported message error: {type(error).__name__}")
