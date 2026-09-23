import base64
import binascii
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import Device
from app.auth.principal import Principal
from app.messages.models import DeviceMailbox, Message, MessageEnvelope
from app.messages.notifications import publish_delivery, publish_message
from app.messages.repository import MessageRepository
from app.messages.schemas import (
    MAX_ENVELOPE_PAYLOAD_BYTES,
    PLAINTEXT_ENVELOPE_TYPE,
    PROTOCOL_VERSION_PLAINTEXT,
    ClientEnvelopeRequest,
    SendMessageRequest,
)
from app.messages.types import MailboxEntry, MailboxPage, StoredMessage
from app.realtime.events import EventBus


PAYLOAD_RETENTION = timedelta(days=45)


class ChatNotFoundError(Exception):
    pass


class EnvelopeNotFoundError(Exception):
    pass


class DuplicateDestinationError(Exception):
    pass


class InvalidEnvelopeError(Exception):
    pass


class DeliveryTargetsChangedError(Exception):
    pass


class MailboxInvariantError(RuntimeError):
    pass


class MessageService:
    def __init__(
        self,
        repository: MessageRepository | None = None,
        event_bus: EventBus | None = None,
    ) -> None:
        self.repository = repository or MessageRepository()
        self.event_bus = event_bus

    async def lookup(
        self,
        session: AsyncSession,
        principal: Principal,
        client_message_id: uuid.UUID,
    ) -> StoredMessage | None:
        """Find an idempotent result, purging and committing expired payloads first."""
        existing = await self.repository.get_message_by_client_id(
            session, principal.device_id, client_message_id
        )
        if existing is None:
            return None
        await self.repository.purge_expired_for_message(
            session, existing[0].id, datetime.now(UTC)
        )
        await session.commit()
        refreshed = await self.repository.get_message_by_client_id(
            session, principal.device_id, client_message_id
        )
        if refreshed is None:
            raise MailboxInvariantError("an idempotent message disappeared")
        return StoredMessage(*refreshed)

    async def acknowledge(
        self,
        session: AsyncSession,
        principal: Principal,
        envelope_id: uuid.UUID,
    ) -> MessageEnvelope:
        acknowledged = await self.repository.acknowledge(
            session, principal.device_id, envelope_id, datetime.now(UTC)
        )
        if acknowledged is None:
            raise EnvelopeNotFoundError
        envelope, sender_device_id = acknowledged
        await session.commit()
        await publish_delivery(self.event_bus, sender_device_id, envelope)
        return envelope

    async def destination_devices(
        self,
        session: AsyncSession,
        principal: Principal,
        chat_id: uuid.UUID,
    ) -> list[Device]:
        other_user_id = await self.repository.get_other_user_id(
            session, principal.user_id, chat_id
        )
        if other_user_id is None:
            raise ChatNotFoundError
        return await self.repository.get_active_devices(session, other_user_id)

    async def send(
        self,
        session: AsyncSession,
        principal: Principal,
        request: SendMessageRequest,
    ) -> StoredMessage:
        existing = await self.lookup(session, principal, request.client_message_id)
        if existing is not None:
            return existing

        other_user_id = await self.repository.get_other_user_id(
            session, principal.user_id, request.chat_id
        )
        if other_user_id is None:
            raise ChatNotFoundError

        supplied_by_device, decoded_payloads = self._validate_envelopes(
            request.envelopes
        )
        mailboxes = await self._lock_destination_mailboxes(
            session, other_user_id, set(supplied_by_device)
        )

        now = datetime.now(UTC)
        message = Message(
            id=uuid.uuid4(),
            chat_id=request.chat_id,
            sender_user_id=principal.user_id,
            sender_device_id=principal.device_id,
            client_message_id=request.client_message_id,
            created_at=now,
        )
        session.add(message)

        envelopes = self._create_envelopes(
            message, mailboxes, supplied_by_device, decoded_payloads
        )
        session.add_all(envelopes)

        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            winning = await self.repository.get_message_by_client_id(
                session, principal.device_id, request.client_message_id
            )
            if winning is None:
                raise
            return StoredMessage(*winning)
        stored = StoredMessage(message=message, envelopes=envelopes)
        await publish_message(self.event_bus, stored)
        return stored

    @classmethod
    def _validate_envelopes(
        cls, envelopes: list[ClientEnvelopeRequest]
    ) -> tuple[dict[uuid.UUID, ClientEnvelopeRequest], dict[uuid.UUID, bytes]]:
        supplied_by_device: dict[uuid.UUID, ClientEnvelopeRequest] = {}
        decoded_payloads: dict[uuid.UUID, bytes] = {}
        for envelope in envelopes:
            if envelope.recipient_device_id in supplied_by_device:
                raise DuplicateDestinationError
            decoded_payloads[envelope.recipient_device_id] = cls._validate_envelope(
                envelope
            )
            supplied_by_device[envelope.recipient_device_id] = envelope
        return supplied_by_device, decoded_payloads

    async def _lock_destination_mailboxes(
        self,
        session: AsyncSession,
        other_user_id: uuid.UUID,
        supplied_device_ids: set[uuid.UUID],
    ) -> list[DeviceMailbox]:
        # Device creation and revocation take an exclusive lock on this user row.
        # Holding a shared lock makes the eligible device set stable until commit.
        if not await self.repository.lock_device_set(session, other_user_id):
            raise MailboxInvariantError("a chat member has no user")

        eligible_devices = await self.repository.get_active_devices(
            session, other_user_id
        )
        eligible_ids = {device.id for device in eligible_devices}
        if supplied_device_ids != eligible_ids:
            raise DeliveryTargetsChangedError

        sorted_device_ids = sorted(eligible_ids, key=lambda item: item.int)
        mailboxes = await self.repository.lock_mailboxes(session, sorted_device_ids)
        if [mailbox.device_id for mailbox in mailboxes] != sorted_device_ids:
            raise MailboxInvariantError("an eligible device has no mailbox")
        return mailboxes

    @staticmethod
    def _create_envelopes(
        message: Message,
        mailboxes: list[DeviceMailbox],
        supplied_by_device: dict[uuid.UUID, ClientEnvelopeRequest],
        decoded_payloads: dict[uuid.UUID, bytes],
    ) -> list[MessageEnvelope]:
        """Allocate sequences on locked mailboxes and build their envelopes."""
        envelopes: list[MessageEnvelope] = []
        for mailbox in mailboxes:
            mailbox.last_seq += 1
            supplied = supplied_by_device[mailbox.device_id]
            envelopes.append(
                MessageEnvelope(
                    id=uuid.uuid4(),
                    message_id=message.id,
                    recipient_device_id=mailbox.device_id,
                    mailbox_seq=mailbox.last_seq,
                    protocol_version=supplied.protocol_version,
                    envelope_type=supplied.envelope_type,
                    payload=decoded_payloads[mailbox.device_id],
                    created_at=message.created_at,
                    expires_at=message.created_at + PAYLOAD_RETENTION,
                )
            )
        return envelopes

    @staticmethod
    def _validate_envelope(envelope: ClientEnvelopeRequest) -> bytes:
        if (
            envelope.protocol_version != PROTOCOL_VERSION_PLAINTEXT
            or envelope.envelope_type != PLAINTEXT_ENVELOPE_TYPE
        ):
            raise InvalidEnvelopeError("unsupported envelope protocol and type")
        maximum_encoded_length = 4 * ((MAX_ENVELOPE_PAYLOAD_BYTES + 2) // 3)
        if len(envelope.payload) > maximum_encoded_length:
            raise InvalidEnvelopeError("payload exceeds the maximum size")
        try:
            decoded = base64.b64decode(envelope.payload, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise InvalidEnvelopeError("payload must be valid base64") from exc
        if len(decoded) > MAX_ENVELOPE_PAYLOAD_BYTES:
            raise InvalidEnvelopeError("payload exceeds the maximum size")
        if base64.b64encode(decoded).decode("ascii") != envelope.payload:
            raise InvalidEnvelopeError(
                "payload must use canonical base64 encoding"
            )
        return decoded

    async def mailbox(
        self,
        session: AsyncSession,
        principal: Principal,
        after_seq: int,
        limit: int,
    ) -> MailboxPage:
        now = datetime.now(UTC)
        await self.repository.purge_expired_for_device(
            session, principal.device_id, now
        )
        rows = await self.repository.mailbox_page(
            session, principal.device_id, after_seq, limit
        )
        await session.commit()

        has_more = len(rows) > limit
        page_rows = rows[:limit]
        entries = [
            MailboxEntry(envelope=envelope, message=message)
            for envelope, message in page_rows
        ]
        next_seq = entries[-1].envelope.mailbox_seq if entries else after_seq
        return MailboxPage(
            entries=entries,
            next_seq=next_seq,
            has_more=has_more,
        )

    async def purge_expired_batch(
        self,
        session: AsyncSession,
        *,
        batch_size: int = 1000,
        now: datetime | None = None,
    ) -> int:
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        purge_time = now or datetime.now(UTC)
        envelope_ids = await self.repository.lock_expired_batch(
            session, purge_time, batch_size
        )
        purged = await self.repository.purge_envelopes(
            session, envelope_ids, purge_time
        )
        await session.commit()
        return purged
