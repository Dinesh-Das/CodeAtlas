package io.codeatlas.service;

import io.codeatlas.store.Repository;

public class Input implements Runnable {
    private final Repository repository;

    public Input(Repository repository) {
        this.repository = repository;
    }

    @Override
    public void run() {
        repository.save();
    }
}
