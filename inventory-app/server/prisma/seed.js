// Seeds a demo hotel: vendors, departments, items and ~120 days of simulated
// purchasing, requisitions/issues and market prices, so that usage statistics,
// safety stock, vendor scorecards and price trends have history to work from.
//
//   npm run db:seed            (refuses to run if items already exist)
//   npm run db:seed -- --reset (wipes all inventory data first)
//
// Also creates demo logins (admin@hotel.example, approver@hotel.example, store@hotel.example)
// with the password in SEED_PASSWORD (default "ChangeMe123!"). Change them before real use.

const bcrypt = require("bcryptjs");
const prisma = require("../src/db");
const { createInTx, sendInTx, receiveInTx } = require("../src/services/purchasing");
const { issueInTx } = require("../src/services/requisitions");
const { issueFromCentral } = require("../src/services/ledger");
const { DAY_MS } = require("../src/lib/planning");

const HISTORY_DAYS = 120;

// Deterministic PRNG (mulberry32) so every seed produces the same demo data.
let state = 20261021;
const rand = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const pick = (list) => list[Math.floor(rand() * list.length)];

const VENDORS = [
  // reliability: chance of arriving on time; extraDelay: days late when not; rejectRate: share rejected; priceFactor vs market
  { key: "farm", vendorName: "Green Valley Farm Produce", contactName: "Ravi Kumar", email: "orders@greenvalley.example", phone: "+91 98400 11111", leadTimeDays: 1, reliability: 0.92, extraDelay: 1, rejectRate: 0.04, priceFactor: 1.02 },
  { key: "metro", vendorName: "Metro Wholesale Traders", contactName: "Anita Shah", email: "sales@metrowholesale.example", phone: "+91 98400 22222", leadTimeDays: 2, reliability: 0.85, extraDelay: 2, rejectRate: 0.01, priceFactor: 0.98 },
  { key: "coastal", vendorName: "Coastal Fresh Meats & Seafood", contactName: "Joseph D'Souza", email: "supply@coastalfresh.example", phone: "+91 98400 33333", leadTimeDays: 1, reliability: 0.75, extraDelay: 1, rejectRate: 0.07, priceFactor: 1.06 },
  { key: "dairy", vendorName: "Sunrise Dairy Co-op", contactName: "Meena Iyer", email: "dispatch@sunrisedairy.example", phone: "+91 98400 44444", leadTimeDays: 1, reliability: 0.97, extraDelay: 1, rejectRate: 0.01, priceFactor: 1.0 },
  { key: "linen", vendorName: "Royal Linen & Amenities", contactName: "Farhan Ali", email: "orders@royallinen.example", phone: "+91 98400 55555", leadTimeDays: 7, reliability: 0.6, extraDelay: 4, rejectRate: 0.03, priceFactor: 1.1 },
  { key: "spirits", vendorName: "Premier Beverage Distributors", contactName: "Karan Mehta", email: "trade@premierbev.example", phone: "+91 98400 66666", leadTimeDays: 4, reliability: 0.9, extraDelay: 2, rejectRate: 0.0, priceFactor: 1.0 },
  { key: "spares", vendorName: "Techno Engineering Spares", contactName: "Suresh Babu", email: "parts@technospares.example", phone: "+91 98400 77777", leadTimeDays: 5, reliability: 0.8, extraDelay: 3, rejectRate: 0.02, priceFactor: 1.04 },
];

const DEPARTMENTS = [
  ["MAIN_KITCHEN", "NONE"],
  ["FB", "TANDOOR"],
  ["FB", "CONTINENTAL"],
  ["FB", "BAKERY"],
  ["FB", "CHINESE"],
  ["FB", "SOUTH_INDIAN"],
  ["FB", "NORTH_INDIAN"],
  ["FB", "IDLY_DOSA"],
  ["FB", "STAFF_FOOD"],
  ["HOUSEKEEPING", "NONE"],
  ["FRONT_OFFICE", "NONE"],
  ["BAR", "NONE"],
  ["MAINTENANCE", "NONE"],
];

