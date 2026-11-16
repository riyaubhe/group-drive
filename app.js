// app.js: all the logic for Group Drive.
//
// How it works, in short:
//   1. The creator searches for a destination and creates a trip.
//      Others open the share link to join it.
//   2. Every 4 seconds, each phone sends its location to Firebase.
//   3. Every 30 seconds, each phone asks OSRM (a free routing server) for
//      ITS OWN route to the destination, and saves that route in Firebase.
//   4. Firebase tells every phone whenever any car moves or gets a new route.
//      We draw the cars, their routes, and the "4 min behind" bar.
//
// What gets saved in Firebase:
//   trips/
//     <tripId>/
//       createdAt: <time>
//       destination: { name, lat, lng }
//       cars/
//         <carId>: { name, color, lat, lng, speed, heading, updatedAt }
//       routes/
//         <carId>: { color, polyline, durationSec, computedAt }
//         (polyline is the route's shape, packed into a short piece of text)

// ---------- Load Firebase ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  get,
  remove,
  onValue,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// How often to send our location (milliseconds). The PRD says every 3 to 5 seconds.
const SEND_EVERY_MS = 4000;

// How often to ask OSRM for our route. The free server asks people not to
// send lots of requests, so once every 30 seconds is plenty.
const ROUTE_EVERY_MS = 30000;

// If we've driven this far since our last route (for example, took a different
// road), get a new route right away instead of waiting for the 30-second refresh.
const REROUTE_DISTANCE_M = 500;

// Never ask OSRM more than once every 5 seconds, no matter what.
const MIN_ROUTE_GAP_MS = 5000;

// Route-split alert (from the PRD): two cars count as "on different routes" when
// they're more than 100 m off each other's route for 30 seconds in a row.
const SPLIT_DISTANCE_M = 100;
const SPLIT_CONFIRM_MS = 30000;

// How long the "took a different route" banner stays up (it also has a × button).
const BANNER_SHOW_MS = 15000;

// Privacy (from the PRD): once you're this close to the destination,
// stop sharing your location automatically.
const ARRIVED_DISTANCE_M = 100;

// The most characters we'll save for one route (about 4 KB).
// Long trips get simplified more to fit; short trips keep almost every detail.
const MAX_ROUTE_CHARS = 4000;

// Each car gets one of these colors. Its dot, route line and ETA bar dot all use it.
const CAR_COLORS = ["#1a73e8", "#e8710a", "#188038", "#9334e6", "#d01884"];

// ---------- Find the parts of the page we need ----------
const startScreen = document.getElementById("start-screen");
const tripScreen = document.getElementById("trip-screen");
const nameInput = document.getElementById("name-input");
const destinationForm = document.getElementById("destination-form");
const destinationInput = document.getElementById("destination-input");
const destinationResults = document.getElementById("destination-results");
const createButton = document.getElementById("create-button");
const joinButton = document.getElementById("join-button");
const startStatus = document.getElementById("start-status");
const shareLinkInput = document.getElementById("share-link");
const copyButton = document.getElementById("copy-button");
const leaveButton = document.getElementById("leave-button");
const endScreen = document.getElementById("end-screen");
const endTitle = document.getElementById("end-title");
const newTripButton = document.getElementById("new-trip-button");
const etaBar = document.getElementById("eta-bar");
const locationStatus = document.getElementById("location-status");
const splitBanner = document.getElementById("split-banner");
const splitText = document.getElementById("split-text");
const splitCloseButton = document.getElementById("split-close");

// ---------- Which trip are we in, and which car are we? ----------

// If the address looks like ".../?trip=abc123", then tripId is "abc123".
// If there's no "?trip=", tripId is null, so we haven't joined a trip yet.
let tripId = new URLSearchParams(window.location.search).get("trip");

// Each phone gets its own random car ID. We save it in the browser,
// so refreshing the page keeps you as the same car instead of adding a new one.
let carId = localStorage.getItem("carId");
if (!carId) {
  carId = makeId();
  localStorage.setItem("carId", carId);
}

let myName = "";
let myColor = CAR_COLORS[0];
let destination = null; // { name, lat, lng }
let cars = {};   // the latest copy of trips/<tripId>/cars from Firebase
let routes = {}; // the latest copy of trips/<tripId>/routes from Firebase

