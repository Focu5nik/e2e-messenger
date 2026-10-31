import asyncio
import json
import logging
import uuid
from contextlib import suppress

from redis.asyncio import Redis
from redis.asyncio.client import PubSub
from redis.exceptions import RedisError

from app.realtime.events import ConnectionRegistry


logger = logging.getLogger(__name__)
RECONNECT_DELAY_SECONDS = 1
DELIVERY_TIMEOUT_SECONDS = 5
MAX_PENDING_DELIVERIES = 256


class RedisEventBus:
    """One transient Pub/Sub subscription per application, shared by all devices."""

    def __init__(
        self, registry: ConnectionRegistry, redis: Redis, channel: str,
    ) -> None:
        self.registry = registry
        self.redis = redis
        self.channel = channel
        self._pubsub: PubSub | None = None
        self._listener: asyncio.Task | None = None
        self._deliveries: set[asyncio.Task] = set()

    async def _subscribe(self) -> None:
        self._pubsub = self.redis.pubsub()
        await self._pubsub.subscribe(self.channel)
        # Wait for Redis to confirm subscription before accepting requests.
        async with asyncio.timeout(5):
            while True:
                message = await self._pubsub.get_message(timeout=1)
                if message is not None and message["type"] == "subscribe":
                    return

    async def start(self) -> None:
        if self._listener is not None:
            return
        await self._subscribe()
        self._listener = asyncio.create_task(self._listen(), name="redis-event-listener")

    async def stop(self) -> None:
        if self._listener is not None:
            self._listener.cancel()
            with suppress(asyncio.CancelledError):
                await self._listener
            self._listener = None
        pending = list(self._deliveries)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if self._pubsub is not None:
            await self._pubsub.aclose()
            self._pubsub = None
        await self.redis.aclose()

    async def publish(self, device_id: uuid.UUID, event: dict) -> None:
        # Local recipients also receive via Redis, so each publication has one path.
        await self.redis.publish(self.channel, json.dumps({
            "device_id": str(device_id), "event": event,
        }))

    async def _listen(self) -> None:
        while True:
            try:
                if self._pubsub is None:
                    await self._subscribe()
                message = await self._pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1,
                )
                if message is not None and message["type"] == "message":
                    self._dispatch(message["data"])
            except (RedisError, OSError, TimeoutError):
                # Never log event contents, credentials, or exception text.
                logger.warning("Redis event listener disconnected; retrying")
                if self._pubsub is not None:
                    await self._pubsub.aclose()
                    self._pubsub = None
                await asyncio.sleep(RECONNECT_DELAY_SECONDS)

    def _dispatch(self, raw: bytes) -> None:
        try:
            body = json.loads(raw)
            device_id = uuid.UUID(body["device_id"])
            event = body["event"]
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                return
        except (ValueError, TypeError, KeyError, AttributeError):
            return
        if not self.registry.is_connected(device_id):
            return
        # A slow socket cannot block the shared listener or grow memory forever.
        # Dropped real-time events remain recoverable through PostgreSQL sync.
        if len(self._deliveries) >= MAX_PENDING_DELIVERIES:
            return
        task = asyncio.create_task(self._deliver(device_id, event))
        self._deliveries.add(task)
        task.add_done_callback(self._deliveries.discard)

    async def _deliver(self, device_id: uuid.UUID, event: dict) -> None:
        try:
            async with asyncio.timeout(DELIVERY_TIMEOUT_SECONDS):
                await self.registry.deliver(device_id, event)
        except TimeoutError:
            pass
