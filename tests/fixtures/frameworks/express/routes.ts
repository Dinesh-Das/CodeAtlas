import express from "express";

const app = express();

export function getUser(): boolean {
  return true;
}

export function createUser(): boolean {
  return true;
}

app.get("/users/:userId", getUser);
app.post("/users", createUser);