// Phones' clocks can be a little off. Firebase tells us how far off ours is,
// so we can compare times fairly with other phones.
let serverTimeOffsetMs = 0;
onValue(ref(db, ".info/serverTimeOffset"), (snapshot) => {
  serverTimeOffsetMs = snapshot.val() || 0;
});

// Opened from a share link: show "Join trip" instead of the destination search and "Create Trip".
if (tripId) {
  createButton.hidden = true;
  destinationForm.hidden = true;
  joinButton.hidden = false;
  startStatus.textContent = "You've been invited to a Group Drive. Enter your car's name and tap Join.";

  // Look up where the trip is going, to show it in the invite message.
  get(ref(db, `trips/${tripId}/destination`)).then((snapshot) => {
    if (snapshot.exists()) {
      const place = shortPlaceName(snapshot.val().name);
      startStatus.textContent = `You've been invited to a Group Drive to ${place}. Enter your car's name and tap Join.`;
    }
  });
}

// ---------- Destination search (creating a trip) ----------

let chosenDestination = null;

// Runs when you tap "Search" or press Enter in the destination box.
destinationForm.addEventListener("submit", async (event) => {
  event.preventDefault(); // stop the browser from reloading the page

  const query = destinationInput.value.trim();
  if (!query) return;

  startStatus.textContent = "Searching…";
  destinationResults.replaceChildren(); // clear old results

  try {
    const places = await searchPlaces(query);
    startStatus.textContent = places.length
      ? "Pick your destination:"
      : "No places found. Try adding the city or state.";

    // Add one button per place to the results list.
    for (const place of places) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = place.name;
      button.addEventListener("click", () => chooseDestination(place));

      const item = document.createElement("li");
      item.append(button);
      destinationResults.append(item);
    }
  } catch (error) {
    startStatus.textContent = "Search isn't working right now. Try again in a moment.";
  }
});

// If you change the text after picking a place, you need to pick again.
destinationInput.addEventListener("input", () => {
  chosenDestination = null;
});

function chooseDestination(place) {
  chosenDestination = place;
  destinationInput.value = place.name;
  destinationResults.replaceChildren(); // hide the results
  startStatus.textContent = "";
}

