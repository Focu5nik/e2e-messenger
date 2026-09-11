import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from fastapi import WebSocket


CLOSE_TIMEOUT_SECONDS = 1


@dataclass(eq=False)
class Connection:
    websocket: WebSocket
    authorize: Callable[[], Awaitable[None]]
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, event: dict) -> None:
        async with self.lock:
            await self.websocket.send_json(event)

    async def close(self, code: int) -> None:
        # A stalled send holding the lock cannot block replacement or cleanup.
        async with asyncio.timeout(CLOSE_TIMEOUT_SECONDS):
            async with self.lock:
                await self.websocket.close(code=code)


class ConnectionRegistry:
    def __init__(self) -> None:
        self._connections: dict[uuid.UUID, Connection] = {}

    async def register(self, device_id: uuid.UUID, connection: Connection) -> None:
        previous = self._connections.get(device_id)
        self._connections[device_id] = connection
        if previous is not None:
            try:
                await previous.close(4001)
            except Exception:
                pass

    def is_current(self, device_id: uuid.UUID, connection: Connection) -> bool:
        return self._connections.get(device_id) is connection

    def unregister(self, device_id: uuid.UUID, connection: Connection) -> None:
        if self.is_current(device_id, connection):
            del self._connections[device_id]

    async def deliver(self, device_id: uuid.UUID, event: dict) -> None:
        connection = self._connections.get(device_id)
        if connection is None:
            return
        try:
            # Recheck revocation and expiry before releasing a private envelope.
            await connection.authorize()
            if self.is_current(device_id, connection):
                await connection.send(event)
        except Exception:
            self.unregister(device_id, connection)
            try:
                await connection.close(4401)
            except Exception:
                pass


class EventBus(Protocol):
    async def publish(self, device_id: uuid.UUID, event: dict) -> None: ...


class InMemoryEventBus:
    def __init__(self, registry: ConnectionRegistry) -> None:
        self.registry = registry

    async def publish(self, device_id: uuid.UUID, event: dict) -> None:
        await self.registry.deliver(device_id, event)
