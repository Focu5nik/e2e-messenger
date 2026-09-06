import uuid
from datetime import datetime

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
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


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
