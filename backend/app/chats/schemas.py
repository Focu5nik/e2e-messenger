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
