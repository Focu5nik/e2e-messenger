import asyncio
import uuid

from app.chats.responses import read_state_response
from app.chats.types import ReadState
from app.realtime.events import EventBus
from app.realtime.notifications import publish_event


async def publish_chat_read(
    event_bus: EventBus | None, device_ids: list[uuid.UUID], state: ReadState,
) -> None:
    if event_bus is None:
        return
    await asyncio.gather(*(
        publish_event(event_bus, device_id, lambda: {
            "type": "chat.read.updated",
            "data": read_state_response(state).model_dump(mode="json"),
        })
        for device_id in device_ids
    ))
