# japan-calendar-app

The app shell for a private trip calendar. Published to GitHub Pages.

There is no itinerary in this repository and there never should be. The app
fetches `data/itinerary.json` from a separate **private** repo at runtime,
using a fine-grained token that lives only on the device.

Deployed from the private repo with `tools/deploy.sh`. Edit it there, not here.
