import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.auth.schemas import UserResponse


class ChatResponse(BaseModel):
    id: uuid.UUID
    type: Literal["DIRECT"]
    created_at: datetime
    other_user: UserResponse


class ReadStateResponse(BaseModel):
    chat_id: uuid.UUID
    user_id: uuid.UUID
    last_read_seq: int
    updated_at: datetime | None


class ChatStateResponse(BaseModel):
    chat_id: uuid.UUID
    last_message_seq: int
    read_states: list[ReadStateResponse]


class ChatStatesPageResponse(BaseModel):
    states: list[ChatStateResponse]
    next_chat_id: uuid.UUID | None
    has_more: bool