// Asks OpenStreetMap's Nominatim service to turn an address into places on the map.
// Its rules say: only search when the person asks (no searching on every keystroke).
async function searchPlaces(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=" +
    encodeURIComponent(query);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Nominatim error ${response.status}`);

  const results = await response.json();
  return results.map((result) => ({
    name: result.display_name,
    lat: Number(result.lat),
    lng: Number(result.lon),
  }));
}

// ---------- Buttons ----------

createButton.addEventListener("click", async () => {
  unlockSound(); // browsers only allow sound after you tap something
  if (!chosenDestination) {
    startStatus.textContent = "Search for your destination and pick one first.";
    return;
  }

  tripId = makeId();

  // Save the new trip, with its destination, in Firebase.
  await set(ref(db, `trips/${tripId}`), {
    createdAt: serverTimestamp(),
    destination: chosenDestination,
  });

  // Put the trip ID in the address bar, so refreshing keeps you in the trip.
  history.replaceState(null, "", `?trip=${tripId}`);

  startTrip();
});

joinButton.addEventListener("click", () => {
  unlockSound(); // browsers only allow sound after you tap something
  startTrip();
});

splitCloseButton.addEventListener("click", hideSplitBanner);

// "Leave Trip" needs two taps, so you can't leave by bumping it by accident.
// The first tap changes it to "Tap again"; if you don't, it goes back after 3 seconds.
let leaveConfirming = false;
leaveButton.addEventListener("click", () => {
  if (leaveConfirming) {
    endTrip("You left the trip.");
    return;
  }
  leaveConfirming = true;
  leaveButton.textContent = "Tap again";
  setTimeout(() => {
    leaveConfirming = false;
    leaveButton.textContent = "Leave Trip";
  }, 3000);
});

// On the end screen: go back to the start screen (the same page, without "?trip=").
newTripButton.addEventListener("click", () => {
  window.location.href = window.location.pathname;
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(shareLinkInput.value);
  copyButton.textContent = "Copied!";
  setTimeout(() => (copyButton.textContent = "Copy link"), 2000);
});

// ---------- Start the trip ----------

async function startTrip() {
  // Use the name you typed, or something like "Car 3f9a" if you left it empty.
  myName = nameInput.value.trim() || `Car ${carId.slice(0, 4)}`;

  // Load the trip once: where it's going, and which cars are already in it.
  const trip = (await get(ref(db, `trips/${tripId}`))).val() || {};
  destination = trip.destination || null;
  myColor = pickMyColor(trip.cars || {});

  // Switch from the start screen to the trip screen.
  startScreen.hidden = true;
  tripScreen.hidden = false;

  // The share link is this page's address plus "?trip=<id>".
  shareLinkInput.value = `${window.location.origin}${window.location.pathname}?trip=${tripId}`;

  // If you were in this trip before (say you refreshed the page), your old route
  // is still saved and would give everyone a wrong ETA. Delete it; a fresh one
  // comes as soon as we know where you are.
  await remove(ref(db, `trips/${tripId}/routes/${carId}`));

  setUpMap();
  showDestination();
  listenForCars();
  listenForRoutes();
  startSendingLocation();
}

// Give each car a different color: the first one nobody in the trip is using yet.
function pickMyColor(existingCars) {
  // Rejoining after a refresh? Keep the color you already had.
  if (existingCars[carId]?.color) return existingCars[carId].color;

  const usedColors = Object.values(existingCars).map((car) => car.color);
  const freeColor = CAR_COLORS.find((color) => !usedColors.includes(color));
  return freeColor || CAR_COLORS[Object.keys(existingCars).length % CAR_COLORS.length];
}

// ---------- The map ----------

let map;
const markers = {};    // one dot per car, like { carId: marker }
const routeLines = {}; // one line per car, like { carId: line }
const routePoints = {}; // each car's route as [[lat, lng], ...], used to check for splits
let lastCarCount = 0;

function setUpMap() {
  // Start zoomed out over the US until we know where anyone is.
  map = L.map("map").setView([39.5, -98.35], 4);

  // Map images from OpenStreetMap. Free, and no API key needed.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  // A separate layer for route lines, underneath the car dots,
  // so a line never covers up a dot.
  map.createPane("routes").style.zIndex = 350;
}

// A pin at the destination, labeled with its name.
function showDestination() {
  if (!destination) return; // trips made before this feature have no destination

  L.marker([destination.lat, destination.lng])
    .bindTooltip(textLabel(shortPlaceName(destination.name)), { permanent: true })
    .addTo(map);
  map.setView([destination.lat, destination.lng], 12);
}

// Firebase runs this every time any car in the trip moves.
// onValue gives back a function that turns the listener off. We keep them here,
// so we can stop listening when we leave the trip.
const stopListeners = [];

function listenForCars() {
  const stop = onValue(ref(db, `trips/${tripId}/cars`), (snapshot) => {
    cars = snapshot.val() || {};

    // Add a dot for each new car, or move the dot of a car we already have.
    for (const [id, car] of Object.entries(cars)) {
      const position = [car.lat, car.lng];

      if (markers[id]) {
        markers[id].setLatLng(position);
      } else {
        const label = id === carId ? `${car.name} (you)` : car.name;
        markers[id] = L.circleMarker(position, {
          radius: 10,
          color: "white",
          weight: 3,
          fillColor: car.color || CAR_COLORS[0],
          fillOpacity: 1,
        })
          .bindTooltip(textLabel(label), {
            permanent: true, // always show the name, not just on hover
            direction: "top",
            offset: [0, -10],
          })
          .addTo(map);
      }
    }

    // Remove the dot of any car that's no longer in the trip.
    for (const id of Object.keys(markers)) {
      if (!cars[id]) {
        markers[id].remove();
        delete markers[id];
      }
    }

    // Zoom to fit everyone, but only when a car joins or leaves,
    // so the map doesn't jump around while you're looking at it.
    const carCount = Object.keys(markers).length;
    if (carCount !== lastCarCount) {
      zoomToEverything();
      lastCarCount = carCount;
    }

    updateEtaBar();
    checkForSplits();
  });
  stopListeners.push(stop);
}

// Firebase runs this every time any car saves a new route (about every 30 seconds per car).
function listenForRoutes() {
  const stop = onValue(ref(db, `trips/${tripId}/routes`), (snapshot) => {
    routes = snapshot.val() || {};

    // Draw each car's route, or update the line we already drew.
    for (const [id, route] of Object.entries(routes)) {
      const points = decodePolyline(route.polyline); // text → [[lat, lng], ...]
      routePoints[id] = points;

      if (routeLines[id]) {
        routeLines[id].setLatLngs(points);
      } else {
        routeLines[id] = L.polyline(points, {
          pane: "routes",
          color: route.color,
          weight: 6,
          opacity: 0.7,
        }).addTo(map);
      }
    }

    // Remove the line of any car whose route is gone.
    for (const id of Object.keys(routeLines)) {
      if (!routes[id]) {
        routeLines[id].remove();
        delete routeLines[id];
        delete routePoints[id];
      }
    }

    updateEtaBar();
    checkForSplits();
  });
  stopListeners.push(stop);
}

// Zoom so every car and the destination fit on screen.
function zoomToEverything() {
  const positions = Object.values(markers).map((marker) => marker.getLatLng());
  if (destination) positions.push([destination.lat, destination.lng]);

  if (positions.length === 1) {
    map.setView(positions[0], 15);
  } else if (positions.length > 1) {
    map.fitBounds(positions, { padding: [60, 60] });
  }
}

// ---------- The ETA bar ("Car 2 · 4 min behind") ----------

function updateEtaBar() {
  if (!destination) {
    etaBar.hidden = true;
    return;
  }
  etaBar.hidden = false;

  const myArrival = arrivalTime(routes[carId]);
  const items = [];

  // First: how long until I get there.
  if (myArrival) {
    const minutesLeft = Math.max(0, Math.round((myArrival - serverNow()) / 60000));
    items.push(etaItem(myColor, "You", `${minutesLeft} min to go`));
  } else {
    items.push(etaItem(myColor, "You", "Calculating…"));
  }

  // Then: every other car, compared to me.
  for (const [id, car] of Object.entries(cars)) {
    if (id === carId) continue;

    const theirArrival = arrivalTime(routes[id]);
    let text;
    if (!myArrival || !theirArrival) {
      // We need BOTH routes to compare. Until then, don't guess.
      text = "Calculating…";
    } else {
      // Positive = they'll get there after me (behind). Negative = before me (ahead).
      const minutesApart = Math.round((theirArrival - myArrival) / 60000);
      if (minutesApart > 0) text = `${minutesApart} min behind`;
      else if (minutesApart < 0) text = `${-minutesApart} min ahead`;
      else text = "with you";
    }
    items.push(etaItem(car.color, car.name, text));
  }

  if (Object.keys(cars).length <= 1) {
    items.push(etaItem("#9ca3af", "Waiting", "for other cars to join"));
  }

  etaBar.replaceChildren(...items);
}

// When a car will arrive, as a time (in milliseconds).
// We compare ARRIVAL times, not "minutes left", because each car refreshed its
// route at a different moment. Arrival times stay correct no matter when they were worked out.
function arrivalTime(route) {
  if (!route || typeof route.computedAt !== "number") return null;
  return route.computedAt + route.durationSec * 1000;
}

// Builds one "● Name · text" item for the ETA bar.
function etaItem(color, name, text) {
  const dot = document.createElement("span");
  dot.className = "eta-dot";
  dot.style.background = color;

  const nameEl = document.createElement("strong");
  nameEl.textContent = name;

  const item = document.createElement("span");
  item.className = "eta-item";
  item.append(dot, nameEl, ` · ${text}`);
  return item;
}

// ---------- Sending our location and route ----------

let latestPosition = null;

function startSendingLocation() {
  if (!("geolocation" in navigator)) {
    locationStatus.textContent = "This browser can't share your location.";
    return;
  }

  // watchPosition asks for permission once, then keeps giving us new positions.
  // We just remember the newest one here.
  // We save the IDs that watchPosition and setInterval give back,
  // so endTrip() can turn them off later.
  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      if (tripEnded) return;

      const isFirstPosition = latestPosition === null;
      latestPosition = position;
      locationStatus.textContent = "";

      // Close enough to the destination? Stop sharing.
      if (hasArrived()) {
        endTrip("You’ve arrived.");
        return;
      }

      if (isFirstPosition) sendLocation(); // show up on the map right away

      // Get a new route now if we don't have one yet, or we've moved a lot.
      if (needsNewRouteNow()) updateMyRoute();
    },
    (error) => {
      locationStatus.textContent = `Can't get your location: ${error.message}`;
    },
    { enableHighAccuracy: true } // use GPS, not just Wi-Fi
  );

  // Every few seconds, send the newest position to Firebase.
  sendTimer = setInterval(sendLocation, SEND_EVERY_MS);
  // Every 30 seconds, get a fresh route from OSRM.
  routeTimer = setInterval(updateMyRoute, ROUTE_EVERY_MS);
}

