import asyncio
import base64
import binascii
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import Device
from app.auth.principal import Principal
from app.chats.errors import ChatNotFoundError
from app.chats.repository import ChatRepository
from app.messages.errors import (
    DeliveryTargetsChangedError,
    DuplicateDestinationError,
    EnvelopeNotFoundError,
    InvalidEnvelopeError,
    MailboxInvariantError,
)
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
from app.messages.types import MailboxEntry, MailboxPage, SentMessagesPage, StoredMessage
from app.realtime.events import EventBus


PAYLOAD_RETENTION = timedelta(days=45)


class MessageService:
    def __init__(
        self,
        repository: MessageRepository | None = None,
        event_bus: EventBus | None = None,
        chat_repository: ChatRepository | None = None,
    ) -> None:
        self.repository = repository or MessageRepository()
        self.event_bus = event_bus
        self.chat_repository = chat_repository or ChatRepository()

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
        envelope, sender_user_id = acknowledged
        sender_devices = await self.repository.get_active_devices(session, sender_user_id)
        await session.commit()
        await asyncio.gather(*(
            publish_delivery(self.event_bus, device.id, envelope)
            for device in sender_devices
        ))
        return envelope

    async def destination_devices(
        self,
        session: AsyncSession,
        principal: Principal,
        chat_id: uuid.UUID,
    ) -> list[Device]:
        other_user_id = await self.chat_repository.get_other_user_id(
            session, principal.user_id, chat_id
        )
        if other_user_id is None:
            raise ChatNotFoundError
        devices = await self.repository.get_active_devices(session, other_user_id)
        devices += await self.repository.get_active_devices(session, principal.user_id)
        return self._recipient_devices(principal.device_id, devices)

    @staticmethod
    def _recipient_devices(
        sender_device_id: uuid.UUID, devices: list[Device],
    ) -> list[Device]:
        return sorted(
            (device for device in devices if device.id != sender_device_id),
            key=lambda device: device.id.int,
        )

    async def send(
        self,
        session: AsyncSession,
        principal: Principal,
        request: SendMessageRequest,
    ) -> StoredMessage:
        existing = await self.lookup(session, principal, request.client_message_id)
        if existing is not None:
            return existing

        other_user_id = await self.chat_repository.get_other_user_id(
            session, principal.user_id, request.chat_id
        )
        if other_user_id is None:
            raise ChatNotFoundError

        supplied_by_device, decoded_payloads = self._validate_envelopes(
            request.envelopes
        )
        # Global lock order: chat, user IDs, mailbox IDs. Serialize chat positions
        # through commit so a larger sequence cannot become visible first.
        chat = await self.chat_repository.lock_chat(session, principal.user_id, request.chat_id)
        if chat is None:
            raise ChatNotFoundError
        existing = await self.repository.get_message_by_client_id(
            session, principal.device_id, request.client_message_id
        )
        if existing is not None:
            await session.commit()
            return StoredMessage(*existing)
        mailboxes, device_users = await self._lock_destination_mailboxes(
            session, principal, other_user_id, set(supplied_by_device)
        )

        now = datetime.now(UTC)
        chat.last_message_seq += 1
        message = Message(
            id=uuid.uuid4(),
            chat_id=request.chat_id,
            sender_user_id=principal.user_id,
            sender_device_id=principal.device_id,
            client_message_id=request.client_message_id,
            created_at=now,
            chat_seq=chat.last_message_seq,
        )
        session.add(message)

        envelopes = self._create_envelopes(
            message, mailboxes, supplied_by_device, decoded_payloads, device_users
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
        principal: Principal,
        other_user_id: uuid.UUID,
        supplied_device_ids: set[uuid.UUID],
    ) -> tuple[list[DeviceMailbox], dict[uuid.UUID, uuid.UUID]]:
        # Device mutations lock their user exclusively. Lock both users in the
        # same order to keep the complete target set stable through commit.
        user_ids = sorted(
            {other_user_id, principal.user_id}, key=lambda item: item.int
        )
        for user_id in user_ids:
            if not await self.repository.lock_device_set(session, user_id):
                raise MailboxInvariantError("a chat member has no user")
        eligible_devices = await self.repository.get_active_devices(
            session, other_user_id
        )
        # Sender copies cannot make a message deliverable to its peer. Preserve
        # the no-recipient failure even when the sender owns another device.
        if not eligible_devices:
            raise DeliveryTargetsChangedError
        own_devices = await self.repository.get_active_devices(
            session, principal.user_id
        )
        if principal.device_id not in {device.id for device in own_devices}:
            raise DeliveryTargetsChangedError
        recipients = self._recipient_devices(
            principal.device_id, [*eligible_devices, *own_devices]
        )
        device_users = {
            device.id: device.user_id for device in recipients
        }
        eligible_ids = set(device_users)
        if supplied_device_ids != eligible_ids:
            raise DeliveryTargetsChangedError

        mailboxes = await self.repository.lock_mailboxes(session, list(eligible_ids))
        if {mailbox.device_id for mailbox in mailboxes} != eligible_ids:
            raise MailboxInvariantError("an eligible device has no mailbox")
        return mailboxes, device_users

    @staticmethod
    def _create_envelopes(
        message: Message,
        mailboxes: list[DeviceMailbox],
        supplied_by_device: dict[uuid.UUID, ClientEnvelopeRequest],
        decoded_payloads: dict[uuid.UUID, bytes],
        device_users: dict[uuid.UUID, uuid.UUID],
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
                    recipient_user_id=device_users[mailbox.device_id],
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

    async def sent_page(
        self,
        session: AsyncSession,
        principal: Principal,
        after_message_id: uuid.UUID | None,
        limit: int,
        unread_only: bool = False,
    ) -> SentMessagesPage:
        rows = await self.repository.sent_page(
            session, principal.user_id, after_message_id, limit, unread_only
        )
        selected = rows[:limit]
        return SentMessagesPage(
            messages=[StoredMessage(message, list(message.envelopes)) for message in selected],
            next_message_id=selected[-1].id if selected else after_message_id,
            has_more=len(rows) > limit,
        )

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
