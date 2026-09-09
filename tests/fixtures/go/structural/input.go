package service

import "example.com/codeatlas/store"

type Runner interface {
	Run() error
}

type Worker struct {
	repository *store.Repository
}

func NewWorker(repository *store.Repository) *Worker {
	return &Worker{repository: repository}
}

func (worker *Worker) Run() error {
	return worker.repository.Save()
}