function sendLocation() {
  if (tripEnded) return; // we left; never send again
  if (!latestPosition) return; // no location yet

  const { latitude, longitude, speed, heading } = latestPosition.coords;

  set(ref(db, `trips/${tripId}/cars/${carId}`), {
    name: myName,
    color: myColor,
    lat: latitude,
    lng: longitude,
    speed: speed, // meters per second (can be empty)
    heading: heading, // direction in degrees, 0 = north (can be empty)
    updatedAt: serverTimestamp(), // Firebase fills in the time
  }).catch((error) => {
    locationStatus.textContent = `Couldn't send your location: ${error.message}`;
  });
}

let lastRoutePosition = null;   // where we were when we last got a route
let lastRouteRequestAt = 0;     // when we last asked OSRM (milliseconds)
let routeRequestInProgress = false;

// True if we have no route yet, or have moved more than 500 m since the last one.
function needsNewRouteNow() {
  if (lastRoutePosition === null) return true;

  const { latitude, longitude } = latestPosition.coords;
  const metersMoved = L.latLng(latitude, longitude).distanceTo(lastRoutePosition);
  return metersMoved > REROUTE_DISTANCE_M;
}

// Asks OSRM for the driving route from where I am to the destination,
// then saves it in Firebase so every phone can draw it.
// Each phone only asks for ITS OWN route. That's normally 1 request every 30 seconds,
// plus an extra one right away when we join or move more than 500 m.
async function updateMyRoute() {
  if (!destination || !latestPosition) return;

  // Don't ask again while we're still waiting for an answer,
  // or if we asked less than 5 seconds ago.
  if (routeRequestInProgress) return;
  if (Date.now() - lastRouteRequestAt < MIN_ROUTE_GAP_MS) return;
  routeRequestInProgress = true;
  lastRouteRequestAt = Date.now();

  const { latitude, longitude } = latestPosition.coords;

  // Careful: OSRM wants "longitude,latitude", the opposite order from Leaflet.
  const url =
    "https://router.project-osrm.org/route/v1/driving/" +
    `${longitude},${latitude};${destination.lng},${destination.lat}` +
    "?overview=full&geometries=geojson";

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.code !== "Ok") throw new Error(data.message || data.code);

    const route = data.routes[0];

    // OSRM gives [lng, lat] pairs; Leaflet wants [lat, lng]. Flip them.
    const points = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

    // If we left the trip while waiting for OSRM, don't save the route.
    if (tripEnded) return;

    await set(ref(db, `trips/${tripId}/routes/${carId}`), {
      color: myColor,
      polyline: shrinkRoute(points), // a few KB instead of ~60 KB
      durationSec: Math.round(route.duration), // OSRM's driving time, in seconds
      computedAt: serverTimestamp(),
    });

    // Remember where this route starts, to measure how far we move from here.
    lastRoutePosition = L.latLng(latitude, longitude);
  } catch (error) {
    locationStatus.textContent = `Couldn't get your route: ${error.message}`;
  } finally {
    routeRequestInProgress = false; // done, whether it worked or not
  }
}

