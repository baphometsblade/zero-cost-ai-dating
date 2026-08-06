/* ==========================================================================
   Zero Cost AI Dating — bundled seed data
   GENERATED FILE — DO NOT EDIT BY HAND.
   Source: seed/profiles.json (version 1, 48 interest tags, 32 profiles,
   9 inbound likes, 2 conversations).
   Regenerate with `npm run build:seed`; `npm run check:seed` fails when this
   file has drifted from the JSON.

   Every person in here is fictional. Nothing carries a timestamp: profiles
   carry `lastActiveOffsetHours` and the relationships carry `offsetHours`,
   both counted back from seed time, so the demo never looks abandoned.
   ZC.store turns the offsets into real ISO dates when it seeds.
   Exposes: ZC.SEED_VERSION, ZC.INTEREST_TAGS, ZC.INTEREST_BY_SLUG,
   ZC.SEED_PROFILES, ZC.SEED_INBOUND_LIKES, ZC.SEED_CONVERSATIONS (and the
   same object via module.exports under Node).
   ========================================================================== */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ZC = root.ZC || {};
  root.ZC.SEED_VERSION = api.SEED_VERSION;
  root.ZC.INTEREST_TAGS = api.INTEREST_TAGS;
  root.ZC.INTEREST_BY_SLUG = api.INTEREST_BY_SLUG;
  root.ZC.SEED_PROFILES = api.SEED_PROFILES;
  root.ZC.SEED_INBOUND_LIKES = api.SEED_INBOUND_LIKES;
  root.ZC.SEED_CONVERSATIONS = api.SEED_CONVERSATIONS;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The canonical interest table: 48 tags across 10 categories.
  // The slug is the stable identifier everything else keys off; label and
  // emoji are display-only.
  const INTEREST_TAGS = [
    { "slug": "hiking", "label": "Hiking", "emoji": "🥾", "category": "outdoors" },
    { "slug": "camping", "label": "Camping", "emoji": "⛺", "category": "outdoors" },
    { "slug": "climbing", "label": "Climbing", "emoji": "🧗", "category": "outdoors" },
    { "slug": "kayaking", "label": "Kayaking", "emoji": "🛶", "category": "outdoors" },
    { "slug": "birding", "label": "Birdwatching", "emoji": "🐦", "category": "outdoors" },
    { "slug": "painting", "label": "Painting", "emoji": "🎨", "category": "arts" },
    { "slug": "photography", "label": "Photography", "emoji": "📷", "category": "arts" },
    { "slug": "film", "label": "Film", "emoji": "🎬", "category": "arts" },
    { "slug": "poetry", "label": "Poetry", "emoji": "✍️", "category": "arts" },
    { "slug": "theatre", "label": "Theatre", "emoji": "🎭", "category": "arts" },
    { "slug": "cooking", "label": "Cooking", "emoji": "🍳", "category": "food" },
    { "slug": "baking", "label": "Baking", "emoji": "🥐", "category": "food" },
    { "slug": "coffee", "label": "Coffee", "emoji": "☕", "category": "food" },
    { "slug": "wine", "label": "Wine", "emoji": "🍷", "category": "food" },
    { "slug": "street-food", "label": "Street food", "emoji": "🌮", "category": "food" },
    { "slug": "live-music", "label": "Live music", "emoji": "🎤", "category": "music" },
    { "slug": "vinyl", "label": "Vinyl", "emoji": "💿", "category": "music" },
    { "slug": "guitar", "label": "Guitar", "emoji": "🎸", "category": "music" },
    { "slug": "jazz", "label": "Jazz", "emoji": "🎷", "category": "music" },
    { "slug": "electronic", "label": "Electronic", "emoji": "🎧", "category": "music" },
    { "slug": "running", "label": "Running", "emoji": "👟", "category": "fitness" },
    { "slug": "yoga", "label": "Yoga", "emoji": "🧘", "category": "fitness" },
    { "slug": "cycling", "label": "Cycling", "emoji": "🚴", "category": "fitness" },
    { "slug": "lifting", "label": "Lifting", "emoji": "🏋️", "category": "fitness" },
    { "slug": "swimming", "label": "Swimming", "emoji": "🏊", "category": "fitness" },
    { "slug": "coding", "label": "Coding", "emoji": "💻", "category": "tech" },
    { "slug": "gaming", "label": "Gaming", "emoji": "🎮", "category": "tech" },
    { "slug": "robotics", "label": "Robotics", "emoji": "🤖", "category": "tech" },
    { "slug": "astronomy", "label": "Astronomy", "emoji": "🔭", "category": "tech" },
    { "slug": "tinkering", "label": "Tinkering", "emoji": "🔧", "category": "tech" },
    { "slug": "road-trips", "label": "Road trips", "emoji": "🚐", "category": "travel" },
    { "slug": "backpacking", "label": "Backpacking", "emoji": "🎒", "category": "travel" },
    { "slug": "languages", "label": "Languages", "emoji": "🗣️", "category": "travel" },
    { "slug": "city-breaks", "label": "City breaks", "emoji": "🏙️", "category": "travel" },
    { "slug": "train-travel", "label": "Train travel", "emoji": "🚆", "category": "travel" },
    { "slug": "reading", "label": "Reading", "emoji": "📚", "category": "homebody" },
    { "slug": "gardening", "label": "Gardening", "emoji": "🌱", "category": "homebody" },
    { "slug": "board-games", "label": "Board games", "emoji": "🎲", "category": "homebody" },
    { "slug": "knitting", "label": "Knitting", "emoji": "🧶", "category": "homebody" },
    { "slug": "puzzles", "label": "Puzzles", "emoji": "🧩", "category": "homebody" },
    { "slug": "dancing", "label": "Dancing", "emoji": "💃", "category": "social" },
    { "slug": "karaoke", "label": "Karaoke", "emoji": "🎙️", "category": "social" },
    { "slug": "volunteering", "label": "Volunteering", "emoji": "🤝", "category": "social" },
    { "slug": "trivia", "label": "Trivia nights", "emoji": "🧠", "category": "social" },
    { "slug": "meditation", "label": "Meditation", "emoji": "🪷", "category": "mindful" },
    { "slug": "journaling", "label": "Journaling", "emoji": "📓", "category": "mindful" },
    { "slug": "philosophy", "label": "Philosophy", "emoji": "💭", "category": "mindful" },
    { "slug": "tea", "label": "Tea", "emoji": "🍵", "category": "mindful" }
  ];

  // Slug -> tag lookup, built once so callers never scan the array.
  const INTEREST_BY_SLUG = INTEREST_TAGS.reduce(function (map, tag) {
    map[tag.slug] = tag;
    return map;
  }, {});

  // The bundled demo cast. `demo-you` is first: it is the account
  // ZC.auth.signInAsDemoUser() signs into.
  const SEED_PROFILES = [
    {
      "uid": "demo-you",
      "email": "you@example.com",
      "displayName": "You",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-07-28T17:04:00.000Z",
      "updatedAt": "2026-08-04T09:12:00.000Z",
      "lastActiveOffsetHours": 0.5,
      "profile": {
        "birthdate": "1995-02-19",
        "age": 31,
        "gender": "woman",
        "pronouns": "she/they",
        "bio": "Six years in Portland and still finding trails I have never walked. I make a serious pour-over, buy more records than I have shelf space for, and I will cook for you by the second date.",
        "photos": [],
        "interests": [
          "hiking",
          "coffee",
          "vinyl",
          "cooking",
          "reading",
          "live-music",
          "photography",
          "cycling"
        ],
        "personality": {
          "openness": 78,
          "conscientiousness": 62,
          "extraversion": 55,
          "agreeableness": 72,
          "stability": 66
        },
        "location": {
          "label": "Portland, OR",
          "lat": 45.5152,
          "lng": -122.6784
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "man",
          "nonbinary",
          "other"
        ],
        "ageMin": 25,
        "ageMax": 44,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "maya-okonkwo",
      "email": "maya@example.com",
      "displayName": "Maya O.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-02-11T19:30:00.000Z",
      "updatedAt": "2026-07-30T15:02:00.000Z",
      "lastActiveOffsetHours": 3,
      "profile": {
        "birthdate": "1997-01-08",
        "age": 29,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "Structural engineer, so I look at bridges the way other people look at dogs. Most weekends start with a trail run and end with a burrito bigger than my forearm.",
        "photos": [],
        "interests": [
          "running",
          "hiking",
          "street-food",
          "coffee",
          "board-games",
          "cycling"
        ],
        "personality": {
          "openness": 66,
          "conscientiousness": 88,
          "extraversion": 48,
          "agreeableness": 70,
          "stability": 76
        },
        "location": {
          "label": "Portland, OR",
          "lat": 45.5426,
          "lng": -122.6544
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary"
        ],
        "ageMin": 25,
        "ageMax": 38,
        "maxDistanceKm": 60,
        "notifications": true,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "devin-alvarez",
      "email": "devin@example.com",
      "displayName": "Devin A.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2025-12-03T02:48:00.000Z",
      "updatedAt": "2026-07-25T18:20:00.000Z",
      "lastActiveOffsetHours": 27,
      "profile": {
        "birthdate": "1993-06-30",
        "age": 33,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "I bake sourdough on a schedule my last partner described as concerning, and I stand by it. The starter is four years old and her name is Brenda.",
        "photos": [],
        "interests": [
          "baking",
          "cooking",
          "gardening",
          "board-games",
          "coffee",
          "reading"
        ],
        "personality": {
          "openness": 61,
          "conscientiousness": 79,
          "extraversion": 44,
          "agreeableness": 81,
          "stability": 68
        },
        "location": {
          "label": "Portland, OR",
          "lat": 45.4993,
          "lng": -122.636
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman"
        ],
        "ageMin": 26,
        "ageMax": 40,
        "maxDistanceKm": 80,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "priya-raghunathan",
      "email": "priya@example.com",
      "displayName": "Priya R.",
      "profileComplete": true,
      "plan": "premium",
      "planSince": "2026-03-02T09:15:00.000Z",
      "createdAt": "2026-01-19T14:05:00.000Z",
      "updatedAt": "2026-08-01T07:41:00.000Z",
      "lastActiveOffsetHours": 9,
      "profile": {
        "birthdate": "1990-11-02",
        "age": 35,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "ICU nurse working three-day stretches, so my Thursdays are your Saturdays. I garden aggressively and lose every argument I have with my tomatoes.",
        "photos": [],
        "interests": [
          "gardening",
          "cooking",
          "reading",
          "yoga",
          "wine",
          "birding"
        ],
        "personality": {
          "openness": 58,
          "conscientiousness": 91,
          "extraversion": 63,
          "agreeableness": 85,
          "stability": 72
        },
        "location": {
          "label": "Vancouver, WA",
          "lat": 45.6387,
          "lng": -122.6615
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "man",
          "woman"
        ],
        "ageMin": 30,
        "ageMax": 46,
        "maxDistanceKm": 80,
        "notifications": true,
        "theme": "light",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {
          "gardening": 0.51,
          "cooking": 0.36,
          "wine": 0.22,
          "gaming": -0.18
        },
        "likeCount": 18,
        "passCount": 11
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "theo-lindqvist",
      "email": "theo@example.com",
      "displayName": "Theo L.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-05-22T23:11:00.000Z",
      "updatedAt": "2026-07-31T21:36:00.000Z",
      "lastActiveOffsetHours": 1.5,
      "profile": {
        "birthdate": "2001-04-17",
        "age": 25,
        "gender": "man",
        "pronouns": "he/they",
        "bio": "Bike messenger turned bike mechanic. I know every pothole downtown by name, and I will fix your brakes for free if you buy the tacos.",
        "photos": [],
        "interests": [
          "cycling",
          "tinkering",
          "street-food",
          "electronic",
          "gaming",
          "coffee"
        ],
        "personality": {
          "openness": 72,
          "conscientiousness": 46,
          "extraversion": 81,
          "agreeableness": 67,
          "stability": 58
        },
        "location": {
          "label": "Portland, OR",
          "lat": 45.5231,
          "lng": -122.6912
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary",
          "other"
        ],
        "ageMin": 21,
        "ageMax": 33,
        "maxDistanceKm": 40,
        "notifications": true,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "nadia-haddad",
      "email": "nadia@example.com",
      "displayName": "Nadia H.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2025-09-14T11:27:00.000Z",
      "updatedAt": "2026-07-19T08:55:00.000Z",
      "lastActiveOffsetHours": 96,
      "profile": {
        "birthdate": "1988-09-12",
        "age": 37,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "I translate contracts by day and bad poetry by night; only one of those pays. A rainy Sunday, a used bookstore and no particular plan is the entire pitch.",
        "photos": [],
        "interests": [
          "reading",
          "poetry",
          "coffee",
          "philosophy",
          "languages",
          "tea"
        ],
        "personality": {
          "openness": 84,
          "conscientiousness": 65,
          "extraversion": 31,
          "agreeableness": 74,
          "stability": 52
        },
        "location": {
          "label": "Seattle, WA",
          "lat": 47.6205,
          "lng": -122.3493
        },
        "showAge": true,
        "showDistance": false
      },
      "preferences": {
        "interestedIn": [
          "man"
        ],
        "ageMin": 33,
        "ageMax": 50,
        "maxDistanceKm": 120,
        "notifications": true,
        "theme": "light",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "sam-whitfield",
      "email": "sam@example.com",
      "displayName": "Sam W.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-03-08T05:19:00.000Z",
      "updatedAt": "2026-08-02T13:48:00.000Z",
      "lastActiveOffsetHours": 14,
      "profile": {
        "birthdate": "1994-03-25",
        "age": 32,
        "gender": "nonbinary",
        "pronouns": "they/them",
        "bio": "Sound engineer for small rooms, which means I have already heard your favourite band's soundcheck. I keep a serious list of the best places in town to eat alone.",
        "photos": [],
        "interests": [
          "live-music",
          "vinyl",
          "electronic",
          "street-food",
          "film",
          "tinkering"
        ],
        "personality": {
          "openness": 80,
          "conscientiousness": 58,
          "extraversion": 42,
          "agreeableness": 69,
          "stability": 63
        },
        "location": {
          "label": "Portland, OR",
          "lat": 45.5581,
          "lng": -122.6501
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary"
        ],
        "ageMin": 26,
        "ageMax": 42,
        "maxDistanceKm": 75,
        "notifications": true,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "grace-tanaka-boyd",
      "email": "grace@example.com",
      "displayName": "Grace T.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-06-30T16:42:00.000Z",
      "updatedAt": "2026-07-28T20:03:00.000Z",
      "lastActiveOffsetHours": 51,
      "profile": {
        "birthdate": "1999-12-04",
        "age": 26,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "Illustrator with a permanent ink stain on my left hand. I am looking for someone who will go to the aquarium on a Tuesday and take it completely seriously.",
        "photos": [],
        "interests": [
          "painting",
          "photography",
          "film",
          "reading",
          "swimming",
          "knitting"
        ],
        "personality": {
          "openness": 88,
          "conscientiousness": 54,
          "extraversion": 37,
          "agreeableness": 78,
          "stability": 49
        },
        "location": {
          "label": "Seattle, WA",
          "lat": 47.6615,
          "lng": -122.3131
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "man",
          "nonbinary"
        ],
        "ageMin": 23,
        "ageMax": 35,
        "maxDistanceKm": 50,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "marcus-deleon",
      "email": "marcus@example.com",
      "displayName": "Marcus D.",
      "profileComplete": true,
      "plan": "premium",
      "planSince": "2026-05-18T22:40:00.000Z",
      "createdAt": "2025-10-25T20:16:00.000Z",
      "updatedAt": "2026-07-22T17:29:00.000Z",
      "lastActiveOffsetHours": 120,
      "profile": {
        "birthdate": "1985-07-19",
        "age": 41,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "Middle school science teacher — twenty-eight kids think I am hilarious, which is either a great sign or a terrible one. I run slow and cook fast.",
        "photos": [],
        "interests": [
          "running",
          "cooking",
          "astronomy",
          "board-games",
          "camping"
        ],
        "personality": {
          "openness": 63,
          "conscientiousness": 76,
          "extraversion": 74,
          "agreeableness": 83,
          "stability": 79
        },
        "location": {
          "label": "Oakland, CA",
          "lat": 37.8044,
          "lng": -122.2712
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman"
        ],
        "ageMin": 32,
        "ageMax": 48,
        "maxDistanceKm": 60,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {
          "running": 0.42,
          "cooking": 0.31,
          "camping": 0.18,
          "karaoke": -0.24
        },
        "likeCount": 14,
        "passCount": 9
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "rin-matsuda",
      "email": "rin@example.com",
      "displayName": "Rin M.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-04-02T09:03:00.000Z",
      "updatedAt": "2026-08-03T04:17:00.000Z",
      "lastActiveOffsetHours": 6,
      "profile": {
        "birthdate": "1996-05-08",
        "age": 30,
        "gender": "nonbinary",
        "pronouns": "they/them",
        "bio": "I write firmware for telescopes, the nerdiest sentence I own, and I am not sorry about it. I would like someone to drive out past the light pollution with.",
        "photos": [],
        "interests": [
          "astronomy",
          "coding",
          "robotics",
          "camping",
          "road-trips",
          "gaming",
          "tea"
        ],
        "personality": {
          "openness": 91,
          "conscientiousness": 70,
          "extraversion": 35,
          "agreeableness": 66,
          "stability": 61
        },
        "location": {
          "label": "San Francisco, CA",
          "lat": 37.7599,
          "lng": -122.4148
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "man",
          "nonbinary",
          "other"
        ],
        "ageMin": 25,
        "ageMax": 40,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "bea-ferreira",
      "email": "bea@example.com",
      "displayName": "Bea F.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-02-27T22:38:00.000Z",
      "updatedAt": "2026-07-27T12:09:00.000Z",
      "lastActiveOffsetHours": 40,
      "profile": {
        "birthdate": "1992-02-14",
        "age": 34,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "Born on Valentine's Day, which set expectations I have failed to meet ever since. I climb badly, dance well, and make an unreasonable quantity of pasta.",
        "photos": [],
        "interests": [
          "climbing",
          "dancing",
          "cooking",
          "wine",
          "languages",
          "film"
        ],
        "personality": {
          "openness": 77,
          "conscientiousness": 48,
          "extraversion": 86,
          "agreeableness": 72,
          "stability": 55
        },
        "location": {
          "label": "San Francisco, CA",
          "lat": 37.7849,
          "lng": -122.4094
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman"
        ],
        "ageMin": 28,
        "ageMax": 45,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "jonah-kimball",
      "email": "jonah@example.com",
      "displayName": "Jonah K.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2025-08-30T13:52:00.000Z",
      "updatedAt": "2026-07-16T19:44:00.000Z",
      "lastActiveOffsetHours": 168,
      "profile": {
        "birthdate": "1979-10-22",
        "age": 46,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "Nine seasons on a wildland fire crew; now I teach other people how to do it without getting hurt. Two dogs, one banjo, no interest in pretending I like cities.",
        "photos": [],
        "interests": [
          "camping",
          "hiking",
          "guitar",
          "birding",
          "road-trips",
          "kayaking"
        ],
        "personality": {
          "openness": 55,
          "conscientiousness": 82,
          "extraversion": 51,
          "agreeableness": 64,
          "stability": 84
        },
        "location": {
          "label": "Denver, CO",
          "lat": 39.7392,
          "lng": -104.9903
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary"
        ],
        "ageMin": 35,
        "ageMax": 55,
        "maxDistanceKm": 200,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "amara-osei",
      "email": "amara@example.com",
      "displayName": "Amara O.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-05-06T07:21:00.000Z",
      "updatedAt": "2026-08-01T14:58:00.000Z",
      "lastActiveOffsetHours": 20,
      "profile": {
        "birthdate": "1998-08-30",
        "age": 27,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "Pastry cook, so I am asleep while you are at happy hour and awake when the city is finally quiet. Meet me for breakfast and I will bring the good croissants.",
        "photos": [],
        "interests": [
          "baking",
          "coffee",
          "cooking",
          "running",
          "journaling"
        ],
        "personality": {
          "openness": 69,
          "conscientiousness": 85,
          "extraversion": 46,
          "agreeableness": 76,
          "stability": 67
        },
        "location": {
          "label": "Chicago, IL",
          "lat": 41.8919,
          "lng": -87.6278
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "man",
          "woman"
        ],
        "ageMin": 24,
        "ageMax": 36,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "light",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "elliot-vance",
      "email": "elliot@example.com",
      "displayName": "Elliot V.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-01-04T18:33:00.000Z",
      "updatedAt": "2026-07-24T10:26:00.000Z",
      "lastActiveOffsetHours": 78,
      "profile": {
        "birthdate": "1991-01-27",
        "age": 35,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "I restore old radios nobody asked me to restore, and my apartment hums. Take me to a museum and I will read every placard out loud, unprompted.",
        "photos": [],
        "interests": [
          "tinkering",
          "vinyl",
          "jazz",
          "reading",
          "puzzles",
          "photography"
        ],
        "personality": {
          "openness": 74,
          "conscientiousness": 67,
          "extraversion": 28,
          "agreeableness": 71,
          "stability": 60
        },
        "location": {
          "label": "Chicago, IL",
          "lat": 41.85,
          "lng": -87.65
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman"
        ],
        "ageMin": 29,
        "ageMax": 42,
        "maxDistanceKm": 250,
        "notifications": false,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "simone-beaulieu",
      "email": "simone@example.com",
      "displayName": "Simone B.",
      "profileComplete": true,
      "plan": "premium",
      "planSince": "2025-11-27T16:05:00.000Z",
      "createdAt": "2025-11-12T15:47:00.000Z",
      "updatedAt": "2026-07-29T16:31:00.000Z",
      "lastActiveOffsetHours": 33,
      "profile": {
        "birthdate": "1968-03-11",
        "age": 58,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "Retired from the stage, not from the drama. I direct community theatre now and I am happier than I have any right to be. Feed me, then argue with me.",
        "photos": [],
        "interests": [
          "theatre",
          "wine",
          "film",
          "poetry",
          "dancing",
          "cooking",
          "reading"
        ],
        "personality": {
          "openness": 89,
          "conscientiousness": 60,
          "extraversion": 92,
          "agreeableness": 68,
          "stability": 71
        },
        "location": {
          "label": "Brooklyn, NY",
          "lat": 40.6782,
          "lng": -73.9442
        },
        "showAge": false,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "man",
          "woman"
        ],
        "ageMin": 45,
        "ageMax": 62,
        "maxDistanceKm": 45,
        "notifications": true,
        "theme": "light",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {
          "theatre": 0.63,
          "wine": 0.29,
          "poetry": 0.21,
          "gaming": -0.31,
          "lifting": -0.15
        },
        "likeCount": 26,
        "passCount": 22
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "kofi-mensah",
      "email": "kofi@example.com",
      "displayName": "Kofi M.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-03-21T21:09:00.000Z",
      "updatedAt": "2026-07-26T23:14:00.000Z",
      "lastActiveOffsetHours": 63,
      "profile": {
        "birthdate": "1987-04-05",
        "age": 39,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "Jazz drummer six nights a month, logistics manager the rest of the time. I am in bed by ten on weeknights and I have stopped apologising for it.",
        "photos": [],
        "interests": [
          "jazz",
          "live-music",
          "vinyl",
          "cooking",
          "swimming"
        ],
        "personality": {
          "openness": 71,
          "conscientiousness": 74,
          "extraversion": 57,
          "agreeableness": 62,
          "stability": 73
        },
        "location": {
          "label": "Brooklyn, NY",
          "lat": 40.6892,
          "lng": -73.98
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman"
        ],
        "ageMin": 30,
        "ageMax": 45,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "wren-alsop",
      "email": "wren@example.com",
      "displayName": "Wren A.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-06-14T03:56:00.000Z",
      "updatedAt": "2026-08-02T18:37:00.000Z",
      "lastActiveOffsetHours": 4.5,
      "profile": {
        "birthdate": "2003-06-21",
        "age": 23,
        "gender": "nonbinary",
        "pronouns": "they/them",
        "bio": "Second-year vet tech, permanently covered in someone else's fur. I know where the good swimming holes are and I am stingy about which ones I will tell you.",
        "photos": [],
        "interests": [
          "swimming",
          "camping",
          "kayaking",
          "backpacking",
          "board-games",
          "gaming"
        ],
        "personality": {
          "openness": 67,
          "conscientiousness": 59,
          "extraversion": 64,
          "agreeableness": 88,
          "stability": 54
        },
        "location": {
          "label": "Austin, TX",
          "lat": 30.25,
          "lng": -97.75
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary"
        ],
        "ageMin": 21,
        "ageMax": 30,
        "maxDistanceKm": 90,
        "notifications": true,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "diego-salcedo",
      "email": "diego@example.com",
      "displayName": "Diego S.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-04-17T12:24:00.000Z",
      "updatedAt": "2026-07-30T22:51:00.000Z",
      "lastActiveOffsetHours": 11,
      "profile": {
        "birthdate": "1994-09-16",
        "age": 31,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "I make hot sauce in small batches and give most of it away, which my accountant calls a hobby. Line dancing on Tuesdays, and that part is not negotiable.",
        "photos": [],
        "interests": [
          "cooking",
          "street-food",
          "dancing",
          "gardening",
          "guitar"
        ],
        "personality": {
          "openness": 76,
          "conscientiousness": 63,
          "extraversion": 83,
          "agreeableness": 79,
          "stability": 69
        },
        "location": {
          "label": "Austin, TX",
          "lat": 30.2711,
          "lng": -97.7437
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary"
        ],
        "ageMin": 25,
        "ageMax": 38,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "hana-bergstrom",
      "email": "hana@example.com",
      "displayName": "Hana B.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2025-12-28T08:41:00.000Z",
      "updatedAt": "2026-07-21T11:05:00.000Z",
      "lastActiveOffsetHours": 144,
      "profile": {
        "birthdate": "1996-11-29",
        "age": 29,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "Swedish mother, Minnesota winters — I was built for this climate and I complain about it anyway. I will drag you to the lake at six in the morning and you will thank me.",
        "photos": [],
        "interests": [
          "swimming",
          "running",
          "camping",
          "baking",
          "knitting",
          "journaling"
        ],
        "personality": {
          "openness": 59,
          "conscientiousness": 81,
          "extraversion": 69,
          "agreeableness": 73,
          "stability": 78
        },
        "location": {
          "label": "Minneapolis, MN",
          "lat": 44.9778,
          "lng": -93.265
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "man",
          "nonbinary"
        ],
        "ageMin": 26,
        "ageMax": 38,
        "maxDistanceKm": 150,
        "notifications": true,
        "theme": "light",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "terrence-wu",
      "email": "terrence@example.com",
      "displayName": "Terrence W.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-02-02T17:58:00.000Z",
      "updatedAt": "2026-07-18T09:33:00.000Z",
      "lastActiveOffsetHours": 200,
      "profile": {
        "birthdate": "1983-02-08",
        "age": 43,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "Divorced, two teenagers, one extremely old cat, and finally enough evenings free to play bass again. Not looking to rush anything, but I am looking.",
        "photos": [],
        "interests": [
          "guitar",
          "jazz",
          "board-games",
          "gardening",
          "puzzles"
        ],
        "personality": {
          "openness": 52,
          "conscientiousness": 72,
          "extraversion": 41,
          "agreeableness": 80,
          "stability": 66
        },
        "location": {
          "label": "Minneapolis, MN",
          "lat": 44.9537,
          "lng": -93.29
        },
        "showAge": false,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman"
        ],
        "ageMin": 34,
        "ageMax": 50,
        "maxDistanceKm": 100,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "lucia-moreno",
      "email": "lucia@example.com",
      "displayName": "Lucia M.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-05-29T14:12:00.000Z",
      "updatedAt": "2026-07-31T13:46:00.000Z",
      "lastActiveOffsetHours": 57,
      "profile": {
        "birthdate": "1975-05-30",
        "age": 51,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "Ran a bakery for eighteen years, sold it last spring, and I am now learning what a weekend is. Currently obsessed with birds, which surprised nobody more than me.",
        "photos": [],
        "interests": [
          "baking",
          "birding",
          "gardening",
          "wine",
          "reading",
          "volunteering"
        ],
        "personality": {
          "openness": 70,
          "conscientiousness": 86,
          "extraversion": 66,
          "agreeableness": 84,
          "stability": 81
        },
        "location": {
          "label": "Atlanta, GA",
          "lat": 33.749,
          "lng": -84.388
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "man",
          "woman"
        ],
        "ageMin": 42,
        "ageMax": 60,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "light",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "isaiah-brooks",
      "email": "isaiah@example.com",
      "displayName": "Isaiah B.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-06-08T19:27:00.000Z",
      "updatedAt": "2026-08-03T20:02:00.000Z",
      "lastActiveOffsetHours": 2,
      "profile": {
        "birthdate": "2000-07-04",
        "age": 26,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "Barber. Yes I will cut your hair, no not on a first date. Trivia every Wednesday with the same four people, and we have never once come close to winning.",
        "photos": [],
        "interests": [
          "trivia",
          "gaming",
          "lifting",
          "street-food",
          "karaoke"
        ],
        "personality": {
          "openness": 64,
          "conscientiousness": 57,
          "extraversion": 88,
          "agreeableness": 75,
          "stability": 70
        },
        "location": {
          "label": "Atlanta, GA",
          "lat": 33.7701,
          "lng": -84.362
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman"
        ],
        "ageMin": 22,
        "ageMax": 32,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "fatima-bennani",
      "email": "fatima@example.com",
      "displayName": "Fatima Z.",
      "profileComplete": true,
      "plan": "premium",
      "planSince": "2026-06-09T14:30:00.000Z",
      "createdAt": "2025-10-07T06:34:00.000Z",
      "updatedAt": "2026-08-04T15:19:00.000Z",
      "lastActiveOffsetHours": 17,
      "profile": {
        "birthdate": "1992-12-18",
        "age": 33,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "Ski patrol in winter, wildflower guide in summer, insufferable for the six weeks in between. I want someone who packs their own snacks.",
        "photos": [],
        "interests": [
          "hiking",
          "climbing",
          "camping",
          "photography",
          "tea",
          "birding"
        ],
        "personality": {
          "openness": 83,
          "conscientiousness": 78,
          "extraversion": 59,
          "agreeableness": 61,
          "stability": 75
        },
        "location": {
          "label": "Denver, CO",
          "lat": 39.7508,
          "lng": -105.0011
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "man",
          "woman",
          "nonbinary"
        ],
        "ageMin": 28,
        "ageMax": 44,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {
          "hiking": 0.58,
          "climbing": 0.44,
          "photography": 0.16,
          "gaming": -0.27
        },
        "likeCount": 21,
        "passCount": 17
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "oliver-nakamura",
      "email": "oliver@example.com",
      "displayName": "Oliver N.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-01-26T23:45:00.000Z",
      "updatedAt": "2026-07-23T07:58:00.000Z",
      "lastActiveOffsetHours": 88,
      "profile": {
        "birthdate": "1989-03-03",
        "age": 37,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "Game designer. I have playtested my own board game four hundred times and my friends have quietly stopped answering the group chat. Please help.",
        "photos": [],
        "interests": [
          "board-games",
          "gaming",
          "coding",
          "coffee",
          "puzzles",
          "film"
        ],
        "personality": {
          "openness": 79,
          "conscientiousness": 69,
          "extraversion": 39,
          "agreeableness": 70,
          "stability": 57
        },
        "location": {
          "label": "Seattle, WA",
          "lat": 47.5952,
          "lng": -122.3316
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary"
        ],
        "ageMin": 30,
        "ageMax": 44,
        "maxDistanceKm": 300,
        "notifications": true,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "tess-kowalczyk",
      "email": "tess@example.com",
      "displayName": "Tess K.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-07-02T10:16:00.000Z",
      "updatedAt": "2026-08-05T11:24:00.000Z",
      "lastActiveOffsetHours": 7,
      "profile": {
        "birthdate": "2005-03-20",
        "age": 21,
        "gender": "woman",
        "pronouns": "she/they",
        "bio": "Last year of art school and I am told the panic is standard. I photograph strangers' laundry lines — three albums so far, and nobody has asked me to stop.",
        "photos": [],
        "interests": [
          "photography",
          "painting",
          "film",
          "city-breaks",
          "karaoke"
        ],
        "personality": {
          "openness": 93,
          "conscientiousness": 43,
          "extraversion": 72,
          "agreeableness": 69,
          "stability": 45
        },
        "location": {
          "label": "Chicago, IL",
          "lat": 41.9075,
          "lng": -87.677
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "man",
          "nonbinary",
          "other"
        ],
        "ageMin": 21,
        "ageMax": 30,
        "maxDistanceKm": 30,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "adaeze-nwosu",
      "email": "adaeze@example.com",
      "displayName": "Adaeze N.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2025-09-29T16:03:00.000Z",
      "updatedAt": "2026-07-20T21:47:00.000Z",
      "lastActiveOffsetHours": 108,
      "profile": {
        "birthdate": "1986-10-09",
        "age": 39,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "Immigration attorney: mostly waiting, then twelve minutes of shouting. On Sundays I do not speak to anyone until I have had two coffees and a long swim.",
        "photos": [],
        "interests": [
          "swimming",
          "coffee",
          "volunteering",
          "reading",
          "yoga",
          "meditation",
          "jazz"
        ],
        "personality": {
          "openness": 75,
          "conscientiousness": 87,
          "extraversion": 33,
          "agreeableness": 66,
          "stability": 64
        },
        "location": {
          "label": "Oakland, CA",
          "lat": 37.8272,
          "lng": -122.2568
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary"
        ],
        "ageMin": 30,
        "ageMax": 48,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "light",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "bram-de-vries",
      "email": "bram@example.com",
      "displayName": "Bram D.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-03-15T09:38:00.000Z",
      "updatedAt": "2026-07-17T14:12:00.000Z",
      "lastActiveOffsetHours": 240,
      "profile": {
        "birthdate": "1971-08-24",
        "age": 54,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "Furniture maker. I have built the same chair thirty times and it is finally close to right. I would like company on the long drive out to the coast.",
        "photos": [],
        "interests": [
          "tinkering",
          "road-trips",
          "kayaking",
          "jazz",
          "reading"
        ],
        "personality": {
          "openness": 56,
          "conscientiousness": 90,
          "extraversion": 26,
          "agreeableness": 72,
          "stability": 83
        },
        "location": {
          "label": "Portland, OR",
          "lat": 45.4805,
          "lng": -122.6207
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman"
        ],
        "ageMin": 45,
        "ageMax": 58,
        "maxDistanceKm": 250,
        "notifications": false,
        "theme": "light",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "yuki-sorensen",
      "email": "yuki@example.com",
      "displayName": "Yuki S.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-04-25T20:51:00.000Z",
      "updatedAt": "2026-08-01T09:29:00.000Z",
      "lastActiveOffsetHours": 24,
      "profile": {
        "birthdate": "1995-04-02",
        "age": 31,
        "gender": "other",
        "pronouns": "they/them",
        "bio": "I keep bees on a rooftop and a spreadsheet about the bees that nobody has asked to see. I will bring you honey, and then I will talk about honey.",
        "photos": [],
        "interests": [
          "gardening",
          "tea",
          "journaling",
          "cycling",
          "baking",
          "birding"
        ],
        "personality": {
          "openness": 81,
          "conscientiousness": 75,
          "extraversion": 47,
          "agreeableness": 86,
          "stability": 70
        },
        "location": {
          "label": "Vancouver, WA",
          "lat": 45.628,
          "lng": -122.6742
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary",
          "man"
        ],
        "ageMin": 27,
        "ageMax": 40,
        "maxDistanceKm": 150,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "camille-rousseau",
      "email": "camille@example.com",
      "displayName": "Camille R.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2025-11-05T12:07:00.000Z",
      "updatedAt": "2026-06-30T18:44:00.000Z",
      "lastActiveOffsetHours": 288,
      "profile": {
        "birthdate": "1981-06-13",
        "age": 45,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "Sommelier turned importer, which in practice means airports. I am blunt, I laugh too loudly, and I have never in my life been on time.",
        "photos": [],
        "interests": [
          "wine",
          "city-breaks",
          "train-travel",
          "cooking",
          "dancing",
          "languages"
        ],
        "personality": {
          "openness": 86,
          "conscientiousness": 52,
          "extraversion": 90,
          "agreeableness": 58,
          "stability": 62
        },
        "location": {
          "label": "San Francisco, CA",
          "lat": 37.7955,
          "lng": -122.3937
        },
        "showAge": true,
        "showDistance": false
      },
      "preferences": {
        "interestedIn": [
          "man"
        ],
        "ageMin": 38,
        "ageMax": 55,
        "maxDistanceKm": 500,
        "notifications": false,
        "theme": "system",
        "discoverable": false
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": [
        "elliot-vance"
      ]
    },
    {
      "uid": "noor-rahimi",
      "email": "noor@example.com",
      "displayName": "Noor R.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-05-13T15:22:00.000Z",
      "updatedAt": "2026-07-29T22:16:00.000Z",
      "lastActiveOffsetHours": 30,
      "profile": {
        "birthdate": "1993-09-27",
        "age": 32,
        "gender": "woman",
        "pronouns": "she/her",
        "bio": "I make data visualisations for a climate nonprofit: forty charts about heatwaves, and one, privately, about how often my cat walks across my keyboard.",
        "photos": [],
        "interests": [
          "coding",
          "baking",
          "cycling",
          "journaling",
          "philosophy",
          "volunteering"
        ],
        "personality": {
          "openness": 73,
          "conscientiousness": 83,
          "extraversion": 53,
          "agreeableness": 77,
          "stability": 68
        },
        "location": {
          "label": "Austin, TX",
          "lat": 30.2849,
          "lng": -97.7341
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary"
        ],
        "ageMin": 27,
        "ageMax": 40,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "gil-abernathy",
      "email": "gil@example.com",
      "displayName": "Gil A.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-02-19T04:49:00.000Z",
      "updatedAt": "2026-07-15T16:53:00.000Z",
      "lastActiveOffsetHours": 320,
      "profile": {
        "birthdate": "1990-05-21",
        "age": 36,
        "gender": "man",
        "pronouns": "he/him",
        "bio": "Rock guide six months a year, gloriously unemployed the other six. I read paperbacks until they fall apart and then I tape them back together.",
        "photos": [],
        "interests": [
          "climbing",
          "camping",
          "reading",
          "hiking",
          "guitar"
        ],
        "personality": {
          "openness": 68,
          "conscientiousness": 49,
          "extraversion": 36,
          "agreeableness": 63,
          "stability": 59
        },
        "location": {
          "label": "Denver, CO",
          "lat": 39.7256,
          "lng": -104.977
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman"
        ],
        "ageMin": 30,
        "ageMax": 44,
        "maxDistanceKm": 40,
        "notifications": true,
        "theme": "system",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    },
    {
      "uid": "solveig-ramirez",
      "email": "solveig@example.com",
      "displayName": "Solveig R.",
      "profileComplete": true,
      "plan": "free",
      "planSince": null,
      "createdAt": "2026-06-21T18:14:00.000Z",
      "updatedAt": "2026-08-04T21:08:00.000Z",
      "lastActiveOffsetHours": 45,
      "profile": {
        "birthdate": "1999-02-05",
        "age": 27,
        "gender": "woman",
        "pronouns": "she/they",
        "bio": "Court stenographer, so I have typed out the worst day of a lot of people's lives. I decompress by making noise music nobody wants to hear. Come anyway.",
        "photos": [],
        "interests": [
          "electronic",
          "live-music",
          "film",
          "philosophy",
          "coffee",
          "knitting"
        ],
        "personality": {
          "openness": 90,
          "conscientiousness": 64,
          "extraversion": 44,
          "agreeableness": 67,
          "stability": 51
        },
        "location": {
          "label": "Brooklyn, NY",
          "lat": 40.7053,
          "lng": -73.9345
        },
        "showAge": true,
        "showDistance": true
      },
      "preferences": {
        "interestedIn": [
          "woman",
          "nonbinary",
          "man"
        ],
        "ageMin": 24,
        "ageMax": 36,
        "maxDistanceKm": 500,
        "notifications": true,
        "theme": "dark",
        "discoverable": true
      },
      "learning": {
        "interestAffinity": {},
        "likeCount": 0,
        "passCount": 0
      },
      "usage": {
        "date": null,
        "likes": 0,
        "superLikes": 0,
        "rewinds": 0
      },
      "blocked": []
    }
  ];

  // People who already swiped right on demo-you. Seeding these is what makes
  // the premium "Who liked you" list real and puts a match one swipe away.
  const SEED_INBOUND_LIKES = [
    { "from": "fatima-bennani", "action": "super", "offsetHours": 3 },
    { "from": "maya-okonkwo", "action": "like", "offsetHours": 8 },
    { "from": "priya-raghunathan", "action": "super", "offsetHours": 19 },
    { "from": "theo-lindqvist", "action": "like", "offsetHours": 26 },
    { "from": "rin-matsuda", "action": "like", "offsetHours": 41 },
    { "from": "yuki-sorensen", "action": "like", "offsetHours": 58 },
    { "from": "solveig-ramirez", "action": "like", "offsetHours": 77 },
    { "from": "noor-rahimi", "action": "like", "offsetHours": 104 },
    { "from": "bea-ferreira", "action": "like", "offsetHours": 133 }
  ];

  // Matches demo-you already has: one with history, one still empty so the
  // "no messages yet" state and its icebreakers are reachable on first run.
  const SEED_CONVERSATIONS = [
    {
      "with": "devin-alvarez",
      "matchedOffsetHours": 52,
      "messages": [
        {
          "from": "demo-you",
          "text": "I have to know how Brenda got her name. Four years is longer than any of my houseplants have managed.",
          "offsetHours": 51.5
        },
        {
          "from": "devin-alvarez",
          "text": "After my grandmother, who also expected to be fed every twelve hours and would have found this whole thing ridiculous. The starter came out of a bakery in Astoria that closed in 2021.",
          "offsetHours": 50.25
        },
        {
          "from": "demo-you",
          "text": "Better origin story than I was braced for. Does she travel? I keep promising people I will cook for them and I would like to hedge with bread.",
          "offsetHours": 48
        },
        {
          "from": "devin-alvarez",
          "text": "She travels badly but she travels. Bring a jar and I will send you home with a piece of her and the feeding schedule my ex called concerning.",
          "offsetHours": 47
        },
        {
          "from": "demo-you",
          "text": "Deal. I will trade you a pour-over that takes four minutes and an unreasonable amount of explaining.",
          "offsetHours": 29.5
        },
        {
          "from": "devin-alvarez",
          "text": "Sold. Saturday morning, before the market on Hawthorne gets loud? I am there most weeks anyway.",
          "offsetHours": 27
        }
      ]
    },
    {
      "with": "sam-whitfield",
      "matchedOffsetHours": 6,
      "messages": []
    }
  ];

  return {
    SEED_VERSION: 1,
    INTEREST_TAGS: INTEREST_TAGS,
    INTEREST_BY_SLUG: INTEREST_BY_SLUG,
    SEED_PROFILES: SEED_PROFILES,
    SEED_INBOUND_LIKES: SEED_INBOUND_LIKES,
    SEED_CONVERSATIONS: SEED_CONVERSATIONS
  };
});
