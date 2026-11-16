// app.js: all the logic for Group Drive.
//
// How it works, in short:
//   1. You create a trip (or open a share link to join one).
//   2. Your phone sends its location to Firebase every few seconds.
//   3. Firebase tells every phone in the trip whenever any car moves.
//   4. We draw each car as a dot on the map.
//
// What gets saved in Firebase:
//   trips/
//     <tripId>/
//       createdAt: <time>
//       cars/
//         <carId>: { name, lat, lng, speed, heading, updatedAt }

// ---------- Load Firebase ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  onValue,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// How often to send our location (milliseconds). The PRD says every 3 to 5 seconds.
const SEND_EVERY_MS = 4000;

// ---------- Find the parts of the page we need ----------
const startScreen = document.getElementById("start-screen");
const tripScreen = document.getElementById("trip-screen");
const nameInput = document.getElementById("name-input");
const createButton = document.getElementById("create-button");
const joinButton = document.getElementById("join-button");
const startStatus = document.getElementById("start-status");
const shareLinkInput = document.getElementById("share-link");
const copyButton = document.getElementById("copy-button");
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

// Opened from a share link: show "Join trip" instead of "Create a trip".
if (tripId) {
  createButton.hidden = true;
  joinButton.hidden = false;
  startStatus.textContent = "You've been invited to a Group Drive. Enter your car's name and tap Join.";
}

// ---------- Buttons ----------

createButton.addEventListener("click", async () => {
  tripId = makeId();

  // Save the new trip in Firebase.
  await set(ref(db, `trips/${tripId}/createdAt`), serverTimestamp());

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

function startTrip() {
  // Use the name you typed, or something like "Car 3f9a" if you left it empty.
  myName = nameInput.value.trim() || `Car ${carId.slice(0, 4)}`;

  // Switch from the start screen to the trip screen.
  startScreen.hidden = true;
  tripScreen.hidden = false;

  // The share link is this page's address plus "?trip=<id>".
  shareLinkInput.value = `${window.location.origin}${window.location.pathname}?trip=${tripId}`;

  setUpMap();
  listenForCars();
  startSendingLocation();
}

// ---------- The map ----------

let map;
const markers = {}; // one dot per car, like { carId: marker }
let lastCarCount = 0;

function setUpMap() {
  // Start zoomed out over the US until we know where anyone is.
  map = L.map("map").setView([39.5, -98.35], 4);

  // Map images from OpenStreetMap. Free, and no API key needed.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
}

// Firebase runs this every time any car in the trip changes.
function listenForCars() {
  const carsRef = ref(db, `trips/${tripId}/cars`);

  onValue(carsRef, (snapshot) => {
    const cars = snapshot.val() || {};

    // Add a dot for each new car, or move the dot of a car we already have.
    for (const [id, car] of Object.entries(cars)) {
      const position = [car.lat, car.lng];

      if (markers[id]) {
        markers[id].setLatLng(position);
      } else {
        const isMe = id === carId;
        markers[id] = L.circleMarker(position, {
          radius: 10,
          color: "white",
          weight: 3,
          fillColor: isMe ? "#1a73e8" : "#e8710a", // you are blue, other cars are orange
          fillOpacity: 1,
        })
          .bindTooltip(isMe ? `${car.name} (you)` : car.name, {
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
      zoomToAllCars();
      lastCarCount = carCount;
    }
  });
}

function zoomToAllCars() {
  const positions = Object.values(markers).map((marker) => marker.getLatLng());
  if (positions.length === 1) {
    map.setView(positions[0], 15);
  } else if (positions.length > 1) {
    map.fitBounds(positions, { padding: [60, 60] });
  }
}

// ---------- Sending our location ----------

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
      if (isFirstPosition) sendLocation(); // show up on the map right away
    },
    (error) => {
      locationStatus.textContent = `Can't get your location: ${error.message}`;
    },
    { enableHighAccuracy: true } // use GPS, not just Wi-Fi
  );

  // Every few seconds, send the newest position to Firebase.
  setInterval(sendLocation, SEND_EVERY_MS);
}

function sendLocation() {
  if (!latestPosition) return; // no location yet

  const { latitude, longitude, speed, heading } = latestPosition.coords;

  set(ref(db, `trips/${tripId}/cars/${carId}`), {
    name: myName,
    lat: latitude,
    lng: longitude,
    speed: speed, // meters per second (can be empty)
    heading: heading, // direction in degrees, 0 = north (can be empty)
    updatedAt: serverTimestamp(), // Firebase fills in the time
  }).catch((error) => {
    locationStatus.textContent = `Couldn't send your location: ${error.message}`;
  });
}

// ---------- Helpers ----------

// Makes a random 12-character ID like "3f9a1c0b7e2d".
function makeId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}
