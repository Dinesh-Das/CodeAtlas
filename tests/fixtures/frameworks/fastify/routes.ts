import type { FastifyPluginCallback } from "fastify";

export function getStatus(): boolean {
  return true;
}

export const statusRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  fastify.get("/status", getStatus);
  fastify.route({ method: "POST", url: "/submit", handler: getStatus });
  done();
};
