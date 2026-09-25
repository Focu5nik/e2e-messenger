import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from app.chats.errors import ChatNotFoundError
from app.auth.dependencies import CurrentPrincipal
from app.messages.dependencies import DatabaseSession, Service
from app.messages.error_responses import MessageErrorDescription, describe_message_error
from app.messages.errors import (
    DeliveryTargetsChangedError,
    DuplicateDestinationError,
    EnvelopeNotFoundError,
    InvalidEnvelopeError,
)
from app.messages.responses import (
    envelope_response, mailbox_response, message_response, sent_messages_response,
)
from app.messages.schemas import (
    DestinationDeviceResponse,
    EnvelopeResponse,
    MailboxPageResponse,
    MessageResponse,
    SendMessageRequest,
    SentMessagesPageResponse,
)


router = APIRouter()


def message_http_error(description: MessageErrorDescription) -> HTTPException:
    detail = (
        {"code": description.code, "message": description.message}
        if description.code == "delivery_targets_changed"
        else description.message
    )
    return HTTPException(status_code=description.status, detail=detail)


@router.get("/messages/sent", response_model=SentMessagesPageResponse)
async def sent_messages(
    principal: CurrentPrincipal, session: DatabaseSession, service: Service,
    after_message_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
    unread_only: bool = False,
) -> SentMessagesPageResponse:
    page = await service.sent_page(session, principal, after_message_id, limit, unread_only)
    return sent_messages_response(page)


@router.get("/messages/by-client-id/{client_message_id}", response_model=MessageResponse)
async def lookup_message(
    client_message_id: uuid.UUID,
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: Service,
) -> MessageResponse:
    stored = await service.lookup(session, principal, client_message_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="message not found")
    return message_response(stored)


@router.post("/messages/envelopes/{envelope_id}/ack", response_model=EnvelopeResponse)
async def acknowledge_delivery(
    envelope_id: uuid.UUID,
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: Service,
) -> EnvelopeResponse:
    try:
        envelope = await service.acknowledge(session, principal, envelope_id)
    except EnvelopeNotFoundError as exc:
        raise message_http_error(describe_message_error(exc)) from exc
    return envelope_response(envelope)


@router.get(
    "/chats/{chat_id}/destination-devices",
    response_model=list[DestinationDeviceResponse],
)
async def destination_devices(
    chat_id: uuid.UUID,
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: Service,
) -> list[DestinationDeviceResponse]:
    try:
        devices = await service.destination_devices(session, principal, chat_id)
    except ChatNotFoundError as exc:
        raise message_http_error(describe_message_error(exc)) from exc
    return [
        DestinationDeviceResponse(
            id=device.id, user_id=device.user_id, protocol_version=device.protocol_version
        )
        for device in devices
    ]


@router.post(
    "/messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def send_message(
    request: SendMessageRequest,
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: Service,
) -> MessageResponse:
    try:
        stored = await service.send(session, principal, request)
    except (
        ChatNotFoundError,
        DuplicateDestinationError,
        InvalidEnvelopeError,
        DeliveryTargetsChangedError,
    ) as exc:
        raise message_http_error(describe_message_error(exc)) from exc
    return message_response(stored)


@router.get("/messages/mailbox", response_model=MailboxPageResponse)
async def read_mailbox(
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: Service,
    after_seq: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
) -> MailboxPageResponse:
    page = await service.mailbox(session, principal, after_seq, limit)
    return mailbox_response(page)