// ---------- Helpers ----------

// Makes a random 12-character ID like "3f9a1c0b7e2d".
function makeId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

// "Sedona, Coconino County, Arizona, United States" → "Sedona"
function shortPlaceName(fullName) {
  return fullName.split(",")[0];
}

// The current time, corrected to match Firebase's clock.
function serverNow() {
  return Date.now() + serverTimeOffsetMs;
}

// ---------- Leaving the trip (Leave Trip button, or arriving) ----------

let tripEnded = false;
let gpsWatchId = null;
let sendTimer = null;
let routeTimer = null;

// True when we're within 100 m of the destination.
function hasArrived() {
  if (!destination || !latestPosition) return false;
  const { latitude, longitude } = latestPosition.coords;
  const metersLeft = L.latLng(latitude, longitude).distanceTo([destination.lat, destination.lng]);
  return metersLeft <= ARRIVED_DISTANCE_M;
}

// Stops sharing your location and takes your car out of the trip.
async function endTrip(message) {
  if (tripEnded) return; // already done
  tripEnded = true;

  // 1. Stop the GPS and both timers, so nothing new gets sent.
  if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
  clearInterval(sendTimer);
  clearInterval(routeTimer);

  // 2. Stop listening for the other cars.
  stopListeners.forEach((stop) => stop());

  // 3. Show the end screen, and take "?trip=" out of the address
  //    so refreshing the page doesn't put you back in the trip.
  endTitle.textContent = message;
  tripScreen.hidden = true;
  endScreen.hidden = false;
  history.replaceState(null, "", window.location.pathname);

  // 4. Delete your car and route from Firebase, so the other phones
  //    stop showing you (your dot, line and ETA disappear for them).
  await Promise.all([
    remove(ref(db, `trips/${tripId}/cars/${carId}`)),
    remove(ref(db, `trips/${tripId}/routes/${carId}`)),
  ]);
}

