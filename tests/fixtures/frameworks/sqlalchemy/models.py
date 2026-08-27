from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = "atlas_users"
    id: Mapped[int] = mapped_column(primary_key=True)
    posts: Mapped[list["Post"]] = relationship("Post")

class Post(Base):
    __tablename__ = "atlas_posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    author: Mapped["User"] = relationship("User")
