// Where the itinerary lives. The repo is private, so naming it here gives
// nothing away -- without a token this address is a locked door.
export const REPO = {
  owner: "Saltydeer42",
  name: "japan-calendar",
  branch: "main",
  path: "data/itinerary.json",
};

// Bump to force every device to drop its cached shell on the next launch.
export const SHELL_VERSION = "2";

export const CATS = {
  travel: "Travel",
  stay: "Hotel",
  eat: "Eat",
  drink: "Drink",
  see: "See",
  shop: "Shop",
  book: "To book",
};

export const PILL_STYLES = {
  plain: "Plain",
  ref: "Reference",
  cash: "Cash",
  pend: "Pending",
  flash: "Tentative",
};