// ---------- Route-split alert ("Car B took a different route") ----------
//
// Two cars are "on the same route" unless EACH one is more than 100 m off the
// OTHER's route. Why both? If a friend is 2 km behind you on the same highway,
// they're not on YOUR route (it starts where you are), but you ARE on theirs.
//
// A split only counts after the cars were on the same route first. Otherwise,
// two cars starting from different towns would get an alert right away.
// And it has to last 30 seconds, so a quick detour or a GPS glitch doesn't count.

// For each other car: are we confirmed together, and since when has that
// looked like it's changing? Like { carId: { together: false, changingSince: null } }
const splitWatch = {};

// Runs every time a car moves or a route changes.
function checkForSplits() {
  const myRoute = routePoints[carId];
  if (!myRoute || !latestPosition) return; // no route yet, nothing to compare

  const me = [latestPosition.coords.latitude, latestPosition.coords.longitude];
  const now = Date.now();

  for (const [id, car] of Object.entries(cars)) {
    if (id === carId) continue;
    const theirRoute = routePoints[id];
    if (!theirRoute) continue;

    const theyAreOffMyRoute = distanceToRoute([car.lat, car.lng], myRoute) > SPLIT_DISTANCE_M;
    const iAmOffTheirRoute = distanceToRoute(me, theirRoute) > SPLIT_DISTANCE_M;
    const togetherNow = !(theyAreOffMyRoute && iAmOffTheirRoute);

    if (!splitWatch[id]) splitWatch[id] = { together: false, changingSince: null };
    const watch = splitWatch[id];

    if (togetherNow === watch.together) {
      // Nothing changed (or a short blip ended). Reset the 30-second timer.
      watch.changingSince = null;
      continue;
    }

    // It looks different from before. Start the timer, or check if it's been 30 seconds.
    if (watch.changingSince === null) watch.changingSince = now;
    if (now - watch.changingSince < SPLIT_CONFIRM_MS) continue;

    // It's lasted 30 seconds: make it official.
    watch.together = togetherNow;
    watch.changingSince = null;

    // Alert only when going from together → apart. Then this car can't alert
    // again until it's been back on our route for 30 seconds (a new split).
    if (!togetherNow) showSplitAlert(car);
  }
}

let hideBannerTimer = null;

function showSplitAlert(car) {
  splitText.textContent = `${car.name} took a different route`;
  splitBanner.style.borderLeftColor = car.color;
  splitBanner.hidden = false;
  map.invalidateSize(); // the map got shorter; tell Leaflet
  playAlertSound();

  // Hide it by itself after a while, so the driver never has to tap it.
  clearTimeout(hideBannerTimer);
  hideBannerTimer = setTimeout(hideSplitBanner, BANNER_SHOW_MS);
}

function hideSplitBanner() {
  splitBanner.hidden = true;
  map.invalidateSize(); // the map got taller again
}

// Shortest distance, in meters, from a point to a route line.
function distanceToRoute(point, route) {
  if (route.length === 1) return distanceToSegment(point, route[0], route[0]);

  let shortest = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    shortest = Math.min(shortest, distanceToSegment(point, route[i], route[i + 1]));
  }
  return shortest;
}

