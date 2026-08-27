from .base import Base as Parent, shared, value


class Worker(Parent):
    def run(self):
        shared()
        self.finish()
        current = value

    def finish(self):
        pass
