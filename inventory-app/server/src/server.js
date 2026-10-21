const app = require("./app");
const config = require("./config");
const prisma = require("./db");
const { startMarketFeedPolling } = require("./services/market");

const server = app.listen(config.port, () => {
  console.log(`Hotel inventory listening on http://localhost:${config.port}`);
  startMarketFeedPolling();
});

const shutdown = () => server.close(() => prisma.$disconnect().then(() => process.exit(0)));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
