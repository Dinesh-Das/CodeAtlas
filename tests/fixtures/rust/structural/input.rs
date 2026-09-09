use crate::store::Repository;

pub trait Runner {
    fn run(&self);
}

pub struct Service {
    repository: Repository,
}

impl Service {
    pub fn new(repository: Repository) -> Self {
        Self { repository }
    }

    fn save(&self) {
        self.repository.save();
    }
}

impl Runner for Service {
    fn run(&self) {
        self.save();
    }
}