// demand: mean units/day, cv: day-to-day variability, trend: market price drift over the period,
// season: amplitude of weekly price swing, vendors: [primary, alternate], depts: who requisitions it.
const ITEMS = [
  { sku: "VEG-ONI", itemName: "Onion", category: "VEGETABLE", uom: "kg", price: 38, demand: 28, cv: 0.25, trend: 0.35, season: 0.08, vendors: ["farm", "metro"], depts: ["MAIN_KITCHEN/NONE", "FB/NORTH_INDIAN", "FB/TANDOOR", "FB/STAFF_FOOD"], multiple: 5 },
  { sku: "VEG-TOM", itemName: "Tomato", category: "VEGETABLE", uom: "kg", price: 30, demand: 24, cv: 0.3, trend: -0.2, season: 0.15, vendors: ["farm", "metro"], depts: ["MAIN_KITCHEN/NONE", "FB/CONTINENTAL", "FB/NORTH_INDIAN", "FB/SOUTH_INDIAN"], multiple: 5 },
  { sku: "VEG-POT", itemName: "Potato", category: "VEGETABLE", uom: "kg", price: 26, demand: 20, cv: 0.2, trend: 0.05, season: 0.03, vendors: ["farm", "metro"], depts: ["MAIN_KITCHEN/NONE", "FB/STAFF_FOOD", "FB/CONTINENTAL"], multiple: 10 },
  { sku: "VEG-COR", itemName: "Coriander Leaves", category: "VEGETABLE", uom: "kg", price: 60, demand: 3, cv: 0.5, trend: 0.25, season: 0.2, vendors: ["farm"], depts: ["FB/NORTH_INDIAN", "FB/SOUTH_INDIAN", "FB/IDLY_DOSA"] },
  { sku: "GRO-RIC", itemName: "Basmati Rice", category: "GROCERY", uom: "kg", price: 95, demand: 18, cv: 0.15, trend: 0.04, season: 0.01, vendors: ["metro"], depts: ["MAIN_KITCHEN/NONE", "FB/NORTH_INDIAN", "FB/STAFF_FOOD"], multiple: 25 },
  { sku: "GRO-ATT", itemName: "Wheat Flour (Atta)", category: "GROCERY", uom: "kg", price: 42, demand: 15, cv: 0.2, trend: 0.02, season: 0.01, vendors: ["metro"], depts: ["FB/TANDOOR", "FB/BAKERY", "FB/STAFF_FOOD"], multiple: 10 },
  { sku: "GRO-OIL", itemName: "Sunflower Oil", category: "GROCERY", uom: "ltr", price: 145, demand: 9, cv: 0.2, trend: 0.12, season: 0.02, vendors: ["metro"], depts: ["MAIN_KITCHEN/NONE", "FB/CHINESE", "FB/SOUTH_INDIAN"], multiple: 15 },
  { sku: "GRO-URD", itemName: "Urad Dal", category: "GROCERY", uom: "kg", price: 128, demand: 5, cv: 0.3, trend: 0.06, season: 0.02, vendors: ["metro"], depts: ["FB/IDLY_DOSA", "FB/SOUTH_INDIAN"] },
  { sku: "DAI-MLK", itemName: "Full Cream Milk", category: "DAIRY", uom: "ltr", price: 62, demand: 45, cv: 0.15, trend: 0.03, season: 0.01, vendors: ["dairy", "metro"], depts: ["FB/BAKERY", "FB/CONTINENTAL", "MAIN_KITCHEN/NONE", "BAR/NONE"], multiple: 5 },
  { sku: "DAI-PAN", itemName: "Paneer", category: "DAIRY", uom: "kg", price: 360, demand: 6, cv: 0.35, trend: 0.05, season: 0.02, vendors: ["dairy"], depts: ["FB/TANDOOR", "FB/NORTH_INDIAN"] },
  { sku: "DAI-BUT", itemName: "Butter (Unsalted)", category: "DAIRY", uom: "kg", price: 520, demand: 4, cv: 0.3, trend: 0.08, season: 0.01, vendors: ["dairy", "metro"], depts: ["FB/BAKERY", "FB/CONTINENTAL"] },
  { sku: "CHK-CUR", itemName: "Chicken Curry Cut", category: "CHICKEN", uom: "kg", price: 240, demand: 14, cv: 0.35, trend: -0.1, season: 0.1, vendors: ["coastal"], depts: ["FB/TANDOOR", "FB/NORTH_INDIAN", "FB/CHINESE"] },
  { sku: "MUT-CUR", itemName: "Mutton Curry Cut", category: "MUTTON", uom: "kg", price: 780, demand: 5, cv: 0.45, trend: 0.06, season: 0.04, vendors: ["coastal"], depts: ["FB/NORTH_INDIAN", "FB/TANDOOR"] },
  { sku: "SEA-PRW", itemName: "Prawns (Medium)", category: "SEAFOOD", uom: "kg", price: 650, demand: 4, cv: 0.6, trend: 0.18, season: 0.12, vendors: ["coastal"], depts: ["FB/CONTINENTAL", "FB/CHINESE"] },
  { sku: "BAR-WHS", itemName: "Blended Whisky 750ml", category: "BAR", uom: "pcs", price: 1450, demand: 3, cv: 0.6, trend: 0.0, season: 0.0, vendors: ["spirits"], depts: ["BAR/NONE"], multiple: 12 },
  { sku: "BAR-SOD", itemName: "Soda 300ml", category: "BAR", uom: "pcs", price: 20, demand: 60, cv: 0.4, trend: 0.0, season: 0.0, vendors: ["spirits", "metro"], depts: ["BAR/NONE"], multiple: 24 },
  { sku: "LIN-BTW", itemName: "Bath Towel (White)", category: "LINEN", uom: "pcs", price: 420, demand: 4, cv: 0.5, trend: 0.02, season: 0.0, vendors: ["linen"], depts: ["HOUSEKEEPING/NONE"], multiple: 10 },
  { sku: "AME-SHP", itemName: "Shampoo Sachet 30ml", category: "AMENITIES", uom: "pcs", price: 9, demand: 140, cv: 0.2, trend: 0.0, season: 0.0, vendors: ["linen"], depts: ["HOUSEKEEPING/NONE"], multiple: 100 },
  { sku: "AME-SOP", itemName: "Guest Soap 40g", category: "AMENITIES", uom: "pcs", price: 12, demand: 130, cv: 0.2, trend: 0.0, season: 0.0, vendors: ["linen"], depts: ["HOUSEKEEPING/NONE"], multiple: 100 },
  { sku: "FO-KEY", itemName: "RFID Key Card", category: "FRONT_OFFICE", uom: "pcs", price: 55, demand: 6, cv: 0.7, trend: 0.0, season: 0.0, vendors: ["metro"], depts: ["FRONT_OFFICE/NONE"], multiple: 50 },
  { sku: "SPR-LED", itemName: "LED Bulb 9W", category: "SPARES", uom: "pcs", price: 110, demand: 2, cv: 0.9, trend: -0.03, season: 0.0, vendors: ["spares", "metro"], depts: ["MAINTENANCE/NONE"], multiple: 10 },
  // Dead stock: bought once at the start of the period and never requisitioned since.
  { sku: "BAR-LIQ", itemName: "Imported Liqueur 700ml (discontinued)", category: "BAR", uom: "pcs", price: 2850, demand: 0, initial: 18, cv: 0, trend: 0, season: 0, vendors: ["spirits"], depts: [] },
  { sku: "LIN-CVR", itemName: "Banquet Chair Cover (old colour)", category: "LINEN", uom: "pcs", price: 240, demand: 0, initial: 120, cv: 0, trend: 0, season: 0, vendors: ["linen"], depts: [] },
  { sku: "AME-DEC", itemName: "Festive Decor Kit", category: "AMENITIES", uom: "pcs", price: 1650, demand: 0, initial: 14, cv: 0, trend: 0, season: 0, vendors: ["linen"], depts: [] },
  { sku: "GRO-TRF", itemName: "Truffle Oil 250ml", category: "GROCERY", uom: "pcs", price: 1180, demand: 0, initial: 12, cv: 0, trend: 0.04, season: 0, vendors: ["metro"], depts: [] },
  { sku: "SPR-TST", itemName: "Toaster Element (old model)", category: "SPARES", uom: "pcs", price: 690, demand: 0, initial: 9, cv: 0, trend: 0, season: 0, vendors: ["spares"], depts: [] },
  { sku: "SPR-FLT", itemName: "AC Filter 18x24", category: "SPARES", uom: "pcs", price: 340, demand: 0.6, cv: 1.2, trend: 0.0, season: 0.0, vendors: ["spares"], depts: ["MAINTENANCE/NONE"] },
];

