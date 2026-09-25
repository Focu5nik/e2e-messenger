import uuid
from dataclasses import dataclass
from datetime import datetime

from app.auth.models import User
from app.chats.models import Chat


@dataclass(frozen=True, slots=True)
class DirectChatView:
    chat: Chat
    other_user: User


@dataclass(frozen=True, slots=True)
class ReadState:
    chat_id: uuid.UUID
    user_id: uuid.UUID
    last_read_seq: int
    updated_at: datetime | None


@dataclass(frozen=True, slots=True)
class ChatStatesPage:
    chats: list[Chat]
    next_chat_id: uuid.UUID | None
    has_more: bool
