import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.auth.models import User


DIRECT_CHAT_TYPE = "DIRECT"


class Chat(Base):
    __tablename__ = "chats"
    __table_args__ = (
        CheckConstraint("type = 'DIRECT'", name="ck_chats_type_direct"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    type: Mapped[str] = mapped_column(
        String(16),
        default=DIRECT_CHAT_TYPE,
        server_default=DIRECT_CHAT_TYPE,
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    members: Mapped[list["ChatMember"]] = relationship(
        back_populates="chat", lazy="raise", passive_deletes="all"
    )
    direct_pair: Mapped["DirectChatPair | None"] = relationship(
        back_populates="chat", lazy="raise", passive_deletes="all"
    )


class ChatMember(Base):
    __tablename__ = "chat_members"
    __table_args__ = (Index("ix_chat_members_user_id_chat_id", "user_id", "chat_id"),)

    chat_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chats.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    chat: Mapped["Chat"] = relationship(back_populates="members", lazy="raise")
    user: Mapped["User"] = relationship(lazy="raise")


class DirectChatPair(Base):
    __tablename__ = "direct_chat_pairs"
    __table_args__ = (
        ForeignKeyConstraint(
            ["chat_id", "user_low_id"],
            ["chat_members.chat_id", "chat_members.user_id"],
            name="fk_direct_chat_pairs_low_member",
        ),
        ForeignKeyConstraint(
            ["chat_id", "user_high_id"],
            ["chat_members.chat_id", "chat_members.user_id"],
            name="fk_direct_chat_pairs_high_member",
        ),
        UniqueConstraint(
            "user_low_id", "user_high_id", name="uq_direct_chat_pairs_users"
        ),
        CheckConstraint(
            "user_low_id < user_high_id", name="ck_direct_chat_pairs_canonical"
        ),
    )

    chat_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("chats.id", ondelete="CASCADE"), primary_key=True
    )
    user_low_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    user_high_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    chat: Mapped["Chat"] = relationship(back_populates="direct_pair", lazy="raise")
    user_low: Mapped["User"] = relationship(
        foreign_keys=[user_low_id], lazy="raise"
    )
    user_high: Mapped["User"] = relationship(
        foreign_keys=[user_high_id], lazy="raise"
    )
    # Membership associations share columns with chat/user relationships;
    # keep a single writable owner for each foreign key.
    low_member: Mapped["ChatMember"] = relationship(
        foreign_keys=[chat_id, user_low_id], viewonly=True, lazy="raise"
    )
    high_member: Mapped["ChatMember"] = relationship(
        foreign_keys=[chat_id, user_high_id], viewonly=True, lazy="raise"
    )