// Market price for an item on a given simulated day (0 = oldest).
const marketPrice = (spec, day) => {
  const drift = 1 + spec.trend * (day / HISTORY_DAYS);
  const wave = 1 + spec.season * Math.sin((2 * Math.PI * day) / 21);
  const noise = 1 + 0.02 * normal();
  return Math.round(spec.price * drift * wave * noise * 100) / 100;
};

const reset = async () => {
  await prisma.$transaction([
    prisma.inventoryTransaction.deleteMany(),
    prisma.priceQuote.deleteMany(),
    prisma.requisitionItem.deleteMany(),
    prisma.requisition.deleteMany(),
    prisma.purchaseOrderItem.deleteMany(),
    prisma.purchaseOrder.deleteMany(),
    prisma.outletStock.deleteMany(),
    prisma.centralStock.deleteMany(),
    prisma.item.deleteMany(),
    prisma.outletDepartment.deleteMany(),
    prisma.vendor.deleteMany(),
  ]);
};

const main = async () => {
  if (process.argv.includes("--reset")) await reset();
  else if ((await prisma.item.count()) > 0) {
    console.log("Database already has items; run with --reset to wipe and reseed.");
    return;
  }

  const password = process.env.SEED_PASSWORD || "ChangeMe123!";
  const passwordHash = await bcrypt.hash(password, 10);
  for (const [name, email, role] of [
    ["Hotel Admin", "admin@hotel.example", "admin"],
    ["Purchase Manager", "approver@hotel.example", "approver"],
    ["Store Keeper", "store@hotel.example", "user"],
  ]) {
    await prisma.user.upsert({ where: { email }, update: {}, create: { name, email, role, passwordHash } });
  }

  const vendorByKey = {};
  for (const v of VENDORS) {
    const { key, reliability, extraDelay, rejectRate, priceFactor, ...data } = v;
    vendorByKey[key] = { ...v, id: (await prisma.vendor.create({ data })).id };
  }
  const deptByKey = {};
  for (const [mainOutlet, subDepartment] of DEPARTMENTS) {
    deptByKey[`${mainOutlet}/${subDepartment}`] = (await prisma.outletDepartment.create({ data: { mainOutlet, subDepartment } })).id;
  }
  const items = [];
  for (const [i, spec] of ITEMS.entries()) {
    const item = await prisma.item.create({
      data: {
        sku: spec.sku,
        barcode: `890${String(1000000000 + i * 7919).slice(0, 10)}`,
        itemName: spec.itemName,
        category: spec.category,
        unitOfMeasure: spec.uom,
        costPrice: 0,
        minStockLevel: Math.ceil(spec.demand * 2),
        reorderPoint: Math.ceil(spec.demand * 4),
        maxStockLevel: Math.ceil(spec.demand * 10),
        orderMultiple: spec.multiple ?? 1,
        preferredVendorId: vendorByKey[spec.vendors[0]].id,
        centralStock: { create: {} },
      },
    });
    items.push({ ...spec, id: item.id, onHand: 0 });
  }

  const start = new Date(Date.now() - HISTORY_DAYS * DAY_MS);
  start.setHours(0, 0, 0, 0);
  const at = (day, hour) => new Date(start.getTime() + day * DAY_MS + hour * 60 * 60 * 1000);
  const pendingDeliveries = []; // { day, poId, vendor }
  const openOrderFor = new Set();

  const placeOrder = async (tx, day, vendor, lines) => {
    const po = await createInTx(tx, { vendorId: vendor.id, items: lines });
    const placed = at(day, 8);
    const poNumber = `PO-${placed.toISOString().slice(0, 10).replace(/-/g, "")}-${po.poNumber.slice(-6)}`;
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { createdAt: placed, poNumber } });
    await sendInTx(tx, po.id, at(day, 9));
    const late = rand() > vendor.reliability;
    const deliveryDay = day + vendor.leadTimeDays + (late ? 1 + Math.floor(rand() * vendor.extraDelay) : 0);
    pendingDeliveries.push({ day: deliveryDay, po, vendor });
    for (const l of lines) openOrderFor.add(l.itemId);
  };

  for (let day = 0; day <= HISTORY_DAYS; day++) {
    const isToday = day === HISTORY_DAYS;
    await prisma.$transaction(
      async (tx) => {
        // 1. Deliveries due today (receipts posted at 07:00; today's are left open).
        for (const delivery of pendingDeliveries.filter((d) => d.day === day && !isToday)) {
          await receiveInTx(tx, delivery.po.id, {
            receivedAt: at(day, 7),
            invoiceNumber: `INV-${Math.floor(rand() * 900000 + 100000)}`,
            lines: delivery.po.items.map((line) => {
              const ordered = Number(line.quantityOrdered);
              const rejected = rand() < delivery.vendor.rejectRate * 3 ? Math.ceil(ordered * 0.1) : 0;
              const shortShip = rand() < 0.08 ? Math.floor(ordered * 0.15) : 0;
              return {
                poItemId: line.id,
                quantityReceived: ordered - rejected - shortShip,
                quantityRejected: rejected,
                rejectionReason: rejected ? pick(["Damaged in transit", "Below quality spec", "Short shelf life"]) : undefined,
              };
            }),
          });
          for (const line of delivery.po.items) {
            openOrderFor.delete(line.itemId);
            const item = items.find((i) => i.id === line.itemId);
            item.onHand = Number((await tx.centralStock.findUnique({ where: { itemId: item.id } })).quantityOnHand);
          }
        }

        // 2. Market rates (perishables daily-ish, others weekly) and occasional vendor quotes.
        for (const item of items) {
          const perishable = ["VEGETABLE", "CHICKEN", "MUTTON", "SEAFOOD", "DAIRY"].includes(item.category);
          if (perishable ? rand() < 0.6 : day % 7 === 0) {
            await tx.priceQuote.create({
              data: { itemId: item.id, source: "MARKET_FEED", market: "City wholesale market", unitPrice: marketPrice(item, day), recordedAt: at(day, 6) },
            });
          }
          if (rand() < 0.04) {
            const vendor = vendorByKey[pick(item.vendors)];
            await tx.priceQuote.create({
              data: { itemId: item.id, vendorId: vendor.id, source: "VENDOR_QUOTE", unitPrice: Math.round(marketPrice(item, day) * vendor.priceFactor * 1.03 * 100) / 100, recordedAt: at(day, 11) },
            });
          }
        }

        // 3. Department requisitions, approved and issued the same morning
        //    (today's are left pending/approved so the workflow has something to act on).
        const weekendBoost = [0, 6].includes(at(day, 0).getDay()) ? 1.25 : 1;
        const byDept = new Map();
        for (const item of items) {
          // Weighed goods are requisitioned to 0.1 kg/ltr, counted goods in whole units.
          const step = ["kg", "ltr"].includes(item.uom) ? 10 : 1;
          const qty = Math.max(0, Math.round(item.demand * weekendBoost * (1 + item.cv * normal()) * step) / step);
          if (qty === 0) continue;
          const dept = pick(item.depts);
          if (!byDept.has(dept)) byDept.set(dept, []);
          byDept.get(dept).push({ item, qty });
        }
        for (const [dept, lines] of byDept) {
          const req = await tx.requisition.create({
            data: {
              requisitionNumber: `REQ-${at(day, 0).toISOString().slice(0, 10).replace(/-/g, "")}-${dept.replace(/\W/g, "").slice(0, 6)}${Math.floor(rand() * 1000)}`,
              outletDepartmentId: deptByKey[dept],
              requestedBy: `${dept.split("/")[1] === "NONE" ? dept.split("/")[0] : dept.split("/")[1]} supervisor`.toLowerCase(),
              createdAt: at(day, 9),
              items: { create: lines.map((l) => ({ itemId: l.item.id, quantityRequested: l.qty })) },
            },
            include: { items: true },
          });
          if (isToday) {
            if (rand() < 0.5) await tx.requisition.update({ where: { id: req.id }, data: { status: "APPROVED", approvedBy: "store manager", approvedAt: at(day, 10) } });
            continue;
          }
          await tx.requisition.update({ where: { id: req.id }, data: { status: "APPROVED", approvedBy: "store manager", approvedAt: at(day, 10) } });
          // Issue what is available; shortages are issued short.
          const issueLines = req.items.map((line) => {
            const item = items.find((i) => i.id === line.itemId);
            const qty = Math.min(Number(line.quantityRequested), item.onHand);
            item.onHand = Math.round((item.onHand - qty) * 1000) / 1000;
            return { requisitionItemId: line.id, quantityIssued: qty };
          });
          await issueInTx(tx, req.id, { lines: issueLines }, "store keeper", at(day, 11));
        }
        // Perishables occasionally spoil in the central store (~2% of daily demand).
        for (const item of items) {
          const perishable = ["VEGETABLE", "CHICKEN", "MUTTON", "SEAFOOD", "DAIRY"].includes(item.category);
          if (!perishable || isToday || rand() > 0.12) continue;
          const spoiled = Math.min(item.onHand, Math.round(item.demand * 0.15 * (0.5 + rand()) * 10) / 10);
          if (spoiled <= 0) continue;
          await issueFromCentral(tx, {
            itemId: item.id,
            quantity: spoiled,
            type: "WASTE",
            destination: "WASTE_BIN",
            remarks: pick(["Spoiled in cold room", "Past use-by date", "Damaged packaging"]),
            timestamp: at(day, 18),
          });
          item.onHand = Math.round((item.onHand - spoiled) * 1000) / 1000;
        }

        // Outlets consume what they were issued (issues are expensed to the department).
        await tx.outletStock.updateMany({ data: { quantityOnHand: 0 } });

        // 4. Store keeper's ordering habit: reorder when stock covers less than lead time + 3 days.
        //    Stop a few days before "today" for some items so the live plan shows reorder needs.
        const byVendor = new Map();
        for (const item of items) {
          const vendor = vendorByKey[rand() < 0.8 || item.vendors.length === 1 ? item.vendors[0] : item.vendors[1]];
          if (item.initial) {
            if (day === 0) {
              if (!byVendor.has(vendor.key)) byVendor.set(vendor.key, []);
              byVendor.get(vendor.key).push({ itemId: item.id, quantityOrdered: item.initial, unitPrice: Math.round(marketPrice(item, day) * vendor.priceFactor * 100) / 100 });
            }
            continue;
          }
          const cover = item.demand * (vendor.leadTimeDays + 3);
          if (openOrderFor.has(item.id) || item.onHand >= cover || isToday) continue;
          if (day > HISTORY_DAYS - 6 && item.sku.charCodeAt(4) % 2 === 0) continue;
          const qty = Math.ceil((item.demand * (vendor.leadTimeDays + 10) - item.onHand) / (item.multiple ?? 1)) * (item.multiple ?? 1);
          if (!byVendor.has(vendor.key)) byVendor.set(vendor.key, []);
          byVendor.get(vendor.key).push({
            itemId: item.id,
            quantityOrdered: qty,
            unitPrice: Math.round(marketPrice(item, day) * vendor.priceFactor * 100) / 100,
          });
        }
        for (const [key, lines] of byVendor) await placeOrder(tx, day, vendorByKey[key], lines);
      },
      { timeout: 60000 }
    );
    if (day % 20 === 0) console.log(`Simulated day ${day}/${HISTORY_DAYS}`);
  }

  // A few manual stock events for the log.
  await prisma.$transaction(async (tx) => {
    const { adjustCentral } = require("../src/services/ledger");
    const tomato = items.find((i) => i.sku === "VEG-TOM");
    const towel = items.find((i) => i.sku === "LIN-BTW");
    const tomatoStock = Number((await tx.centralStock.findUnique({ where: { itemId: tomato.id } })).quantityOnHand);
    if (tomatoStock >= 2.5) {
      await issueFromCentral(tx, { itemId: tomato.id, quantity: 2.5, type: "WASTE", destination: "WASTE_BIN", remarks: "Spoiled in cold room" });
    }
    await adjustCentral(tx, { itemId: towel.id, quantityChange: -2, remarks: "Physical count variance" }).catch(() => {});
  });

  console.log(`Demo logins: admin@hotel.example, approver@hotel.example, store@hotel.example / password "${password}"`);
  console.log(
    `Seeded ${VENDORS.length} vendors, ${DEPARTMENTS.length} departments, ${ITEMS.length} items, ` +
      `${await prisma.purchaseOrder.count()} purchase orders, ${await prisma.requisition.count()} requisitions, ` +
      `${await prisma.priceQuote.count()} price points.`
  );
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
