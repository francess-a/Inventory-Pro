const getItems = (req, res) => {
  res.json({ message: "Get items placeholder" });
};

const createItem = (req, res) => {
  res.json({ message: "Create item placeholder" });
};

const updateItem = (req, res) => {
  res.json({ message: "Update item placeholder" });
};

const deleteItem = (req, res) => {
  res.json({ message: "Delete item placeholder" });
};

module.exports = {
  getItems,
  createItem,
  updateItem,
  deleteItem,
};
