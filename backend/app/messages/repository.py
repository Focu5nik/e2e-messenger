import uuid
from datetime import datetime

from sqlalchemy import Select, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth.models import Device, User
from app.chats.models import Chat, DirectChatPair
from app.messages.models import DeviceMailbox, Message, MessageEnvelope


class MessageRepository:
    async def acknowledge(
        self,
        session: AsyncSession,
        device_id: uuid.UUID,
        envelope_id: uuid.UUID,
        now: datetime,
    ) -> tuple[MessageEnvelope, uuid.UUID] | None:
        # Authorization and the entire transition share one row-locked UPDATE.
        # COALESCE preserves the first receipt/purge time on concurrent retries,
        # including a delayed ACK for content already removed by expiry.
        envelope = await session.scalar(
            update(MessageEnvelope)
            .where(
                MessageEnvelope.id == envelope_id,
                MessageEnvelope.recipient_device_id == device_id,
            )
            .values(
                delivered_at=func.coalesce(MessageEnvelope.delivered_at, now),
                payload=None,
                payload_purged_at=func.coalesce(MessageEnvelope.payload_purged_at, now),
            )
            .returning(MessageEnvelope)
            .execution_options(populate_existing=True)
        )
        if envelope is None:
            return None
        sender_device_id = await session.scalar(
            select(Message.sender_device_id)
            .join(Message.envelopes)
            .where(MessageEnvelope.id == envelope_id)
        )
        assert sender_device_id is not None
        return envelope, sender_device_id

    async def lock_device_set(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
    ) -> bool:
        locked_user_id = await session.scalar(
            select(User.id)
            .where(User.id == user_id)
            .with_for_update(read=True)
        )
        return locked_user_id is not None

    async def get_message_by_client_id(
        self,
        session: AsyncSession,
        sender_device_id: uuid.UUID,
        client_message_id: uuid.UUID,
    ) -> tuple[Message, list[MessageEnvelope]] | None:
        message = await session.scalar(
            select(Message)
            .options(selectinload(Message.envelopes))
            .where(
                Message.sender_device_id == sender_device_id,
                Message.client_message_id == client_message_id,
            )
        )
        if message is None:
            return None
        return message, list(message.envelopes)

    async def get_other_user_id(
        self,
        session: AsyncSession,
        requester_id: uuid.UUID,
        chat_id: uuid.UUID,
    ) -> uuid.UUID | None:
        pair = await session.execute(
            select(DirectChatPair.user_low_id, DirectChatPair.user_high_id)
            .join(Chat, Chat.id == DirectChatPair.chat_id)
            .where(
                DirectChatPair.chat_id == chat_id,
                Chat.type == "DIRECT",
                (
                    (DirectChatPair.user_low_id == requester_id)
                    | (DirectChatPair.user_high_id == requester_id)
                ),
            )
        )
        row = pair.one_or_none()
        if row is None:
            return None
        low_id, high_id = row
        return high_id if low_id == requester_id else low_id

    async def get_active_devices(
        self,
        session: AsyncSession,
        user_id: uuid.UUID,
    ) -> list[Device]:
        return list(
            (
                await session.scalars(
                    select(Device)
                    .join(Device.user)
                    .where(
                        Device.user_id == user_id,
                        Device.revoked_at.is_(None),
                        User.status == "active",
                    )
                    .order_by(Device.id)
                )
            ).all()
        )

    async def lock_mailboxes(
        self,
        session: AsyncSession,
        device_ids: list[uuid.UUID],
    ) -> list[DeviceMailbox]:
        if not device_ids:
            return []
        return list(
            (
                await session.scalars(
                    select(DeviceMailbox)
                    .where(DeviceMailbox.device_id.in_(device_ids))
                    .order_by(DeviceMailbox.device_id)
                    .with_for_update()
                )
            ).all()
        )

    async def purge_expired_for_device(
        self,
        session: AsyncSession,
        device_id: uuid.UUID,
        now: datetime,
    ) -> int:
        result = await session.execute(
            update(MessageEnvelope)
            .where(
                MessageEnvelope.recipient_device_id == device_id,
                MessageEnvelope.payload.is_not(None),
                MessageEnvelope.expires_at <= now,
            )
            .values(payload=None, payload_purged_at=now)
            .execution_options(synchronize_session="fetch")
        )
        return result.rowcount or 0

    async def purge_expired_for_message(
        self,
        session: AsyncSession,
        message_id: uuid.UUID,
        now: datetime,
    ) -> int:
        result = await session.execute(
            update(MessageEnvelope)
            .where(
                MessageEnvelope.message_id == message_id,
                MessageEnvelope.payload.is_not(None),
                MessageEnvelope.expires_at <= now,
            )
            .values(payload=None, payload_purged_at=now)
            .execution_options(synchronize_session="fetch")
        )
        return result.rowcount or 0

    async def mailbox_page(
        self,
        session: AsyncSession,
        device_id: uuid.UUID,
        after_seq: int,
        limit: int,
    ) -> list[tuple[MessageEnvelope, Message]]:
        return list(
            (
                await session.execute(
                    select(MessageEnvelope, Message)
                    .join(MessageEnvelope.message)
                    .where(
                        MessageEnvelope.recipient_device_id == device_id,
                        MessageEnvelope.mailbox_seq > after_seq,
                    )
                    .order_by(MessageEnvelope.mailbox_seq)
                    .limit(limit + 1)
                )
            ).all()
        )

    async def lock_expired_batch(
        self,
        session: AsyncSession,
        now: datetime,
        batch_size: int,
    ) -> list[uuid.UUID]:
        statement: Select[tuple[uuid.UUID]] = (
            select(MessageEnvelope.id)
            .where(
                MessageEnvelope.payload.is_not(None),
                MessageEnvelope.expires_at <= now,
            )
            .order_by(MessageEnvelope.expires_at, MessageEnvelope.id)
            .limit(batch_size)
            .with_for_update(skip_locked=True)
        )
        return list((await session.scalars(statement)).all())

    async def purge_envelopes(
        self,
        session: AsyncSession,
        envelope_ids: list[uuid.UUID],
        now: datetime,
    ) -> int:
        if not envelope_ids:
            return 0
        result = await session.execute(
            update(MessageEnvelope)
            .where(
                MessageEnvelope.id.in_(envelope_ids),
                MessageEnvelope.payload.is_not(None),
                MessageEnvelope.expires_at <= now,
            )
            .values(payload=None, payload_purged_at=now)
            .execution_options(synchronize_session="fetch")
        )
        return result.rowcount or 0
