import uuid
from typing import Annotated, TypeAlias

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentPrincipal
from app.database import get_session
from app.messages.dependencies import Service
from app.messages.responses import envelope_response, mailbox_response, message_response
from app.messages.schemas import (
    DestinationDeviceResponse,
    EnvelopeResponse,
    MailboxPageResponse,
    MessageResponse,
    SendMessageRequest,
)
from app.messages.service import (
    ChatNotFoundError,
    DeliveryTargetsChangedError,
    DuplicateDestinationError,
    EnvelopeNotFoundError,
    InvalidEnvelopeError,
)


router = APIRouter()
DatabaseSession: TypeAlias = Annotated[AsyncSession, Depends(get_session)]


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
        raise HTTPException(status_code=404, detail="envelope not found") from exc
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
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="chat not found"
        ) from exc
    return [
        DestinationDeviceResponse(
            id=device.id, protocol_version=device.protocol_version
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
    except ChatNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="chat not found"
        ) from exc
    except DuplicateDestinationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="duplicate recipient device",
        ) from exc
    except InvalidEnvelopeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except DeliveryTargetsChangedError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "delivery_targets_changed",
                "message": "Destination devices changed; refresh and retry.",
            },
        ) from exc
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
