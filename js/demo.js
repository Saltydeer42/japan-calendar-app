/* Fabricated data for ?demo=1. Nothing here is real, and demo mode never
   touches the repo -- it exists so the app can be poked at (and its drag and
   editing checked) on a public URL without the itinerary being involved. */

export const DEMO_DOC = {
  version: 1,
  trip: {
    title: "Demo",
    dates: "A sample week",
    start: "2026-08-14",
    end: "2026-08-17",
  },
  notice: {
    title: "This is demo data",
    body: [
      "Nothing here is real and nothing you change is saved. Open the app "
      + "without <strong>?demo=1</strong> for the actual trip.",
    ],
  },
  legs: [
    { name: "Somewhere", meta: "Aug 14 to 16", color: "#0071E3" },
    { name: "Somewhere else", meta: "Aug 16 to 17", color: "#17876C" },
  ],
  cities: [
    { start: "2026-08-14", end: "2026-08-15", name: "First city" },
    { start: "2026-08-16", end: "2026-08-17", name: "Second city" },
  ],
  events: [
    {
      id: "demo-1", date: "2026-08-14", sort: 1000, cat: "travel",
      status: "locked", kicker: "Flight", time: "Evening", timeHard: false,
      title: "Sample flight", note: "An overnight, lands early.",
      place: "Haneda Airport, Tokyo", label: "Sample flight", pills: [],
    },
    {
      id: "demo-2", date: "2026-08-15", sort: 1000, cat: "eat",
      status: "tentative", kicker: "Lunch", time: "12:30 PM", timeHard: false,
      title: "Sample noodles", note: "Queues. No bookings.",
      place: "Shinjuku, Tokyo", label: "Sample noodles",
      pills: [{ text: "Cash", style: "cash" }],
    },
    {
      id: "demo-3", date: "2026-08-15", sort: 2000, cat: "see",
      status: "locked", kicker: "Ticket", time: "3:00 PM", timeHard: true,
      title: "Sample museum", note: "Timed entry.",
      place: "Ueno, Tokyo", label: "Sample museum",
      pills: [{ text: "Booked", style: "ref" }],
    },
    {
      id: "demo-4", date: "2026-08-16", sort: 1000, cat: "drink",
      status: "tentative", kicker: "Bar", time: "8:00 PM", timeHard: false,
      title: "Sample bar", note: "Small room, go early.",
      place: "Shibuya, Tokyo", label: "Sample bar", pills: [],
    },
    {
      id: "demo-5", date: "2026-08-17", sort: 1000, cat: "book",
      status: "todo", kicker: "To book", time: "Afternoon", timeHard: false,
      title: "Sample thing to book", note: "Still open.",
      place: "", label: "", pills: [{ text: "Not booked", style: "pend" }],
    },
  ],
  places: {
    title: "Saved spots",
    sub: "A sample list of places, none of them booked.",
    buckets: [
      { key: "no-day", heading: "No day for these yet", status: "you", label: "No slot" },
    ],
    items: [
      { id: "demo-p1", name: "Sample coffee", cat: "drink", kind: "Coffee",
        area: "Sample ward", city: "Tokyo", date: "2026-08-15",
        note: "A sample saved spot. Tap the row on the day to get here." },
      { id: "demo-p2", name: "Sample shop", cat: "shop", kind: "Vintage",
        area: "Sample ward", city: "Tokyo", date: "2026-08-15" },
      { id: "demo-p3", name: "Sample garden", cat: "see", kind: "Garden",
        area: "Another ward", city: "Tokyo", date: "2026-08-16", tentative: true,
        note: "Marked unconfirmed, because the area is a guess." },
      { id: "demo-p4", name: "Sample far-away thing", cat: "see", kind: "Museum",
        area: "Miles away", city: "Elsewhere", bucket: "no-day",
        note: "Saved, but nowhere near this trip." },
    ],
  },
  board: {
    title: "Needs booking",
    sub: "A sample board.",
    groups: [
      {
        heading: "Sample group",
        rows: [
          { status: "you", label: "Book now", what: "Sample item",
            why: "A sample reason." },
          { status: "done", label: "Done", what: "Sample done item",
            why: "Nothing to do." },
        ],
      },
    ],
  },
  rules: {
    title: "Sample rules",
    items: ["A sample rule about <strong>cash</strong>."],
  },
};
