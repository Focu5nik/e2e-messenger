import asyncio
import json
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.requests import HTTPConnection

from app.auth.dependencies import authenticate_access_token
from app.config import get_settings
from app.database import get_session
from app.messages.dependencies import Service
from app.messages.responses import message_response
from app.messages.schemas import SendMessageRequest
from app.messages.service import (
    ChatNotFoundError,
    DeliveryTargetsChangedError,
    DuplicateDestinationError,
    InvalidEnvelopeError,
)
from app.realtime.events import Connection, ConnectionRegistry


router = APIRouter()
AUTH_TIMEOUT_SECONDS = 10
AUTH_CHECK_INTERVAL_SECONDS = 30


class AuthEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["auth"]
    access_token: str = Field(min_length=1, max_length=8192)


class SendEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["message.send"]
    request_id: str = Field(min_length=1, max_length=128)
    data: SendMessageRequest


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


def error_event(code: str, message: str, status: int, request_id=None) -> dict:
    event = {"type": "error", "error": {"code": code, "message": message, "status": status}}
    if isinstance(request_id, str) and 0 < len(request_id) <= 128:
        event["request_id"] = request_id
    return event


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    service: Service,
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
                if event.get("type") != "message.send":
                    response = error_event(
                        "unsupported_event", "Event is not supported in this version.",
                        400, event.get("request_id"),
                    )
                else:
                    try:
                        command = SendEvent.model_validate(event)
                        stored = await service.send(session, current, command.data)
                        accepted = message_response(stored)
                        response = {
                            "type": "message.accepted", "request_id": command.request_id,
                            "data": accepted.model_dump(mode="json"),
                        }
                    except ValidationError:
                        response = error_event(
                            "invalid_event", "Invalid message.send data.", 422,
                            event.get("request_id"),
                        )
                    except ChatNotFoundError:
                        response = error_event(
                            "message_rejected", "chat not found",
                            status.HTTP_404_NOT_FOUND, event.get("request_id"),
                        )
                    except DuplicateDestinationError:
                        response = error_event(
                            "message_rejected", "duplicate recipient device",
                            status.HTTP_422_UNPROCESSABLE_CONTENT,
                            event.get("request_id"),
                        )
                    except InvalidEnvelopeError as exc:
                        response = error_event(
                            "message_rejected", str(exc),
                            status.HTTP_422_UNPROCESSABLE_CONTENT,
                            event.get("request_id"),
                        )
                    except DeliveryTargetsChangedError:
                        response = error_event(
                            "delivery_targets_changed",
                            "Destination devices changed; refresh and retry.",
                            status.HTTP_409_CONFLICT, event.get("request_id"),
                        )
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
