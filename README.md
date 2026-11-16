# Group Drive

When you drive somewhere in more than one car, it's easy to lose each other and spend the trip texting "where are you??" Group Drive links the cars with a single share link, so everyone sees every car, its route, and how far apart you are on one map.

![Group Drive: two cars and their routes to Phoenix Sky Harbor, with "shekhar · 1 min ahead" in the top bar](docs/screenshot.png)

**Demo:** https://group-drive.vercel.app (open it on two phones to try it with two cars)

**Status:** working prototype. Cars sync live, with routes, ETAs and alerts.

## Features

- **Share link:** pick a destination, create a trip, and send one link. No accounts.
- **Live cars on a map:** each car's dot updates every few seconds.
- **Route lines:** each car's route to the destination, in that car's color.
- **"X min behind" bar:** compares when each car will arrive.
- **Route-split alert:** a banner and a chime when another car takes a different route.
- **Leave Trip:** stop sharing and remove your car at any time.
- **Auto-stop on arrival:** sharing stops by itself within 100 m of the destination.

## Known limits

- **No traffic data in ETAs.** Routes come from the free OSRM server, which doesn't know about traffic.
- **Location stops when the phone is locked.** Web pages can't use GPS in the background, so keep the screen on.
- **Both cars get the split alert.** Each phone says the *other* car took a different route, because the app can't tell who turned off.

## Tech stack

- **[Leaflet](https://leafletjs.com/)** and **[OpenStreetMap](https://www.openstreetmap.org/)**: the map (free, no API key)
- **[Firebase Realtime Database](https://firebase.google.com/docs/database)**: syncs each car's location and route live
- **[OSRM](https://project-osrm.org/)**: routes and driving times
- **[Nominatim](https://nominatim.org/)**: destination search
- Plain HTML, CSS, and JavaScript. No build step.

## Run it locally

1. Clone the repo:
   ```
   git clone https://github.com/riyaubhe/group-drive.git
   cd group-drive
   ```
2. Start a local server. The app won't work if you just double-click `index.html`.
   ```
   python3 -m http.server 8000
   ```
3. Open http://localhost:8000, enter a car name, search for a destination and pick one, then click **Create Trip** and allow location access.
4. Copy the share link and open it in a private/incognito window to join as a second car.

To use your own Firebase project, put its settings in `firebase-config.js`.

## Learn more

The full product spec is in [docs/PRD.md](docs/PRD.md).
