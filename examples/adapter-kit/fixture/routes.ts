import { Router } from "acme-web";
import { listOrders } from "./service.js";

export const router = new Router();
router.get("/orders", listOrders);
