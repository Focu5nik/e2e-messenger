from datetime import UTC

from app.auth.models import User
from app.auth.schemas import UserResponse
from app.chats.schemas import (
    ChatResponse,
    ChatStateResponse,
    ChatStatesPageResponse,
    ReadStateResponse,
)
from app.chats.types import ChatStatesPage, DirectChatView, ReadState


def user_response(user: User) -> UserResponse:
    return UserResponse.model_validate(user)


def chat_response(view: DirectChatView) -> ChatResponse:
    return ChatResponse(
        id=view.chat.id,
        type="DIRECT",
        created_at=view.chat.created_at,
        other_user=user_response(view.other_user),
    )


def read_state_response(state: ReadState) -> ReadStateResponse:
    updated_at = state.updated_at
    if updated_at is not None:
        updated_at = (
            updated_at.replace(tzinfo=UTC) if updated_at.tzinfo is None
            else updated_at.astimezone(UTC)
        )
    return ReadStateResponse(
        chat_id=state.chat_id, user_id=state.user_id,
        last_read_seq=state.last_read_seq, updated_at=updated_at,
    )


def chat_states_response(page: ChatStatesPage) -> ChatStatesPageResponse:
    return ChatStatesPageResponse(
        states=[ChatStateResponse(
            chat_id=chat.id,
            last_message_seq=chat.last_message_seq,
            read_states=[read_state_response(ReadState(
                chat_id=chat.id, user_id=member.user_id,
                last_read_seq=member.read_state.last_read_seq if member.read_state else 0,
                updated_at=member.read_state.updated_at if member.read_state else None,
            )) for member in sorted(chat.members, key=lambda member: member.user_id.int)],
        ) for chat in page.chats],
        next_chat_id=page.next_chat_id,
        has_more=page.has_more,
    )
