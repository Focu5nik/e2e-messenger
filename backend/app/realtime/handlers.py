from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.principal import Principal
from app.messages.error_responses import MessageErrorDescription, describe_message_error
from app.messages.responses import envelope_response, mailbox_response, message_response
from app.messages.service import (
    ChatNotFoundError,
    DeliveryTargetsChangedError,
    DuplicateDestinationError,
    EnvelopeNotFoundError,
    InvalidEnvelopeError,
    MessageService,
)
from app.realtime.schemas import DeliveryEvent, SendEvent, SyncEvent


def error_event(code: str, message: str, status: int, request_id=None) -> dict:
    event = {"type": "error", "error": {"code": code, "message": message, "status": status}}
    if isinstance(request_id, str) and 0 < len(request_id) <= 128:
        event["request_id"] = request_id
    return event


def message_error_event(description: MessageErrorDescription, request_id=None) -> dict:
    return error_event(
        description.code, description.message, description.status, request_id
    )


async def handle_sync(
    event: dict, session: AsyncSession, principal: Principal, service: MessageService
) -> dict:
    try:
        command = SyncEvent.model_validate(event)
        page = await service.mailbox(
            session, principal, command.data.after_seq, command.data.limit
        )
        response = {
            "type": "sync.response", "request_id": command.request_id,
            "data": mailbox_response(page).model_dump(mode="json"),
        }
    except ValidationError:
        response = error_event(
            "invalid_event", "Invalid sync.request data.", 422,
            event.get("request_id"),
        )
    return response


async def handle_delivery(
    event: dict, session: AsyncSession, principal: Principal, service: MessageService
) -> dict:
    try:
        command = DeliveryEvent.model_validate(event)
        envelope = await service.acknowledge(
            session, principal, command.data.envelope_id
        )
        response = {
            "type": "message.delivered",
            "request_id": command.request_id,
            "data": envelope_response(envelope).model_dump(mode="json"),
        }
    except ValidationError:
        response = error_event(
            "invalid_event", "Invalid message.delivered data.", 422,
            event.get("request_id"),
        )
    except EnvelopeNotFoundError as exc:
        response = message_error_event(
            describe_message_error(exc), event.get("request_id")
        )
    return response


async def handle_send(
    event: dict, session: AsyncSession, principal: Principal, service: MessageService
) -> dict:
    try:
        command = SendEvent.model_validate(event)
        stored = await service.send(session, principal, command.data)
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
    except (
        ChatNotFoundError,
        DuplicateDestinationError,
        InvalidEnvelopeError,
        DeliveryTargetsChangedError,
    ) as exc:
        response = message_error_event(
            describe_message_error(exc), event.get("request_id")
        )
    return response


async def handle_command(
    event: dict, session: AsyncSession, principal: Principal, service: MessageService
) -> dict:
    event_type = event.get("type")
    if event_type == "sync.request":
        return await handle_sync(event, session, principal, service)
    if event_type == "message.delivered":
        return await handle_delivery(event, session, principal, service)
    if event_type == "message.send":
        return await handle_send(event, session, principal, service)
    return error_event(
        "unsupported_event", "Event is not supported in this version.",
        400, event.get("request_id"),
    )
