import asyncio
import json
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import ValidationError
from starlette.requests import HTTPConnection

from app.auth.dependencies import authenticate_access_token
from app.chats.dependencies import ReadService
from app.config import get_settings
from app.database import get_session
from app.messages.dependencies import Service
from app.realtime.events import Connection, ConnectionRegistry
from app.realtime.handlers import error_event, handle_command
from app.realtime.schemas import AuthEvent


router = APIRouter()
AUTH_TIMEOUT_SECONDS = 10
AUTH_CHECK_INTERVAL_SECONDS = 30


def session_provider(connection: HTTPConnection):
    # Resolve the same session dependency used by HTTP, but open/close it per
    # operation. No transaction or pooled connection lives as long as a socket.
    provider = connection.app.dependency_overrides.get(get_session, get_session)
    return asynccontextmanager(provider)


async def receive_event(websocket: WebSocket) -> dict:
    frame = await websocket.receive()
    if frame["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(frame.get("code", 1000))
    raw = frame.get("text")
    if raw is None:
        raise ValueError("invalid frame")
    event = json.loads(raw)
    if not isinstance(event, dict):
        raise ValueError("invalid event")
    return event


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    service: Service,
    read_service: ReadService,
    sessions: Annotated[object, Depends(session_provider)],
) -> None:
    if websocket.headers.get("origin") != str(get_settings().frontend_origin).rstrip("/"):
        await websocket.close(code=4403)
        return
    await websocket.accept()
    connection = None
    principal = None
    registry: ConnectionRegistry = websocket.app.state.connection_registry
    try:
        try:
            event = await asyncio.wait_for(receive_event(websocket), AUTH_TIMEOUT_SECONDS)
            auth = AuthEvent.model_validate(event)
            async with sessions() as session:
                principal = await authenticate_access_token(auth.access_token, session)
        except (ValueError, ValidationError, HTTPException, TimeoutError):
            await websocket.close(code=4401)
            return

        async def authorize() -> None:
            async with sessions() as session:
                await authenticate_access_token(auth.access_token, session)

        connection = Connection(websocket, authorize)
        await registry.register(principal.device_id, connection)
        await connection.send({"type": "auth.ok"})
        while registry.is_current(principal.device_id, connection):
            event = {}
            try:
                event = await asyncio.wait_for(
                    receive_event(websocket), AUTH_CHECK_INTERVAL_SECONDS
                )
            except TimeoutError:
                await authorize()
                continue
            except (ValueError, ValidationError):
                await authorize()
                await connection.send(error_event("invalid_event", "Invalid event.", 422))
                continue

            if not registry.is_current(principal.device_id, connection):
                break
            # Both unsupported and malformed authenticated frames still require
            # a current session; they cannot keep a revoked connection alive.
            async with sessions() as session:
                current = await authenticate_access_token(auth.access_token, session)
                response = await handle_command(event, session, current, service, read_service)
            await connection.send(response)
    except HTTPException:
        if connection is not None:
            try:
                await connection.close(4401)
            except (OSError, RuntimeError, TimeoutError):
                pass
    except (WebSocketDisconnect, OSError, RuntimeError):
        pass
    finally:
        if principal is not None and connection is not None:
            registry.unregister(principal.device_id, connection)
