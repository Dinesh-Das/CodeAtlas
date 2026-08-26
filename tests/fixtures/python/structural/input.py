from app.dependency import Dependency


class Service:
    token: str = "not-stored"

    async def run(self, value: str = "hidden") -> bool:
        def normalize(item: str) -> str:
            return item.strip()

        return bool(normalize(value))


def helper(value: int) -> int:
    return value


__all__ = ["Service", "helper"]
