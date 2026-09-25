import asyncio
import uuid

from app.messages.models import MessageEnvelope
from app.messages.responses import envelope_response, mailbox_envelope_response
from app.messages.types import StoredMessage
from app.realtime.events import EventBus
from app.realtime.notifications import publish_event


async def publish_delivery(
    event_bus: EventBus | None,
    sender_device_id: uuid.UUID,
    envelope: MessageEnvelope,
) -> None:
    if event_bus is None:
        return
    await publish_event(
        event_bus,
        sender_device_id,
        lambda: {
            "type": "message.delivered",
            "data": envelope_response(envelope).model_dump(mode="json"),
        },
    )


async def publish_message(event_bus: EventBus | None, stored: StoredMessage) -> None:
    if event_bus is None:
        return

    async def publish(envelope: MessageEnvelope) -> None:
        await publish_event(
            event_bus,
            envelope.recipient_device_id,
            lambda: {
                "type": "message.new",
                "data": mailbox_envelope_response(
                    envelope, stored.message
                ).model_dump(mode="json"),
            },
        )

    # One slow recipient must not delay delivery to other devices.
    await asyncio.gather(*(publish(envelope) for envelope in stored.envelopes))
