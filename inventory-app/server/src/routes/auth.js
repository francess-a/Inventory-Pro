const express = require("express");
const { auth, requireRole } = require("../lib/auth");
const users = require("../services/users");

// Public: register / login. Authenticated: who am I. Admin: user management.
const publicRouter = express.Router();
publicRouter.post("/auth/register", async (req, res) => res.status(201).json(await users.register(req.body ?? {})));
publicRouter.post("/auth/login", async (req, res) => res.json(await users.login(req.body ?? {})));

const router = express.Router();
const admin = requireRole("admin");
router.get("/auth/me", (req, res) => res.json({ user: req.user }));
router.get("/users", admin, async (req, res) => res.json(await users.listUsers()));
router.post("/users", admin, async (req, res) => res.status(201).json(await users.createUser(req.body ?? {})));
router.patch("/users/:id", admin, async (req, res) =>
  res.json(await users.updateUser(req.params.id, req.body ?? {}, req.user?.id))
);

module.exports = { publicRouter, router, auth };
