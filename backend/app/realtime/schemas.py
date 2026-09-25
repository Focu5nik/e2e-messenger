import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.messages.schemas import SendMessageRequest


class AuthEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["auth"]
    access_token: str = Field(min_length=1, max_length=8192)


class SendEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["message.send"]
    request_id: str = Field(min_length=1, max_length=128)
    data: SendMessageRequest


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    after_seq: int = Field(default=0, ge=0, le=2**63 - 1)
    limit: int = Field(default=100, ge=1, le=100)


class SyncEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["sync.request"]
    request_id: str = Field(min_length=1, max_length=128)
    data: SyncRequest


class DeliveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    envelope_id: uuid.UUID


class DeliveryEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["message.delivered"]
    request_id: str = Field(min_length=1, max_length=128)
    data: DeliveryRequest


class ChatReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    chat_id: uuid.UUID
    last_read_seq: int = Field(ge=0, le=2**53 - 1, strict=True)


class ChatReadEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["chat.read"]
    request_id: str = Field(min_length=1, max_length=128)
    data: ChatReadRequest

