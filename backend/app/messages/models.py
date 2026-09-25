import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.auth.models import Device, User
    from app.chats.models import Chat


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_sender_user_id_id", "sender_user_id", "id"),
        UniqueConstraint("chat_id", "chat_seq", name="uq_messages_chat_seq"),
        CheckConstraint("chat_seq > 0", name="ck_messages_chat_seq_positive"),
        UniqueConstraint(
            "sender_device_id",
            "client_message_id",
            name="uq_messages_sender_device_client_message",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    chat_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chats.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    sender_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    sender_device_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("devices.id", ondelete="RESTRICT"), nullable=False
    )
    client_message_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    chat_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    chat: Mapped["Chat"] = relationship(lazy="raise")
    sender_user: Mapped["User"] = relationship(lazy="raise")
    sender_device: Mapped["Device"] = relationship(lazy="raise")
    envelopes: Mapped[list["MessageEnvelope"]] = relationship(
        back_populates="message",
        lazy="raise",
        order_by="MessageEnvelope.recipient_device_id",
    )


class DeviceMailbox(Base):
    __tablename__ = "device_mailboxes"

    device_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True
    )
    last_seq: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    device: Mapped["Device"] = relationship(back_populates="mailbox", lazy="raise")


class MessageEnvelope(Base):
    __tablename__ = "message_envelopes"
    __table_args__ = (
        UniqueConstraint(
            "message_id",
            "recipient_device_id",
            name="uq_message_envelopes_message_recipient",
        ),
        UniqueConstraint(
            "recipient_device_id",
            "mailbox_seq",
            name="uq_message_envelopes_recipient_mailbox_seq",
        ),
        CheckConstraint(
            "(payload IS NULL) = (payload_purged_at IS NOT NULL)",
            name="ck_message_envelopes_payload_purge_state",
        ),
        Index(
            "ix_message_envelopes_recipient_mailbox_seq",
            "recipient_device_id",
            "mailbox_seq",
        ),
        Index(
            "ix_message_envelopes_unpurged_expires_at",
            "expires_at",
            postgresql_where=text("payload IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="RESTRICT"), nullable=False
    )
    recipient_device_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("devices.id", ondelete="RESTRICT"), nullable=False
    )
    recipient_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    mailbox_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    protocol_version: Mapped[int] = mapped_column(Integer, nullable=False)
    envelope_type: Mapped[str] = mapped_column(String(32), nullable=False)
    payload: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payload_purged_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    message: Mapped["Message"] = relationship(
        back_populates="envelopes", lazy="raise"
    )
    recipient_device: Mapped["Device"] = relationship(lazy="raise")
    recipient_user: Mapped["User"] = relationship(lazy="raise")
