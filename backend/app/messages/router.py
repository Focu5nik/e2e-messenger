import uuid
from datetime import UTC, datetime
from typing import Annotated, TypeAlias

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentPrincipal
from app.database import get_session
from app.messages.models import Message, MessageEnvelope
from app.messages.schemas import (
    DestinationDeviceResponse,
    EnvelopeResponse,
    MailboxEnvelopeResponse,
    MailboxPageResponse,
    MessageResponse,
    SendMessageRequest,
)
from app.messages.service import (
    ChatNotFoundError,
    DeliveryTargetsChangedError,
    DuplicateDestinationError,
    InvalidEnvelopeError,
    MailboxPage,
    MessageService,
    StoredMessage,
)


router = APIRouter()
DatabaseSession: TypeAlias = Annotated[AsyncSession, Depends(get_session)]


def message_service() -> MessageService:
    return MessageService()


Service: TypeAlias = Annotated[MessageService, Depends(message_service)]


def utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def envelope_response(envelope: MessageEnvelope) -> EnvelopeResponse:
    return EnvelopeResponse(
        id=envelope.id,
        message_id=envelope.message_id,
        recipient_device_id=envelope.recipient_device_id,
        mailbox_seq=envelope.mailbox_seq,
        protocol_version=envelope.protocol_version,
        envelope_type=envelope.envelope_type,
        payload=envelope.payload,
        created_at=utc(envelope.created_at),
        expires_at=utc(envelope.expires_at),
        delivered_at=(utc(envelope.delivered_at) if envelope.delivered_at else None),
        payload_purged_at=(
            utc(envelope.payload_purged_at) if envelope.payload_purged_at else None
        ),
    )


def message_response(stored: StoredMessage) -> MessageResponse:
    message = stored.message
    return MessageResponse(
        id=message.id,
        chat_id=message.chat_id,
        sender_user_id=message.sender_user_id,
        sender_device_id=message.sender_device_id,
        client_message_id=message.client_message_id,
        created_at=utc(message.created_at),
        envelopes=[envelope_response(item) for item in stored.envelopes],
    )


def mailbox_response(page: MailboxPage) -> MailboxPageResponse:
    responses: list[MailboxEnvelopeResponse] = []
    for entry in page.entries:
        envelope = envelope_response(entry.envelope)
        message = entry.message
        responses.append(
            MailboxEnvelopeResponse(
                **envelope.model_dump(),
                chat_id=message.chat_id,
                sender_user_id=message.sender_user_id,
                sender_device_id=message.sender_device_id,
                client_message_id=message.client_message_id,
                message_created_at=utc(message.created_at),
            )
        )
    return MailboxPageResponse(
        envelopes=responses,
        next_seq=page.next_seq,
        has_more=page.has_more,
    )


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
