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
const etaBar = document.getElementById("eta-bar");
const locationStatus = document.getElementById("location-status");

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
  startTrip();
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
function listenForCars() {
  onValue(ref(db, `trips/${tripId}/cars`), (snapshot) => {
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
  });
}

// Firebase runs this every time any car saves a new route (about every 30 seconds per car).
function listenForRoutes() {
  onValue(ref(db, `trips/${tripId}/routes`), (snapshot) => {
    routes = snapshot.val() || {};

    // Draw each car's route, or update the line we already drew.
    for (const [id, route] of Object.entries(routes)) {
      const points = decodePolyline(route.polyline); // text → [[lat, lng], ...]

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
      }
    }

    updateEtaBar();
  });
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
    items.push(etaItem(myColor, "You", "finding your route…"));
  }

  // Then: every other car, compared to me.
  for (const [id, car] of Object.entries(cars)) {
    if (id === carId) continue;

    const theirArrival = arrivalTime(routes[id]);
    let text;
    if (!myArrival || !theirArrival) {
      text = "finding route…";
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
  navigator.geolocation.watchPosition(
    (position) => {
      const isFirstPosition = latestPosition === null;
      latestPosition = position;
      locationStatus.textContent = "";
      if (isFirstPosition) {
        // Show up on the map, with a route, right away.
        sendLocation();
        updateMyRoute();
      }
    },
    (error) => {
      locationStatus.textContent = `Can't get your location: ${error.message}`;
    },
    { enableHighAccuracy: true } // use GPS, not just Wi-Fi
  );

  // Every few seconds, send the newest position to Firebase.
  setInterval(sendLocation, SEND_EVERY_MS);
  // Every 30 seconds, get a fresh route from OSRM.
  setInterval(updateMyRoute, ROUTE_EVERY_MS);
}

function sendLocation() {
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

// Asks OSRM for the driving route from where I am to the destination,
// then saves it in Firebase so every phone can draw it.
// Each phone only asks for ITS OWN route, so OSRM gets 1 request per car every 30 seconds.
async function updateMyRoute() {
  if (!destination || !latestPosition) return;

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

    await set(ref(db, `trips/${tripId}/routes/${carId}`), {
      color: myColor,
      polyline: shrinkRoute(points), // a few KB instead of ~60 KB
      durationSec: Math.round(route.duration), // OSRM's driving time, in seconds
      computedAt: serverTimestamp(),
    });
  } catch (error) {
    locationStatus.textContent = `Couldn't get your route: ${error.message}`;
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
