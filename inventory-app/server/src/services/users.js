// Users and login. Tokens carry { id, name, email, role } and last 12 hours.
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../db");
const config = require("../config");
const { HttpError, badRequest, notFound, uuid, text, oneOf } = require("../lib/http");

const ROLES = ["user", "approver", "admin"];
const PUBLIC_FIELDS = { id: true, name: true, email: true, role: true, isActive: true, createdAt: true };

const issueToken = (user) =>
  jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, config.jwtSecret, {
    expiresIn: "12h",
  });

const session = (user) => ({ token: issueToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role } });

const parseCredentials = (body) => {
  const email = text(body.email, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest("email is not valid");
  const password = text(body.password, "password");
  return { email, password };
};

/**
 * Self-registration. The very first account becomes admin so a fresh install can be set up;
 * everyone after that starts as store staff ("user") and an admin assigns other roles.
 */
const register = async (body) => {
  const { email, password } = parseCredentials(body);
  if (password.length < 8) throw badRequest("password must be at least 8 characters");
  const name = text(body.name, "name");
  if (!config.allowSignup && (await prisma.user.count()) > 0) {
    throw new HttpError(403, "Self-registration is disabled; ask an admin to create your account");
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.$transaction(async (tx) => {
    const isFirst = (await tx.user.count()) === 0;
    return tx.user.create({ data: { name, email, passwordHash, role: isFirst ? "admin" : "user" } });
  });
  return session(user);
};

const login = async (body) => {
  const { email, password } = parseCredentials(body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, "Invalid credentials");
  }
  return session(user);
};

const listUsers = () => prisma.user.findMany({ select: PUBLIC_FIELDS, orderBy: { name: "asc" } });

// Admin-created account (e.g. when self-registration is disabled).
const createUser = async (body) => {
  const { email, password } = parseCredentials(body);
  if (password.length < 8) throw badRequest("password must be at least 8 characters");
  return prisma.user.create({
    data: {
      name: text(body.name, "name"),
      email,
      passwordHash: await bcrypt.hash(password, 10),
      role: oneOf(body.role ?? "user", "role", ROLES),
    },
    select: PUBLIC_FIELDS,
  });
};

const updateUser = async (id, body, actingUserId) => {
  const userId = uuid(id, "id");
  const data = {};
  if (body.role !== undefined) data.role = oneOf(body.role, "role", ROLES);
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;
  if (body.name !== undefined) data.name = text(body.name, "name");
  if (body.password !== undefined) {
    const password = text(body.password, "password");
    if (password.length < 8) throw badRequest("password must be at least 8 characters");
    data.passwordHash = await bcrypt.hash(password, 10);
  }
  if (userId === actingUserId && ((data.role && data.role !== "admin") || data.isActive === false)) {
    throw badRequest("You cannot remove your own admin access");
  }
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) throw notFound("User");
  return prisma.user.update({ where: { id: userId }, data, select: PUBLIC_FIELDS });
};

module.exports = { ROLES, register, login, listUsers, createUser, updateUser, issueToken };
