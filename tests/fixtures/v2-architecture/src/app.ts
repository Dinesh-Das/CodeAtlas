import express from "express";
import { login as loginController } from "./auth/controller.js";

export const app = express();

export function login(email: string, password: string): string {
  return loginController(email, password);
}

app.post("/login", login);