// Distance in meters from point p to the straight piece of road from a to b.
// Over short distances the earth is basically flat, so we turn
// latitude/longitude into meters (x = east, y = north, with p at 0,0).
function distanceToSegment(p, a, b) {
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = 111320 * Math.cos((p[0] * Math.PI) / 180);

  const ax = (a[1] - p[1]) * metersPerDegreeLng;
  const ay = (a[0] - p[0]) * metersPerDegreeLat;
  const bx = (b[1] - p[1]) * metersPerDegreeLng;
  const by = (b[0] - p[0]) * metersPerDegreeLat;

  // Find the spot on a→b closest to p (t = 0 is a, t = 1 is b).
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : -(ax * dx + ay * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(ax + t * dx, ay + t * dy);
}

// ---------- Alert sound ----------
//
// We make a short two-note chime with the browser's Web Audio feature,
// so there's no sound file to load.

let audioContext = null;

// Browsers block sound until you've tapped something on the page,
// so we call this from the Create/Join button.
function unlockSound() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = new AudioContextClass();
  }
  audioContext.resume();
}

function playAlertSound() {
  if (!audioContext) return;
  const start = audioContext.currentTime;

  // Two quick notes: high (880 Hz), then lower (660 Hz).
  [880, 660].forEach((frequency, i) => {
    const noteStart = start + i * 0.18;
    const oscillator = audioContext.createOscillator();
    const volume = audioContext.createGain();
    oscillator.frequency.value = frequency;

    // Fade in and out quickly so it doesn't click.
    volume.gain.setValueAtTime(0.0001, noteStart);
    volume.gain.exponentialRampToValueAtTime(0.3, noteStart + 0.02);
    volume.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.16);

    oscillator.connect(volume).connect(audioContext.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + 0.17);
  });
}

// ---------- Making routes small ----------
//
// OSRM gives thousands of points per route (Phoenix → Sedona: ~2,400).
// Most of them sit on straight stretches of road and don't change the line's shape.
// We shrink a route in two steps:
//   1. Simplify: drop points that are within a few meters of the line anyway.
//   2. Encode: pack the points into a short piece of text ("encoded polyline",
//      a standard format Google made for map routes).

// Returns the route as encoded text, at most MAX_ROUTE_CHARS long.
function shrinkRoute(points) {
  // Leaflet's simplify works on x/y points, so use x = longitude, y = latitude.
  const xyPoints = points.map(([lat, lng]) => L.point(lng, lat));

  // Start by allowing about 5 meters of wiggle (0.00005 degrees).
  // If the result is still too long, allow twice as much and try again.
  let tolerance = 0.00005;
  while (true) {
    const simplified = L.LineUtil.simplify(xyPoints, tolerance).map((p) => [p.y, p.x]);
    const encoded = encodePolyline(simplified);
    if (encoded.length <= MAX_ROUTE_CHARS) return encoded;
    tolerance *= 2;
  }
}

// Encoded polyline format (precision 5, about 1 meter).
// Each point is stored as the small CHANGE from the point before,
// written in a compact text alphabet. You don't need to follow the bit math;
// it's the same format Google Maps and OSRM use.
function encodePolyline(points) {
  let text = "";
  let prevLat = 0;
  let prevLng = 0;
  for (const [lat, lng] of points) {
    const latInt = Math.round(lat * 1e5);
    const lngInt = Math.round(lng * 1e5);
    text += encodeNumber(latInt - prevLat) + encodeNumber(lngInt - prevLng);
    prevLat = latInt;
    prevLng = lngInt;
  }
  return text;
}

function encodeNumber(number) {
  let value = number < 0 ? ~(number << 1) : number << 1;
  let text = "";
  while (value >= 0x20) {
    text += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
    value >>= 5;
  }
  return text + String.fromCharCode(value + 63);
}

// The reverse: encoded text → [[lat, lng], ...] for Leaflet to draw.
function decodePolyline(text) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  function readNumber() {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = text.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }

  while (index < text.length) {
    lat += readNumber();
    lng += readNumber();
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

// Wraps text for a map label. Using textContent (not HTML) means a car named
// something like "<script>" shows up as plain text instead of running as code.
function textLabel(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}
