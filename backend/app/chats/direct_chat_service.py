import uuid

from sqlalchemy import case, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.auth.models import User
from app.chats.errors import ChatNotFoundError, SelfChatError, TargetUserNotFoundError
from app.chats.models import Chat, ChatMember, DirectChatPair
from app.chats.types import DirectChatView


def canonical_user_pair(
    first_user_id: uuid.UUID, second_user_id: uuid.UUID
) -> tuple[uuid.UUID, uuid.UUID]:
    if first_user_id == second_user_id:
        raise SelfChatError
    if first_user_id.int < second_user_id.int:
        return first_user_id, second_user_id
    return second_user_id, first_user_id


class DirectChatService:
    async def search_users(
        self,
        session: AsyncSession,
        requester_id: uuid.UUID,
        search: str,
    ) -> list[User]:
        statement = select(User).where(
            User.status == "active", User.id != requester_id
        )
        normalized_search = search.strip().casefold()
        if normalized_search:
            statement = statement.where(
                User.username.contains(normalized_search, autoescape=True)
            )
        return list(
            (
                await session.scalars(
                    statement.order_by(User.username, User.id)
                )
            ).all()
        )

    async def open_direct_chat(
        self,
        session: AsyncSession,
        requester_id: uuid.UUID,
        target_user_id: uuid.UUID,
    ) -> DirectChatView:
        user_low_id, user_high_id = canonical_user_pair(
            requester_id, target_user_id
        )
        target_is_active = await session.scalar(
            select(User.id).where(
                User.id == target_user_id, User.status == "active"
            )
        )
        if target_is_active is None:
            raise TargetUserNotFoundError

        existing_chat_id = await self._pair_chat_id(
            session, user_low_id, user_high_id
        )
        if existing_chat_id is not None:
            return await self.get_direct_chat(
                session, requester_id, existing_chat_id
            )

        chat = Chat(id=uuid.uuid4())
        try:
            session.add(chat)
            await session.flush()

            session.add_all(
                [
                    ChatMember(chat_id=chat.id, user_id=user_low_id),
                    ChatMember(chat_id=chat.id, user_id=user_high_id),
                ]
            )
            await session.flush()

            session.add(
                DirectChatPair(
                    chat_id=chat.id,
                    user_low_id=user_low_id,
                    user_high_id=user_high_id,
                )
            )
            await session.commit()
        except IntegrityError:
            await session.rollback()
            winning_chat_id = await self._pair_chat_id(
                session, user_low_id, user_high_id
            )
            if winning_chat_id is None:
                raise
            return await self.get_direct_chat(
                session, requester_id, winning_chat_id
            )

        return await self.get_direct_chat(session, requester_id, chat.id)

    async def list_direct_chats(
        self, session: AsyncSession, requester_id: uuid.UUID
    ) -> list[DirectChatView]:
        rows = (
            await session.execute(
                self._authorized_direct_chat_statement(requester_id).order_by(
                    Chat.created_at.desc(), Chat.id
                )
            )
        ).all()
        return [
            DirectChatView(chat=chat, other_user=other_user)
            for chat, other_user in rows
        ]

    async def get_direct_chat(
        self,
        session: AsyncSession,
        requester_id: uuid.UUID,
        chat_id: uuid.UUID,
    ) -> DirectChatView:
        row = (
            await session.execute(
                self._authorized_direct_chat_statement(requester_id).where(
                    Chat.id == chat_id
                )
            )
        ).one_or_none()
        if row is None:
            raise ChatNotFoundError
        chat, other_user = row
        return DirectChatView(chat=chat, other_user=other_user)

    async def _pair_chat_id(
        self,
        session: AsyncSession,
        user_low_id: uuid.UUID,
        user_high_id: uuid.UUID,
    ) -> uuid.UUID | None:
        return await session.scalar(
            select(DirectChatPair.chat_id).where(
                DirectChatPair.user_low_id == user_low_id,
                DirectChatPair.user_high_id == user_high_id,
            )
        )

    @staticmethod
    def _authorized_direct_chat_statement(requester_id: uuid.UUID):
        other_user = aliased(User)
        other_user_id = case(
            (
                DirectChatPair.user_low_id == requester_id,
                DirectChatPair.user_high_id,
            ),
            else_=DirectChatPair.user_low_id,
        )
        return (
            select(Chat, other_user)
            .join(Chat.direct_pair)
            .join(other_user, other_user.id == other_user_id)
            .where(
                Chat.type == "DIRECT",
                or_(
                    DirectChatPair.user_low_id == requester_id,
                    DirectChatPair.user_high_id == requester_id,
                ),
            )
        )
