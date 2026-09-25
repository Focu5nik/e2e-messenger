import asyncio
import uuid
from collections.abc import Callable

from app.realtime.events import EventBus


async def publish_event(
    event_bus: EventBus,
    device_id: uuid.UUID,
    make_event: Callable[[], dict],
) -> None:
    # Committed state is authoritative; clients recover via HTTP or mailbox sync.
    try:
        await asyncio.wait_for(event_bus.publish(device_id, make_event()), timeout=5)
    except Exception:
        pass
